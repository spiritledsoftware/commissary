// C9 PR B (Go 772df04b, 674dbe8f, a68c7d8e): reasoning signatures through the Interactions protocol. A Codex reasoning
// `encrypted_content` is emitted verbatim as the thought step's `signature` (a `thought_signature` delta when streaming)
// and a client-echoed signature is restored only when its family matches the target. Expected values come from
// interactions_codex_test.go.
import { asString, get, isJsonArray, type Json, tryParseJson } from "@commissary/json";
import { describe, expect, it } from "vitest";
import { makeTranslationState, type ResponseContext } from "../src/translator/registry.ts";
import {
  fernetReasoningSignature,
  metaSignature,
  routerSuffixed,
} from "./support/reasoning-signatures.ts";
import { convertInteractionsRequestToCodex } from "../src/translator/codex/interactions/request.ts";
import {
  convertCodexResponseToInteractions,
  convertCodexResponseToInteractionsNonStream,
} from "../src/translator/codex/interactions/response.ts";

const META = metaSignature(1024);

const ROUTED_META = routerSuffixed(META);

const GPT = fernetReasoningSignature();

const context = (model: string): ResponseContext => ({
  model,
  originalRequest: undefined,
  translatedRequest: undefined,
  state: makeTranslationState(),
});

/** The JSON payloads of the SSE frames, in order. */
const payloads = (frames: ReadonlyArray<string>): Json[] =>
  frames.flatMap((frame) =>
    frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => tryParseJson(line.slice(5).trim()))
      .filter((payload): payload is Json => payload !== undefined),
  );

const eventName = (payload: Json): string => asString(get(payload, "event_type"));

const run = (ctx: ResponseContext, events: ReadonlyArray<Json>): string[] =>
  events.flatMap((event) => [
    ...convertCodexResponseToInteractions(ctx, `data: ${JSON.stringify(event)}`),
  ]);

const deltasOf = (frames: ReadonlyArray<string>, deltaType: string): Json[] =>
  payloads(frames).filter(
    (payload) => eventName(payload) === "step.delta" && get(payload, "delta.type") === deltaType,
  );

const reasoningDone = (item: Json): Json => ({ type: "response.output_item.done", item });

describe("Codex response -> Interactions: reasoning signatures (Go 772df04b)", () => {
  it("emits the signature verbatim as the thought step's signature, with the text as content", () => {
    const out = tryParseJson(
      convertCodexResponseToInteractionsNonStream(
        context("codex-test"),
        JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_1",
            output: [
              {
                type: "reasoning",
                summary: [{ type: "summary_text", text: "thinking hard" }],
                encrypted_content: META,
              },
              { type: "reasoning", summary: [], encrypted_content: ROUTED_META },
              { type: "reasoning", summary: [] },
            ],
          },
        }),
      ) ?? "",
    );

    const steps = get(out, "steps");

    // An empty reasoning item emits no step.
    expect(isJsonArray(steps) ? steps.length : 0).toBe(2);
    expect(get(out, "steps.0")).toEqual({
      type: "thought",
      signature: META,
      content: [{ type: "text", text: "thinking hard" }],
    });
    expect(get(out, "steps.1")).toEqual({ type: "thought", signature: ROUTED_META });
  });

  it("streams one thought_signature delta and one summary, suppressing a duplicated done event", () => {
    const ctx = context("codex-test");

    const done = {
      id: "rs_1",
      type: "reasoning",
      summary: [{ type: "summary_text", text: "streamed thinking" }],
      encrypted_content: META,
    };

    const frames = run(ctx, [
      { type: "response.created", response: { id: "resp_1", model: "codex-test" } },
      { type: "response.reasoning_summary_text.delta", delta: "streamed thinking" },
      reasoningDone(done),
      // A duplicated done event for the same item must not re-emit the signature or the summary.
      reasoningDone(done),
      reasoningDone({ type: "message", content: [{ type: "output_text", text: "answer" }] }),
    ]);

    const starts = payloads(frames).filter((payload) => eventName(payload) === "step.start");

    expect(starts.map((start) => get(start, "step.type"))).toEqual(["thought", "model_output"]);
    expect(deltasOf(frames, "thought_signature").map((d) => get(d, "delta.signature"))).toEqual([
      META,
    ]);
    expect(deltasOf(frames, "thought_summary")).toHaveLength(1);
    expect(payloads(frames).map(eventName)).toEqual([
      "interaction.created",
      "interaction.status_update",
      "step.start",
      "step.delta",
      "step.delta",
      "step.stop",
      "step.start",
      "step.delta",
      "step.stop",
    ]);
  });

  it("emits the summary of a done-only reasoning item after a streamed one", () => {
    const frames = run(context("codex-test"), [
      { type: "response.created", response: { id: "resp_2", model: "codex-test" } },
      { type: "response.reasoning_summary_text.delta", delta: "first summary" },
      reasoningDone({
        id: "rs_a",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "first summary" }],
        encrypted_content: META,
      }),
      reasoningDone({
        id: "rs_b",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "second summary only in done" }],
      }),
    ]);

    expect(deltasOf(frames, "thought_summary").map((d) => get(d, "delta.content.text"))).toEqual([
      "first summary",
      "second summary only in done",
    ]);
  });
});

const request = (model: string, steps: Json[]): Json => ({ model, input: steps });

const inputItems = (out: Json): Json[] => {
  const input = get(out, "input");

  return isJsonArray(input) ? input : [];
};

describe("Interactions request -> Codex: restoring a thought signature (Go 772df04b, 674dbe8f, a68c7d8e)", () => {
  it.each([
    ["native meta", "muse-spark-1.3", META],
    ["namespaced router model", "meta/muse-wonder", META],
    ["routed meta verbatim", "meta/muse-wonder", ROUTED_META],
  ])("restores %s", (_name, model, signature) => {
    const out = convertInteractionsRequestToCodex(
      model,
      request(model, [
        { type: "thought", signature, content: [{ type: "text", text: "thinking" }] },
      ]),
      false,
    );

    // The summary carries the text; a replay item never carries content.
    expect(get(out, "input.0")).toEqual({
      type: "reasoning",
      encrypted_content: signature,
      summary: [{ type: "summary_text", text: "thinking" }],
    });
  });

  it("drops a thought step whose signature is foreign to the target instead of sending it unsigned", () => {
    const out = convertInteractionsRequestToCodex(
      "gpt-5.4",
      request("gpt-5.4", [
        {
          type: "thought",
          signature: META,
          content: [{ type: "text", text: "thinking" }],
          id: "step_1",
        },
      ]),
      false,
    );

    expect(inputItems(out)).toEqual([]);
  });

  it("drops empty thought steps and keeps the items around a dropped one in order", () => {
    const hi = { type: "user_input", content: [{ type: "text", text: "hi" }] };

    // A rejected signature with no text emits nothing: a bare reasoning item carries nothing replayable.
    expect(
      inputItems(
        convertInteractionsRequestToCodex(
          "gpt-5.4",
          request("", [hi, { type: "thought", signature: META }]),
          false,
        ),
      ),
    ).toHaveLength(1);

    // A signatureless, textless thought step emits no item.
    expect(
      inputItems(
        convertInteractionsRequestToCodex(
          "muse-spark-1.3",
          { input: [{ type: "thought" }] },
          false,
        ),
      ),
    ).toEqual([]);

    // A duplicate accepted signature emits nothing the second time either.
    expect(
      inputItems(
        convertInteractionsRequestToCodex(
          "muse-spark-1.3",
          {
            input: [
              { type: "thought", signature: META },
              { type: "thought", signature: META },
            ],
          },
          false,
        ),
      ),
    ).toHaveLength(1);

    // A signatureless thought with text is dropped, and the message and tool items around it keep their order.
    const items = inputItems(
      convertInteractionsRequestToCodex(
        "muse-spark-1.3",
        {
          input: [
            hi,
            { type: "thought", content: [{ type: "text", text: "thinking" }] },
            { type: "function_call", name: "lookup", call_id: "call_1", arguments: { q: "x" } },
          ],
        },
        false,
      ),
    );

    expect(items.map((item) => get(item, "type"))).toEqual(["message", "function_call"]);
  });

  it("normalises a cache-prefixed signature, accepts thought_signature and replays a duplicate once", () => {
    expect(
      get(
        convertInteractionsRequestToCodex(
          "gpt-5.4",
          { input: [{ type: "thought", signature: `gpt#${GPT}` }] },
          false,
        ),
        "input.0.encrypted_content",
      ),
    ).toBe(GPT);

    expect(
      get(
        convertInteractionsRequestToCodex(
          "muse-spark-1.3",
          { input: [{ type: "thought", thought_signature: META }] },
          false,
        ),
        "input.0.encrypted_content",
      ),
    ).toBe(META);

    const duplicated = convertInteractionsRequestToCodex(
      "muse-spark-1.3",
      {
        input: [
          { type: "thought", signature: META, content: [{ type: "text", text: "one" }] },
          { type: "thought", signature: META, content: [{ type: "text", text: "two" }] },
        ],
      },
      false,
    );

    expect(inputItems(duplicated)).toHaveLength(1);
    expect(get(duplicated, "input.0.encrypted_content")).toBe(META);
  });

  it("takes the family of an unmapped deployment alias from the requested model", () => {
    const out = convertInteractionsRequestToCodex(
      "deployment-123",
      { model: "muse-spark-1.3", input: [{ type: "thought", signature: META }] },
      false,
    );

    expect(get(out, "input.0.encrypted_content")).toBe(META);
  });

  it("asks for encrypted reasoning and stores nothing", () => {
    expect(
      get(convertInteractionsRequestToCodex("codex-test", { input: "hi" }, false), "include"),
    ).toEqual(["reasoning.encrypted_content"]);
    expect(
      get(convertInteractionsRequestToCodex("codex-test", { input: "hi" }, false), "store"),
    ).toBe(false);

    expect(
      get(
        convertInteractionsRequestToCodex(
          "codex-test",
          { input: "hi", include: ["web_search_call.action.sources"] },
          false,
        ),
        "include",
      ),
    ).toEqual(["web_search_call.action.sources", "reasoning.encrypted_content"]);

    expect(
      get(
        convertInteractionsRequestToCodex(
          "codex-test",
          { input: "hi", include: ["reasoning.encrypted_content"] },
          false,
        ),
        "include",
      ),
    ).toEqual(["reasoning.encrypted_content"]);
  });
});
