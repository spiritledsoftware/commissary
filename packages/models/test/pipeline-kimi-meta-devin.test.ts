// End-to-end (workerd) through Access, model resolution, the credential picker, the executor registry and the
// conductor for the Kimi, Meta and Devin providers against mocked upstreams.
import { Effect, Layer } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import type { CredentialSnapshot } from "../src/executor/picker.ts";
import { sealCompaction, unsealCompaction } from "../src/executor/helps/compaction.ts";
import { asString, get, type Json, tryParseJson } from "@commissary/json";
import { ModelProviders } from "../src/handlers/model-providers.ts";
import { fixedPicker } from "./support/codex.ts";
import {
  jsonResponse,
  loadConfig,
  makePipeline,
  postJson,
  sseResponse,
} from "./support/pipeline.ts";

const providers = (provider: string): Layer.Layer<ModelProviders, never> =>
  Layer.succeed(
    ModelProviders,
    ModelProviders.of({
      providersFor: () => Effect.succeed([provider]),
      firstAvailableModel: Effect.succeed("m"),
    }),
  );

const kimi: CredentialSnapshot = {
  id: "kimi-1",
  provider: "kimi",
  kind: "oauth",
  label: "kimi",
  attributes: { base_url: "https://api.kimi.com/coding", domain: "kimi.com" },
  metadata: { access_token: "kimi-token", device_id: "dev-1" },
};

const meta: CredentialSnapshot = {
  id: "meta-1",
  provider: "meta",
  kind: "apikey",
  label: "meta",
  attributes: { api_key: "meta-key", base_url: "https://meta.test/v1" },
  metadata: {},
};

describe("Kimi via /v1/chat/completions", () => {
  it("routes an OpenAI chat request to the Kimi chat endpoint and returns the OpenAI answer", async () => {
    const config = await loadConfig("requests: {}");

    const p = makePipeline({
      config,
      credentialPicker: fixedPicker([kimi]),
      modelProviders: providers("kimi"),
      respond: () =>
        jsonResponse({
          id: "c1",
          object: "chat.completion",
          created: 1,
          model: "kimi-for-coding",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "hi there" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
    });

    afterAll(p.dispose);

    const response = await p.call(
      "/v1/chat/completions",
      postJson({
        model: "kimi-k2.8",
        temperature: 0.3,
        messages: [{ role: "user", content: "hello" }],
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message.content).toBe("hi there");
    const call = p.calls[0];
    expect(call?.url).toBe("https://api.kimi.com/coding/v1/chat/completions");
    expect(call?.headers["authorization"]).toBe("Bearer kimi-token");
    expect(JSON.parse(call?.body ?? "{}")).toMatchObject({ model: "kimi-for-coding" });
    expect(JSON.parse(call?.body ?? "{}")).not.toHaveProperty("temperature");
    expect(p.records[0]).toMatchObject({ provider: "kimi" });
  });
});

describe("Kimi via /v1/messages", () => {
  // Go kimi_executor.go reaches the same Claude sanitiser as the Claude provider (e9c8769a).
  it("normalises non-portable tool call ids on the embedded Claude path", async () => {
    const config = await loadConfig("requests: {}");

    const p = makePipeline({
      config,
      credentialPicker: fixedPicker([kimi]),
      modelProviders: providers("kimi"),
      respond: () =>
        jsonResponse({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "kimi-for-coding",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
    });

    afterAll(p.dispose);

    const response = await p.call(
      "/v1/messages",
      postJson({
        model: "kimi-k2.8",
        max_tokens: 16,
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "Bash:1#abc", name: "Bash", input: {} }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "Bash:1#abc", content: "done" }],
          },
        ],
      }),
    );

    expect(response.status).toBe(200);

    const sent = JSON.parse(p.calls[0]?.body ?? "{}") as {
      messages: Array<{ content: Array<{ id?: string; tool_use_id?: string }> }>;
    };

    expect(sent.messages[1]?.content[0]?.id).toBe("cpa_tid_v1_QmFzaDoxI2FiYw");
    expect(sent.messages[2]?.content[0]?.tool_use_id).toBe("cpa_tid_v1_QmFzaDoxI2FiYw");
  });
});

describe("Meta via /v1/responses", () => {
  it("streams the aggregated Responses answer for a non-stream client", async () => {
    const config = await loadConfig("requests: {}");

    const completed = {
      type: "response.completed",
      response: {
        id: "r1",
        object: "response",
        status: "completed",
        model: "muse-spark",
        output: [
          {
            id: "m1",
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "hey" }],
          },
        ],
        usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      },
    };

    const p = makePipeline({
      config,
      credentialPicker: fixedPicker([meta]),
      modelProviders: providers("meta"),
      respond: () => sseResponse([`data: ${JSON.stringify(completed)}\n\n`]),
    });

    afterAll(p.dispose);

    const response = await p.call(
      "/v1/responses",
      postJson({ model: "muse-spark", input: "hello" }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { output: Array<{ content: Array<{ text: string }> }> };
    expect(body.output[0]?.content[0]?.text).toBe("hey");
    expect(p.calls[0]?.url).toBe("https://meta.test/v1/responses");
    expect(p.calls[0]?.headers["x-client-id"]).toBe("tbh:exec");
    expect(p.records[0]).toMatchObject({ provider: "meta" });
  });

  it("passes a credential-scoped quota failure to the client as 429", async () => {
    const config = await loadConfig("requests: {}");

    const p = makePipeline({
      config,
      credentialPicker: fixedPicker([meta]),
      modelProviders: providers("meta"),
      respond: () =>
        new Response(JSON.stringify({ error: { message: "subscription quota exhausted" } }), {
          status: 429,
        }),
    });

    afterAll(p.dispose);

    const response = await p.call(
      "/v1/responses",
      postJson({ model: "muse-spark", input: "hello" }),
    );

    expect(response.status).toBe(429);
  });
});

/** The Responses answer of a summary turn, as each route's upstream sends it. */
const summaryResponse = (): Json => ({
  id: "resp_summary",
  object: "response",
  status: "completed",
  model: "m",
  output: [
    {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "the summary" }],
    },
  ],
  usage: { input_tokens: 9, output_tokens: 3, total_tokens: 12 },
});

const compactionRoutes = [
  {
    name: "Kimi",
    credential: kimi,
    provider: "kimi",
    model: "kimi-k2.8",
    url: "https://api.kimi.com/coding/v1/responses",
    respond: () => jsonResponse(summaryResponse()),
  },
  {
    name: "Meta",
    credential: meta,
    provider: "meta",
    model: "muse-spark",
    url: "https://meta.test/v1/responses",
    respond: () =>
      sseResponse([
        `data: ${JSON.stringify({ type: "response.completed", response: summaryResponse() })}\n\n`,
      ]),
  },
];

describe.each(compactionRoutes)("Responses compaction on $name", (route) => {
  const capsule = async () => ({
    type: "compaction",
    id: "cmp_ag_compact_1",
    encrypted_content: await sealCompaction("earlier work", route.model),
  });

  const foreign = { type: "compaction", id: "cmp_native", encrypted_content: "gAAAA-native" };
  const userMessage = { type: "message", role: "user", content: "continue" };

  const pipeline = async () => {
    const p = makePipeline({
      config: await loadConfig("requests: {}"),
      credentialPicker: fixedPicker([route.credential]),
      modelProviders: providers(route.provider),
      respond: route.respond,
    });

    afterAll(p.dispose);

    return p;
  };

  const upstreamInput = (call: { readonly body: string }): Json[] => {
    const input = get(tryParseJson(call.body), "input");

    return Array.isArray(input) ? input : [];
  };

  const capsulesIn = (text: string): string[] => [
    ...new Set(text.match(/cpa-ag-compact-v1:[A-Za-z0-9_-]+/g) ?? []),
  ];

  const expectSummaryRequest = (call: { readonly body: string; readonly url: string }) => {
    expect(call.url).toBe(route.url);
    expect(JSON.parse(call.body).model).toContain(route.provider === "kimi" ? "kimi" : "muse");
    expect(call.body).not.toContain("compaction_trigger");
    expect(call.body).not.toContain("gAAAA-native");
    expect(call.body).not.toContain("cpa-ag-compact-v1:");
    expect(JSON.stringify(upstreamInput(call))).toContain("Context summary from previous turns:");
  };

  it("answers a compaction_trigger with a sealed response from one summary request", async () => {
    const p = await pipeline();

    const response = await p.call(
      "/v1/responses",
      postJson({
        model: route.model,
        stream: false,
        input: [await capsule(), foreign, userMessage, { type: "compaction_trigger" }],
      }),
    );

    expect(response.status).toBe(200);
    expect(p.calls).toHaveLength(1);
    expectSummaryRequest(p.calls[0]!);
    const body: Json = await response.json();
    expect(get(body, "object")).toBe("response.compaction");
    expect(await unsealCompaction(asString(get(body, "output.0.encrypted_content")))).toBe(
      "the summary",
    );
    expect(get(body, "usage.input_tokens")).toBe(9);
    expect(p.records).toHaveLength(1);
    expect(p.records[0]).toMatchObject({ provider: route.provider, failed: false });
  });

  it("answers a streaming compaction_trigger with the synthetic Responses stream", async () => {
    const p = await pipeline();

    const response = await p.call(
      "/v1/responses",
      postJson({
        model: route.model,
        stream: true,
        input: [await capsule(), userMessage, { type: "compaction_trigger" }],
      }),
    );

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain("event: response.completed");
    expect(await unsealCompaction(capsulesIn(text)[0] ?? "")).toBe("the summary");
    expect(p.calls).toHaveLength(1);
  });

  it("serves /v1/responses/compact locally instead of answering 501", async () => {
    const p = await pipeline();

    const response = await p.call(
      "/v1/responses/compact",
      postJson({ model: route.model, input: [await capsule(), foreign, userMessage] }),
    );

    expect(response.status).toBe(200);
    expect(p.calls).toHaveLength(1);
    expectSummaryRequest(p.calls[0]!);
    const body: Json = await response.json();
    expect(get(body, "object")).toBe("response.compaction");
    expect(await unsealCompaction(asString(get(body, "output.0.encrypted_content")))).toBe(
      "the summary",
    );
  });

  it("drops foreign compaction items from an ordinary request and expands the capsules", async () => {
    const p = await pipeline();

    await p.call(
      "/v1/responses",
      postJson({
        model: route.model,
        stream: false,
        input: [foreign, await capsule(), userMessage],
      }),
    );

    expect(p.calls[0]!.body).not.toContain("gAAAA-native");
    expect(p.calls[0]!.body).not.toContain("cpa-ag-compact-v1:");
    expect(JSON.stringify(upstreamInput(p.calls[0]!))).toContain("earlier work");
  });

  it("refuses a compaction source that continues a previous response", async () => {
    const p = await pipeline();

    const response = await p.call(
      "/v1/responses",
      postJson({
        model: route.model,
        previous_response_id: "resp_1",
        input: [userMessage, { type: "compaction_trigger" }],
      }),
    );

    expect(response.status).toBe(400);
    expect(p.calls).toHaveLength(0);
  });

  it("answers a summary that did not complete with a 502", async () => {
    const incomplete: Json = {
      ...(summaryResponse() as Record<string, Json>),
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    };

    const p = makePipeline({
      config: await loadConfig("requests: {}"),
      credentialPicker: fixedPicker([route.credential]),
      modelProviders: providers(route.provider),
      respond: () =>
        route.provider === "kimi"
          ? jsonResponse(incomplete)
          : sseResponse([
              `data: ${JSON.stringify({ type: "response.incomplete", response: incomplete })}\n\n`,
            ]),
    });

    afterAll(p.dispose);

    const response = await p.call(
      "/v1/responses",
      postJson({ model: route.model, input: [userMessage, { type: "compaction_trigger" }] }),
    );

    expect(response.status).toBe(502);
  });
});
