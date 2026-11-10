// End-to-end tests (workerd) of the Gemini provider-key executor through the Access gate, the `/v1beta` routes, model
// resolution and a mocked upstream: URLs, credentials, shaping, payload rules (final barrier), streaming and errors.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config/schema.ts";
import { credential, makeGeminiHarness } from "./support/gemini.ts";
import {
  jsonResponse,
  loadConfig,
  postJson,
  sseResponse,
  type UpstreamResponder,
} from "./support/pipeline.ts";
import type { Json } from "@commissary/json";

const YAML = `
requests:
  payload:
    override:
      - models: [{ name: "gemini-2.5-pro", protocol: gemini }]
        params:
          "generationConfig.maxOutputTokens": 999999
          "session_id": "from-rule"
          "generationConfig.topK": 7
`;

const GEMINI_RESPONSE = {
  candidates: [
    { content: { role: "model", parts: [{ text: "Hello" }] }, finishReason: "STOP", index: 0 },
  ],
  usageMetadata: {
    promptTokenCount: 4,
    candidatesTokenCount: 1,
    thoughtsTokenCount: 2,
    totalTokenCount: 7,
  },
  modelVersion: "gemini-2.5-pro",
  responseId: "r1",
};

let config: Config;

beforeAll(async () => {
  config = await loadConfig(YAML);
});

const cred = credential("gemini", "gemini:apikey:1", {
  attributes: { api_key: "AIza-test", base_url: "https://gl.test/", "header:X-Custom": "fixed" },
});

const models = { "gemini-2.5-pro": ["gemini"], "gemini-2.5-flash": ["gemini"] };

const harness = (respond: UpstreamResponder, overrides: { config?: Config } = {}) =>
  makeGeminiHarness({ config: overrides.config ?? config, respond, credential: cred, models });

describe("POST /v1beta/models/{model}:generateContent", () => {
  it("forwards to the Gemini API with the provider key, custom headers and the shaped body", async () => {
    const h = harness(() => jsonResponse(GEMINI_RESPONSE));
    afterAll(h.dispose);

    const response = await h.call(
      "/v1beta/models/gemini-2.5-pro:generateContent",
      postJson({
        contents: [{ role: "model", parts: [{ text: "prefill" }] }],
        generationConfig: { maxOutputTokens: 100 },
        session_id: "client-session",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(GEMINI_RESPONSE);
    const call = h.calls[0];
    expect(call?.url).toBe("https://gl.test/v1beta/models/gemini-2.5-pro:generateContent");
    expect(call?.headers["x-goog-api-key"]).toBe("AIza-test");
    expect(call?.headers["x-custom"]).toBe("fixed");
    expect(call?.headers["authorization"]).toBeUndefined();
    const body = JSON.parse(call?.body ?? "{}");
    // Leading and trailing user turns are added around the model-only history.
    expect(body.contents.map((c: { role: string }) => c.role)).toEqual(["user", "model", "user"]);
    expect(body.safetySettings).toHaveLength(5);
    expect(body.model).toBe("gemini-2.5-pro");
    expect(h.records).toHaveLength(1);
    expect(h.records[0]?.detail).toMatchObject({
      inputTokens: 4,
      outputTokens: 1,
      reasoningTokens: 2,
      totalTokens: 7,
    });
  });

  it("applies user payload rules last: rule values survive the cap, session_id removal and model rewrite", async () => {
    const h = harness(() => jsonResponse(GEMINI_RESPONSE));
    afterAll(h.dispose);
    await h.call(
      "/v1beta/models/gemini-2.5-pro:generateContent",
      postJson({
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        generationConfig: { maxOutputTokens: 100, topK: 1 },
      }),
    );
    const body = JSON.parse(h.calls[0]?.body ?? "{}");
    // Rules run after capGeminiMaxOutputTokens (the model limit is far below 999999) and after `session_id` removal.
    expect(body.generationConfig.maxOutputTokens).toBe(999999);
    expect(body.generationConfig.topK).toBe(7);
    expect(body.session_id).toBe("from-rule");
  });

  it("caps maxOutputTokens to the model limit when no rule applies", async () => {
    const h = harness(() => jsonResponse(GEMINI_RESPONSE));
    afterAll(h.dispose);
    await h.call(
      "/v1beta/models/gemini-2.5-flash:generateContent",
      postJson({
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        generationConfig: { maxOutputTokens: 99999999 },
      }),
    );
    const body = JSON.parse(h.calls[0]?.body ?? "{}");
    expect(body.generationConfig.maxOutputTokens).toBeLessThan(99999999);
  });

  it("passes `alt` through as $alt and keeps the suffix out of the upstream model", async () => {
    const h = harness(() => jsonResponse(GEMINI_RESPONSE));
    afterAll(h.dispose);
    await h.call(
      "/v1beta/models/gemini-2.5-flash(low):generateContent?alt=json",
      postJson({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
    );
    expect(h.calls[0]?.url).toBe(
      "https://gl.test/v1beta/models/gemini-2.5-flash:generateContent?$alt=json",
    );
  });

  it("answers upstream errors with the upstream status and classifies 401 as credential scoped", async () => {
    const h = harness(() =>
      jsonResponse({ error: { code: 401, message: "Provider key not valid" } }, { status: 401 }),
    );

    afterAll(h.dispose);

    const response = await h.call(
      "/v1beta/models/gemini-2.5-flash:generateContent",
      postJson({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
    );

    expect(response.status).toBe(401);
    expect(await response.text()).toContain("Provider key not valid");
    expect(h.reports[0]).toMatchObject({ success: false, httpStatus: 401, credentialScoped: true });
    expect(h.records[0]?.failed).toBe(true);
  });

  it("rejects unknown actions with 404 and invalid bodies with 400", async () => {
    const h = harness(() => jsonResponse(GEMINI_RESPONSE));
    afterAll(h.dispose);
    const unknown = await h.call("/v1beta/models/gemini-2.5-pro:embedContent", postJson({}));
    expect(unknown.status).toBe(404);
    const noAction = await h.call("/v1beta/models/gemini-2.5-pro", postJson({}));
    expect(noAction.status).toBe(404);

    const invalid = await h.call(
      "/v1beta/models/gemini-2.5-pro:generateContent",
      postJson("not json"),
    );

    expect(invalid.status).toBe(400);
    expect(h.calls).toHaveLength(0);
  });

  it("answers 400 for models without a provider", async () => {
    const h = harness(() => jsonResponse(GEMINI_RESPONSE));
    afterAll(h.dispose);

    const response = await h.call(
      "/v1beta/models/unknown-model:generateContent",
      postJson({ contents: [] }),
    );

    expect(response.status).toBe(400);
  });
});

describe("POST /v1beta/models/{model}:streamGenerateContent", () => {
  const line = (value: Json) => `data: ${JSON.stringify(value)}\n\n`;

  it("frames chunks as SSE, hides intermediate usage and publishes the final usage", async () => {
    const h = harness(() =>
      sseResponse([
        line({
          candidates: [{ content: { parts: [{ text: "Hel" }] }, index: 0 }],
          usageMetadata: { promptTokenCount: 3, totalTokenCount: 3 },
        }),
        line({
          candidates: [{ content: { parts: [{ text: "lo" }] }, finishReason: "STOP", index: 0 }],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
        }),
      ]),
    );

    afterAll(h.dispose);

    const response = await h.call(
      "/v1beta/models/gemini-2.5-flash:streamGenerateContent",
      postJson({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();

    const chunks = text
      .split("\n\n")
      .filter((frame) => frame.startsWith("data: "))
      .map((frame) => JSON.parse(frame.slice(6)));

    expect(chunks).toHaveLength(2);
    // Gemini -> Gemini is a passthrough of the filtered line: the non-terminal chunk lost its usageMetadata.
    expect(chunks[0].usageMetadata).toBeUndefined();
    expect(chunks[0].cpaUsageMetadata).toBeDefined();
    expect(chunks[1].usageMetadata.totalTokenCount).toBe(5);
    expect(h.calls[0]?.url).toBe(
      "https://gl.test/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
    );
    expect(JSON.parse(h.calls[0]?.body ?? "{}").contents.at(-1).role).toBe("user");
    expect(h.records[0]?.detail.totalTokens).toBe(5);
  });

  it("uses raw chunks and $alt for other alt values", async () => {
    const h = harness(() => sseResponse([line(GEMINI_RESPONSE)]));
    afterAll(h.dispose);

    const response = await h.call(
      "/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=json",
      postJson({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
    );

    expect(h.calls[0]?.url).toBe(
      "https://gl.test/v1beta/models/gemini-2.5-flash:streamGenerateContent?$alt=json",
    );
    expect(JSON.parse(await response.text())).toEqual(GEMINI_RESPONSE);
  });

  it("turns a pre-stream upstream failure into an HTTP error", async () => {
    const h = harness(() => jsonResponse({ error: { message: "quota" } }, { status: 429 }));
    afterAll(h.dispose);

    const response = await h.call(
      "/v1beta/models/gemini-2.5-flash:streamGenerateContent",
      postJson({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
    );

    expect(response.status).toBe(429);
  });
});

describe("POST /v1beta/models/{model}:countTokens", () => {
  it("strips tools/generationConfig/safetySettings and returns the upstream count", async () => {
    const h = harness(() =>
      jsonResponse({
        totalTokens: 11,
        promptTokensDetails: [{ modality: "TEXT", tokenCount: 11 }],
      }),
    );

    afterAll(h.dispose);

    const response = await h.call(
      "/v1beta/models/gemini-2.5-flash:countTokens",
      postJson({
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        tools: [{ googleSearch: {} }],
        generationConfig: { temperature: 1 },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      totalTokens: 11,
      promptTokensDetails: [{ modality: "TEXT", tokenCount: 11 }],
    });
    expect(h.calls[0]?.url).toBe("https://gl.test/v1beta/models/gemini-2.5-flash:countTokens");
    const body = JSON.parse(h.calls[0]?.body ?? "{}");
    expect(body.tools).toBeUndefined();
    expect(body.generationConfig).toBeUndefined();
    expect(body.safetySettings).toBeUndefined();
  });
});

describe("OpenAI client -> Gemini credential", () => {
  it("translates the chat completion both ways", async () => {
    const h = harness(() => jsonResponse(GEMINI_RESPONSE));
    afterAll(h.dispose);

    const response = await h.call(
      "/v1/chat/completions",
      postJson({
        model: "gemini-2.5-flash",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 50,
      }),
    );

    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      choices: Array<{ message: { content: string }; finish_reason: string }>;
      usage: { prompt_tokens: number };
    };

    expect(body.choices[0]?.message.content).toBe("Hello");
    expect(body.choices[0]?.finish_reason).toBe("stop");
    expect(body.usage.prompt_tokens).toBe(4);
    const upstream = JSON.parse(h.calls[0]?.body ?? "{}");
    expect(upstream.contents[0]).toEqual({ role: "user", parts: [{ text: "hi" }] });
    expect(upstream.generationConfig.maxOutputTokens).toBe(50);
  });

  it("streams chat completion chunks", async () => {
    const h = harness(() =>
      sseResponse([
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "Hi" }] }, index: 0 }], responseId: "r" })}\n\n`,
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "!" }] }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 }, responseId: "r" })}\n\n`,
      ]),
    );

    afterAll(h.dispose);

    const response = await h.call(
      "/v1/chat/completions",
      postJson({
        model: "gemini-2.5-pro",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    const text = await response.text();
    expect(text).toContain('"content":"Hi"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });
});

describe("OpenAI Responses client -> Gemini credential", () => {
  it("translates a non-stream response and echoes the request fields", async () => {
    const h = harness(() => jsonResponse(GEMINI_RESPONSE));
    afterAll(h.dispose);

    const response = await h.call(
      "/v1/responses",
      postJson({
        model: "gemini-2.5-flash",
        input: "hi",
        instructions: "be brief",
        max_output_tokens: 50,
      }),
    );

    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      id: string;
      status: string;
      instructions: string;
      output: Array<{ type: string; content: Array<{ text: string }> }>;
      usage: { input_tokens: number; output_tokens: number };
    };

    expect(body.id).toBe("resp_r1");
    expect(body.status).toBe("completed");
    expect(body.instructions).toBe("be brief");
    expect(body.output[0]?.content[0]?.text).toBe("Hello");
    expect(body.usage).toMatchObject({ input_tokens: 4, output_tokens: 3 });
    const upstream = JSON.parse(h.calls[0]?.body ?? "{}");
    expect(upstream.systemInstruction.parts[0].text).toBe("be brief");
    expect(upstream.contents[0]).toEqual({ role: "user", parts: [{ text: "hi" }] });
    expect(upstream.generationConfig.maxOutputTokens).toBe(50);
  });

  it("streams Responses events ending with response.completed", async () => {
    const h = harness(() =>
      sseResponse([
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "Hi" }] }, index: 0 }], responseId: "r" })}\n\n`,
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "!" }] }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 }, responseId: "r" })}\n\n`,
      ]),
    );

    afterAll(h.dispose);

    const response = await h.call(
      "/v1/responses",
      postJson({ model: "gemini-2.5-pro", stream: true, input: "hi" }),
    );

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("event: response.created");
    expect(text).toContain("event: response.output_text.delta");
    expect(text).toContain("event: response.completed");
    expect(h.records[0]?.detail.totalTokens).toBe(3);
  });

  describe("prompt blocks and truncated OpenAI streams (Go 3f5d3a16)", () => {
    const BLOCKED = {
      promptFeedback: { blockReason: "PROHIBITED_CONTENT", blockReasonMessage: "nope" },
      usageMetadata: { promptTokenCount: 5, totalTokenCount: 5 },
    };

    it("answers a candidate-less non-stream prompt block with 502 and keeps its usage", async () => {
      const h = harness(() => jsonResponse(BLOCKED));
      afterAll(h.dispose);

      const response = await h.call(
        "/v1/chat/completions",
        postJson({ model: "gemini-2.5-pro", messages: [{ role: "user", content: "hi" }] }),
      );

      expect(response.status).toBe(502);
      expect(await response.text()).toContain(
        "upstream blocked the prompt: PROHIBITED_CONTENT - nope",
      );
      expect(h.records[0]).toMatchObject({
        failed: true,
        fail: { statusCode: 502 },
        detail: { inputTokens: 5 },
      });
    });

    it("fails a streamed prompt block with 502 before translating it", async () => {
      const h = harness(() => sseResponse([`data: ${JSON.stringify(BLOCKED)}\n\n`]));

      afterAll(h.dispose);

      const response = await h.call(
        "/v1/chat/completions",
        postJson({
          model: "gemini-2.5-pro",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      );

      const text = await response.text();
      expect(text).not.toContain("[DONE]");
      expect(h.records[0]).toMatchObject({ failed: true, fail: { statusCode: 502 } });
    });

    it("fails an OpenAI chat stream that closes before any finishReason", async () => {
      const h = harness(() =>
        sseResponse([
          `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "Hi" }] }, index: 0 }], responseId: "r" })}\n\n`,
        ]),
      );

      afterAll(h.dispose);

      const response = await h.call(
        "/v1/chat/completions",
        postJson({
          model: "gemini-2.5-pro",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      );

      expect(await response.text()).not.toContain("[DONE]");
      expect(h.records[0]).toMatchObject({ failed: true, fail: { statusCode: 502 } });
    });
  });

  describe("Claude clients (Go 4f2e5270)", () => {
    const chunk = (text: string, finishReason?: string) =>
      `data: ${JSON.stringify({
        candidates: [
          { content: { parts: [{ text }] }, ...(finishReason ? { finishReason } : {}), index: 0 },
        ],
        responseId: "r",
      })}\n\n`;

    const ask = async (frames: string[]) => {
      const h = harness(() => sseResponse(frames));
      afterAll(h.dispose);

      const response = await h.call(
        "/v1/messages",
        postJson({
          model: "gemini-2.5-pro",
          max_tokens: 16,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      );

      return { text: await response.text(), records: h.records };
    };

    it("fails a stream that closes before any finishReason with 502", async () => {
      const { records } = await ask([chunk("Hi")]);
      expect(records[0]).toMatchObject({ failed: true, fail: { statusCode: 502 } });
    });

    it("completes a stream that carries a finishReason", async () => {
      const { text, records } = await ask([chunk("Hi"), chunk("!", "STOP")]);
      expect(text).toContain("message_stop");
      expect(records[0]).toMatchObject({ failed: false });
    });
  });
});
