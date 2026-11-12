// xAI end-to-end (workerd) for the Codex `apply_patch` custom tool: the request declares it as the strict
// `{"input": ...}` function, the function-call answer is bridged back to `custom_tool_call` events/items, and the
// folded namespace dispatcher (>200 tools) is expanded before the bridge sees it.
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { Config } from "../src/config/schema.ts";
import {
  loadConfig,
  makePipeline,
  postJson,
  sseResponse,
  type UpstreamResponder,
} from "./support/pipeline.ts";
import { xaiModels, xaiOauth, xaiPicker, type XaiPickerLog } from "./support/xai.ts";
import type { Json, JsonObject } from "@commissary/json";

const created = {
  type: "response.created",
  response: { id: "resp_1", object: "response", model: "grok-4.3", status: "in_progress" },
};

const completed = (output: Json[]) => ({
  type: "response.completed",
  response: {
    id: "resp_1",
    status: "completed",
    model: "grok-4.3",
    output,
    usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
  },
});

const frame = (event: Json): string =>
  `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`;

const PATCH = "*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch";

const ARGS = JSON.stringify({ input: PATCH });

const call = (name: string, args: string, extra: JsonObject = {}) => ({
  id: "fc_1",
  type: "function_call",
  call_id: "call_1",
  name,
  arguments: args,
  status: "completed",
  ...extra,
});

/** Loosely typed JSON object of an event/item/tool in the assertions below. */
interface Item {
  [key: string]: unknown;
  parameters?: { required?: string[] };
}

let config: Config;

beforeAll(async () => {
  config = await loadConfig("requests: {}");
});

const pipeline = (respond: UpstreamResponder) => {
  const log: XaiPickerLog = { picks: [], reports: [] };

  const p = makePipeline({
    config,
    respond,
    credentialPicker: xaiPicker([xaiOauth()], log),
    modelProviders: xaiModels,
  });

  afterAll(p.dispose);

  return p;
};

const payloads = (text: string): Array<Item> =>
  text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as Item);

const stream = (...events: Json[]) => sseResponse([frame(created), ...events.map(frame)]);

describe("xAI apply_patch bridge", () => {
  it("declares the custom tool as a strict function and restores custom_tool_call items (non-stream)", async () => {
    const item = call("apply_patch", ARGS);

    const p = pipeline(() =>
      stream({ type: "response.output_item.done", output_index: 0, item }, completed([item])),
    );

    const response = await p.call(
      "/v1/responses",
      postJson({
        model: "grok-4.3",
        input: [
          { type: "message", role: "user", content: "patch" },
          { type: "custom_tool_call", call_id: "c0", name: "apply_patch", input: PATCH },
          { type: "custom_tool_call_output", call_id: "c0", output: "done" },
        ],
        tools: [
          {
            type: "custom",
            name: "apply_patch",
            description: "Patch files",
            format: { type: "grammar" },
          },
        ],
      }),
    );

    expect(response.status).toBe(200);

    const upstream = JSON.parse(p.calls[0]!.body) as {
      tools: Array<Item>;
      input: Array<Item>;
    };

    expect(upstream.tools[0]).toMatchObject({ type: "function", name: "apply_patch" });
    expect(upstream.tools[0]?.parameters?.required).toEqual(["input"]);
    expect(upstream.tools[0]?.format).toBeUndefined();
    expect(upstream.input[1]).toMatchObject({
      type: "function_call",
      name: "apply_patch",
      arguments: ARGS,
    });
    expect(upstream.input[2]).toMatchObject({ type: "function_call_output", call_id: "c0" });
    const body = (await response.json()) as { output: Array<Item> };
    expect(body.output[0]).toMatchObject({
      type: "custom_tool_call",
      name: "apply_patch",
      call_id: "call_1",
      input: PATCH,
    });
    expect(body.output[0]?.arguments).toBeUndefined();
  });

  it("streams custom_tool_call_input deltas and rewrites the item events", async () => {
    const added = { ...call("apply_patch", ""), status: "in_progress" };
    const done = call("apply_patch", ARGS);

    const p = pipeline(() =>
      stream(
        { type: "response.output_item.added", output_index: 0, item: added },
        {
          type: "response.function_call_arguments.delta",
          item_id: "fc_1",
          output_index: 0,
          delta: ARGS.slice(0, 20),
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: "fc_1",
          output_index: 0,
          delta: ARGS.slice(20),
        },
        {
          type: "response.function_call_arguments.done",
          item_id: "fc_1",
          output_index: 0,
          arguments: ARGS,
        },
        { type: "response.output_item.done", output_index: 0, item: done },
        completed([done]),
      ),
    );

    const response = await p.call(
      "/v1/responses",
      postJson({
        model: "grok-4.3",
        input: "go",
        stream: true,
        tools: [{ type: "custom", name: "apply_patch" }],
      }),
    );

    const events = payloads(await response.text());
    const types = events.map((event) => event["type"]);
    expect(types).toContain("response.custom_tool_call_input.delta");
    expect(types).toContain("response.custom_tool_call_input.done");
    expect(types).not.toContain("response.function_call_arguments.delta");

    const deltas = events.filter(
      (event) => event["type"] === "response.custom_tool_call_input.delta",
    );

    expect(deltas.map((event) => event["delta"]).join("")).toBe(PATCH);

    const sequences = events
      .map((event) => event["sequence_number"])
      .filter((n) => typeof n === "number");

    expect(sequences).toEqual([...sequences].toSorted((a, b) => a - b));
    const last = events.at(-1) as { type: string; response: { output: Array<Item> } };
    expect(last.type).toBe("response.completed");
    expect(last.response.output[0]).toMatchObject({ type: "custom_tool_call", input: PATCH });
  });

  it("fails the stream with a sanitised error when the arguments are not a patch input", async () => {
    const bad = call("apply_patch", '{"patch":"secret text"}');

    const p = pipeline(() =>
      stream(
        { type: "response.output_item.added", output_index: 0, item: { ...bad, arguments: "" } },
        {
          type: "response.function_call_arguments.delta",
          item_id: "fc_1",
          output_index: 0,
          delta: bad.arguments,
        },
        { type: "response.output_item.done", output_index: 0, item: bad },
        completed([bad]),
      ),
    );

    const response = await p.call(
      "/v1/responses",
      postJson({
        model: "grok-4.3",
        input: "go",
        stream: true,
        tools: [{ type: "custom", name: "apply_patch" }],
      }),
    );

    const text = await response.text();
    expect(text).toContain("invalid_tool_arguments");
    expect(text).not.toContain("secret text");
    expect(text).not.toContain('"type":"response.completed"');
  });

  it("answers 502 without leaking arguments for a malformed non-stream call", async () => {
    const bad = call("apply_patch", '{"nope":"secret text"}');

    const p = pipeline(() =>
      stream({ type: "response.output_item.done", output_index: 0, item: bad }, completed([bad])),
    );

    const response = await p.call(
      "/v1/responses",
      postJson({
        model: "grok-4.3",
        input: "go",
        tools: [{ type: "custom", name: "apply_patch" }],
      }),
    );

    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("secret text");
  });

  it("leaves ordinary function calls untouched when no apply_patch tool is declared", async () => {
    const item = call("lookup", '{"q":1}');

    const p = pipeline(() =>
      stream({ type: "response.output_item.done", output_index: 0, item }, completed([item])),
    );

    const response = await p.call(
      "/v1/responses",
      postJson({
        model: "grok-4.3",
        input: "go",
        tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
      }),
    );

    const body = (await response.json()) as { output: Array<Item> };
    expect(body.output[0]).toMatchObject({
      type: "function_call",
      name: "lookup",
      arguments: '{"q":1}',
    });
  });

  it("expands a folded dispatcher whose child is apply_patch", async () => {
    const children = Array.from({ length: 205 }, (_, index) => ({
      type: "function",
      name: `t${index}`,
      parameters: { type: "object" },
    }));

    const wrapper = JSON.stringify({ name: "apply_patch", arguments: { input: PATCH } });
    const added = { ...call("big", ""), status: "in_progress" };
    const done = call("big", wrapper);

    const p = pipeline(() =>
      stream(
        { type: "response.output_item.added", output_index: 0, item: added },
        {
          type: "response.function_call_arguments.done",
          item_id: "fc_1",
          output_index: 0,
          arguments: wrapper,
        },
        { type: "response.output_item.done", output_index: 0, item: done },
        completed([done]),
      ),
    );

    const response = await p.call(
      "/v1/responses",
      postJson({
        model: "grok-4.3",
        input: "go",
        stream: true,
        tools: [
          {
            type: "namespace",
            name: "big",
            tools: [{ type: "custom", name: "apply_patch" }, ...children],
          },
        ],
      }),
    );

    const upstream = JSON.parse(p.calls[0]!.body) as { tools: Array<Item> };
    expect(upstream.tools).toHaveLength(1);
    expect(upstream.tools[0]?.name).toBe("big");
    const events = payloads(await response.text());
    const item = events.find((event) => event["type"] === "response.output_item.done")?.["item"];
    expect(item).toMatchObject({
      type: "custom_tool_call",
      name: "apply_patch",
      namespace: "big",
      input: PATCH,
    });
    const input = events.find((event) => event["type"] === "response.custom_tool_call_input.done");
    expect(input?.["input"]).toBe(PATCH);
  });
});
