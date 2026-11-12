// End-to-end tests of POST /v1beta/interactions: target validation, native Interactions passthrough on a
// `gemini-interactions` credential, translation to generateContent on a plain Gemini credential, agent routing.
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { Config } from "../src/config/schema.ts";
import { credential, makeGeminiHarness } from "./support/gemini.ts";
import { nativeGeminiSignature, vertexBareTink } from "./support/gemini-signatures.ts";
import {
  jsonResponse,
  loadConfig,
  postJson,
  sseResponse,
  type UpstreamResponder,
} from "./support/pipeline.ts";
import type { Json } from "@commissary/json";

let config: Config;

beforeAll(async () => {
  config = await loadConfig("");
});

const native = credential("gemini-interactions", "gemini-interactions:1", {
  attributes: { api_key: "AIza-native", base_url: "https://gl.test" },
});

const plain = credential("gemini", "gemini:1", {
  attributes: { api_key: "AIza-plain", base_url: "https://gl.test" },
});

const models = { "gemini-2.5-pro": ["gemini-interactions"], "gemini-2.5-flash": ["gemini"] };

const harness = (respond: UpstreamResponder, cred = native) =>
  makeGeminiHarness({ config, respond, credential: cred, models });

const INTERACTION = {
  id: "int_1",
  status: "completed",
  steps: [{ type: "model_output", content: [{ type: "text", text: "hi" }] }],
  usage: { total_input_tokens: 3, total_output_tokens: 1, total_tokens: 4 },
};

describe("POST /v1beta/interactions", () => {
  it("requires exactly one of model or agent and a boolean stream", async () => {
    const h = harness(() => jsonResponse(INTERACTION));
    afterAll(h.dispose);

    for (const body of [
      { input: "x" },
      { model: "a", agent: "b", input: "x" },
      { model: "gemini-2.5-pro", stream: "yes" },
    ]) {
      const response = await h.call("/v1beta/interactions", postJson(body));
      expect(response.status).toBe(400);
    }

    expect(h.calls).toHaveLength(0);
  });

  it("posts natively to /v1beta/interactions with the API revision header and the request body", async () => {
    const h = harness(() => jsonResponse(INTERACTION));
    afterAll(h.dispose);

    const response = await h.call(
      "/v1beta/interactions",
      postJson({ model: "models/gemini-2.5-pro", input: "hello", stream: false }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "int_1", status: "completed" });
    expect(h.calls[0]?.url).toBe("https://gl.test/v1beta/interactions");
    expect(h.calls[0]?.headers["x-goog-api-key"]).toBe("AIza-native");
    expect(h.calls[0]?.headers["api-revision"]).toBeDefined();
    const upstream = JSON.parse(h.calls[0]?.body ?? "{}");
    expect(upstream.model).toBe("gemini-2.5-pro");
    expect(upstream.input).toBe("hello");
    expect(h.records[0]?.detail.totalTokens).toBe(4);
  });

  it("streams native interaction events as SSE frames", async () => {
    const frame = (event: string, data: Json) =>
      `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

    const h = harness(() =>
      sseResponse([
        frame("interaction.created", {
          event_type: "interaction.created",
          interaction: { id: "int_1" },
        }),
        frame("step.delta", {
          event_type: "step.delta",
          index: 0,
          delta: { type: "text", text: "hi" },
        }),
        frame("interaction.completed", {
          event_type: "interaction.completed",
          interaction: {
            id: "int_1",
            usage: { total_input_tokens: 2, total_output_tokens: 1, total_tokens: 3 },
          },
        }),
      ]),
    );

    afterAll(h.dispose);

    const response = await h.call(
      "/v1beta/interactions",
      postJson({ model: "gemini-2.5-pro", input: "hello", stream: true }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain("event: interaction.created");
    expect(text).toContain("event: step.delta");
    expect(h.calls[0]?.url).toContain("/v1beta/interactions");
    expect(h.records[0]?.detail.totalTokens).toBe(3);
  });

  it("translates to generateContent for a plain Gemini credential and back", async () => {
    const h = harness(
      () =>
        jsonResponse({
          candidates: [
            {
              content: { role: "model", parts: [{ text: "Hello" }] },
              finishReason: "STOP",
              index: 0,
            },
          ],
          usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1, totalTokenCount: 5 },
          responseId: "r1",
        }),
      plain,
    );

    afterAll(h.dispose);

    const response = await h.call(
      "/v1beta/interactions",
      postJson({ model: "gemini-2.5-flash", input: "hello", system_instruction: "be brief" }),
    );

    expect(response.status).toBe(200);
    expect(h.calls[0]?.url).toBe("https://gl.test/v1beta/models/gemini-2.5-flash:generateContent");
    const upstream = JSON.parse(h.calls[0]?.body ?? "{}");
    expect(upstream.systemInstruction.parts[0].text).toBe("be brief");
    expect(upstream.contents[0]).toEqual({ role: "user", parts: [{ text: "hello" }] });
    const body = (await response.json()) as { steps: Array<{ content: Array<{ text: string }> }> };
    expect(body).toMatchObject({ id: "r1", object: "interaction", status: "completed" });
    expect(body.steps[0]?.content[0]?.text).toBe("Hello");
  });

  it("routes agent requests to the gemini-interactions provider and selects credentials as for gemini-2.5-flash", async () => {
    const h = harness(() => jsonResponse({ ...INTERACTION, id: "agent_1" }));
    afterAll(h.dispose);

    const response = await h.call(
      "/v1beta/interactions",
      postJson({ agent: "deep-research-pro", input: "research" }),
    );

    expect(response.status).toBe(200);
    expect(h.picks[0]).toMatchObject({
      providers: ["gemini-interactions"],
      selectionModel: "gemini-2.5-flash",
    });
    const upstream = JSON.parse(h.calls[0]?.body ?? "{}");
    expect(upstream.agent).toBe("deep-research-pro");
    expect(h.calls[0]?.url).toBe("https://gl.test/v1beta/interactions");
  });
});

// CLIProxyAPI a8582fba (helps/gemini_interactions_test.go): the public Interactions endpoint rejects a Vertex bare-Tink
// thought signature, so the thought step is dropped like any other incompatible one; Vertex keeps it
// (vertex-executor.test.ts).
describe("native Interactions thought steps", () => {
  const userInput = { type: "user_input", content: [{ type: "text", text: "hi" }] };

  const sentInput = async (steps: Json[]): Promise<Json> => {
    const h = harness(() => jsonResponse(INTERACTION));

    const response = await h.call(
      "/v1beta/interactions",
      postJson({ model: "gemini-2.5-pro", input: [userInput, ...steps] }),
    );

    expect(response.status).toBe(200);
    await response.text();
    await h.dispose();

    return JSON.parse(h.calls[0]?.body ?? "{}").input;
  };

  it("drops a Vertex bare-Tink thought step", async () => {
    expect(await sentInput([{ type: "thought", signature: vertexBareTink() }])).toEqual([
      userInput,
    ]);
  });

  it("keeps a native Gemini thought step and strips the fields the API rejects", async () => {
    const signature = nativeGeminiSignature();

    expect(
      await sentInput([
        { type: "thought", signature, id: "t1", text: "visible", content: [] },
        { type: "thought", thought_signature: signature },
      ]),
    ).toEqual([userInput, { type: "thought", signature }, { type: "thought", signature }]);
  });

  it("drops thought steps without a valid Gemini signature", async () => {
    expect(
      await sentInput([
        { type: "thought" },
        { type: "thought", signature: "skip_thought_signature_validator" },
        { type: "thought", signature: "not-a-signature" },
      ]),
    ).toEqual([userInput]);
  });
});
