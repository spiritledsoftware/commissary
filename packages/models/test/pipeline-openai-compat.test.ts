// End-to-end tests (workerd) of the OpenAI-compatible upstream for every client protocol: Claude Messages, Responses,
// Responses-shaped chat payloads, Gemini/Interactions through the executor, and the Images API.
import { Effect, Layer, Predicate, Stream } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config/schema.ts";
import { makeOpenAICompatExecutor } from "../src/executor/openai-compat/executor.ts";
import type { CredentialSnapshot } from "../src/executor/picker.ts";
import { Thinking } from "../src/executor/thinking.ts";
import type { ExecutionContext, ExecutorOptions } from "../src/executor/types.ts";
import { get, type Json } from "@commissary/json";
import { UsageReporter } from "../src/usage/reporter.ts";
import { buildImagesApiResponse } from "../src/handlers/openai/images.ts";
import {
  jsonResponse,
  loadConfig,
  makePipeline,
  postJson,
  sseResponse,
} from "./support/pipeline.ts";
import { GLOBAL_ORG } from "@commissary/core";

const YAML = `
api-keys:
  openai-compatibility:
    - name: Mock
      base-url: https://upstream.test/v1
      models:
        - name: upstream-model
          alias: alias-model
        - name: image-model
          image: true
      keys:
        - api-key: sk-test-1
requests:
  payload:
    override:
      - models: [{ name: "image-model", protocol: openai }]
        params: { "quality": "from-rule" }
      - models: [{ name: "upstream-model", protocol: openai }]
        params: { "metadata.via": "payload-rule" }
`;

const COMPLETION = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1700000000,
  model: "upstream-model",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "hello",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":1}' } },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
};

const chunk = (
  delta: Record<string, unknown>,
  finish: string | null = null,
  extra: Record<string, unknown> = {},
) =>
  `data: ${JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "upstream-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...extra,
  })}\n\n`;

const STREAM = [
  chunk({ role: "assistant", content: "" }),
  chunk({ content: "Hel" }),
  chunk({ content: "lo" }),
  chunk({}, "stop"),
  chunk({}, null, {
    choices: [],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  }),
  "data: [DONE]\n\n",
];

const at = (value: Json | undefined, path: string): Json | undefined => get(value, path);

let config: Config;

beforeAll(async () => {
  config = await loadConfig(YAML);
});

const pipeline = (respond: Parameters<typeof makePipeline>[0]["respond"]) =>
  makePipeline({ config, respond });

describe("Claude Messages client -> OpenAI-compatible upstream", () => {
  it("translates the request and the non-stream answer", async () => {
    const p = pipeline(() => jsonResponse(COMPLETION));
    afterAll(p.dispose);

    const response = await p.call(
      "/v1/messages",
      postJson({
        model: "alias-model",
        max_tokens: 20,
        system: "be brief",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "lookup", description: "d", input_schema: { type: "object" } }],
      }),
    );

    expect(response.status).toBe(200);
    const upstream: Json = JSON.parse(p.calls[0]!.body);
    expect(p.calls[0]!.url).toBe("https://upstream.test/v1/chat/completions");
    expect(at(upstream, "model")).toBe("upstream-model");
    expect(at(upstream, "messages.0")).toEqual({
      role: "system",
      content: [{ type: "text", text: "be brief" }],
    });
    expect(at(upstream, "tools.0.function.name")).toBe("lookup");
    expect(at(upstream, "metadata")).toEqual({ via: "payload-rule" });
    const body: Json = await response.json();
    expect(at(body, "type")).toBe("message");
    expect(at(body, "stop_reason")).toBe("tool_use");
    expect(at(body, "content.#.type")).toEqual(["text", "tool_use"]);
    expect(at(body, "content.1")).toMatchObject({ name: "lookup", input: { q: 1 } });
  });

  it("translates the stream to Messages events", async () => {
    const p = pipeline(() => sseResponse(STREAM));
    afterAll(p.dispose);

    const response = await p.call(
      "/v1/messages",
      postJson({
        model: "alias-model",
        max_tokens: 20,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    const text = await response.text();
    const events = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    expect(events).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(text).toContain('"text":"Hel"');
    expect(JSON.parse(p.calls[0]!.body).stream_options).toEqual({ include_usage: true });
  });
});

describe("Responses client -> OpenAI-compatible upstream", () => {
  it("translates /v1/responses non-stream", async () => {
    const p = pipeline(() => jsonResponse(COMPLETION));
    afterAll(p.dispose);

    const response = await p.call(
      "/v1/responses",
      postJson({ model: "alias-model", instructions: "sys", input: "hi", max_output_tokens: 9 }),
    );

    expect(response.status).toBe(200);
    const upstream: Json = JSON.parse(p.calls[0]!.body);
    expect(at(upstream, "messages")).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
    const body: Json = await response.json();
    expect(at(body, "object")).toBe("response");
    expect(at(body, "output.#.type")).toEqual(["message", "function_call"]);
  });

  it("translates /v1/responses streams and ends them with response.completed", async () => {
    const p = pipeline(() => sseResponse(STREAM));
    afterAll(p.dispose);

    const response = await p.call(
      "/v1/responses",
      postJson({ model: "alias-model", input: "hi", stream: true }),
    );

    const text = await response.text();
    expect(text).toContain("event: response.created");
    expect(text).toContain("event: response.output_text.delta");
    expect(text).toContain("event: response.completed");
  });

  it("posts /v1/responses/compact to {base-url}/responses/compact in Responses format without chat shaping", async () => {
    const compaction = {
      id: "resp_c",
      object: "response.compaction",
      output: [{ type: "compaction", id: "cmp_1", encrypted_content: "opaque" }],
      usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
    };

    const p = pipeline(() => jsonResponse(compaction));
    afterAll(p.dispose);

    const response = await p.call(
      "/v1/responses/compact",
      postJson({
        model: "alias-model",
        stream: false,
        input: [
          { type: "message", role: "user", content: "hi" },
          {
            type: "reasoning",
            id: "rs_1",
            summary: [],
            content: [{ type: "reasoning_text", text: "secret" }],
          },
        ],
        max_output_tokens: 9,
      }),
    );

    expect(response.status).toBe(200);
    expect(p.calls[0]?.url).toBe("https://upstream.test/v1/responses/compact");
    const upstream: Json = JSON.parse(p.calls[0]!.body);
    expect(at(upstream, "model")).toBe("upstream-model");
    expect(at(upstream, "stream")).toBeUndefined();
    expect(at(upstream, "messages")).toBeUndefined();
    expect(at(upstream, "max_output_tokens")).toBe(9);
    expect(at(upstream, "max_tokens")).toBeUndefined();
    expect(at(upstream, "prompt_cache_key")).toBeUndefined();
    // Reasoning cleartext never reaches the upstream.
    expect(at(upstream, "input.1.content")).toEqual([]);
    const body: Json = await response.json();
    expect(at(body, "object")).toBe("response.compaction");
    expect(at(body, "output.0.encrypted_content")).toBe("opaque");
    expect(p.records[0]?.detail).toMatchObject({ inputTokens: 4, outputTokens: 1 });
  });

  it("converts Responses-shaped payloads sent to /v1/chat/completions", async () => {
    const p = pipeline(() => jsonResponse(COMPLETION));
    afterAll(p.dispose);

    const response = await p.call(
      "/v1/chat/completions",
      postJson({ model: "alias-model", input: "hi", instructions: "sys" }),
    );

    expect(response.status).toBe(200);
    const upstream: Json = JSON.parse(p.calls[0]!.body);
    expect(at(upstream, "messages")).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
    expect(at(upstream, "input")).toBeUndefined();
    expect(at(await response.json(), "object")).toBe("chat.completion");
  });

  it("keeps chat payloads that carry messages untouched", async () => {
    const p = pipeline(() => jsonResponse(COMPLETION));
    afterAll(p.dispose);
    await p.call(
      "/v1/chat/completions",
      postJson({
        model: "alias-model",
        messages: [{ role: "user", content: "hi" }],
        instructions: "kept",
      }),
    );
    expect(JSON.parse(p.calls[0]!.body).instructions).toBe("kept");
  });
});

describe("Gemini and Interactions clients through the executor", () => {
  const credential: CredentialSnapshot = {
    id: "c",
    provider: "openai-compatible-mock",
    kind: "apikey",
    attributes: { base_url: "https://upstream.test/v1", api_key: "sk-test-1" },
    metadata: {},
  };

  const run = async (
    sourceFormat: string,
    payload: Json,
    stream: boolean,
    upstream: () => Response,
    onUsage: (usage: UsageReporter) => void = () => {},
  ) => {
    const bodies: Json[] = [];

    const client = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          if (Predicate.isTagged(request.body, "Uint8Array")) {
            bodies.push(JSON.parse(new TextDecoder().decode(request.body.body)));
          }

          return HttpClientResponse.fromWeb(request, upstream());
        }),
      ),
    );

    const usage = new UsageReporter({
      requestId: "r",
      provider: credential.provider,
      executorType: credential.provider,
      model: "upstream-model",
      alias: "upstream-model",
      endpoint: "POST /x",
      principalId: "p",
      orgId: GLOBAL_ORG,
      authId: "c",
      authType: "apikey",
      source: "s",
      stream,
      serviceTier: "auto",
      requestedAt: 0,
    });

    onUsage(usage);
    const context: ExecutionContext = { credential, config, usage };

    const options: ExecutorOptions = {
      stream,
      alt: "",
      headers: new Headers(),
      query: new URLSearchParams(),
      originalRequest: undefined,
      sourceFormat,
      metadata: {
        requestPath: "/x",
        requestedModel: "upstream-model",
        serviceTier: "auto",
        generate: true,
        callerScope: "scope",
      },
    };

    const executor = makeOpenAICompatExecutor(credential.provider);
    const layers = Layer.mergeAll(client, Thinking.live);
    const request = { model: "upstream-model", payload };

    const output = stream
      ? await Effect.runPromise(
          executor.executeStream(context, request, options).pipe(
            Effect.flatMap((result) => Stream.runCollect(result.chunks)),
            Effect.provide(layers),
          ),
        )
      : await Effect.runPromise(
          executor.execute(context, request, options).pipe(Effect.provide(layers)),
        );

    return { bodies, output };
  };

  it("translates a Gemini request and non-stream answer", async () => {
    const { bodies, output } = await run(
      "gemini",
      {
        systemInstruction: { parts: [{ text: "sys" }] },
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        generationConfig: { maxOutputTokens: 12 },
      },
      false,
      () => new Response(JSON.stringify(COMPLETION)),
    );

    expect(at(bodies[0], "model")).toBe("upstream-model");
    expect(at(bodies[0], "messages.0")).toEqual({
      role: "system",
      content: [{ type: "text", text: "sys" }],
    });
    const body: Json = JSON.parse((output as { payload: string }).payload);
    expect(JSON.stringify(at(body, "candidates.0.content.parts"))).toContain("functionCall");
    expect(at(body, "usageMetadata.totalTokenCount")).toBe(7);
  });

  it("takes the streaming TTFT from the first effective token frame, not the first frame", async () => {
    const ttftAfter = async (frames: string[]) => {
      let usage: UsageReporter | undefined;

      // No `[DONE]` frame, so the only token event is the one under test.
      await run(
        "gemini",
        { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
        true,
        () => new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } }),
        (value) => (usage = value),
      );

      return usage?.ttftObserved;
    };

    // A role-only frame is only the first-packet fallback.
    expect(await ttftAfter([chunk({ role: "assistant", content: "" })])).toBe(false);
    expect(
      await ttftAfter([chunk({ role: "assistant", content: "" }), chunk({ content: "Hel" })]),
    ).toBe(true);
  });

  it("translates a Gemini stream", async () => {
    const { output } = await run(
      "gemini",
      { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
      true,
      () => new Response(STREAM.join(""), { headers: { "content-type": "text/event-stream" } }),
    );

    const chunks = [...(output as Iterable<string>)];
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join("")).toContain('"text":"Hel"');
  });

  it("translates an Interactions request and answers with an interaction", async () => {
    const { bodies, output } = await run(
      "interactions",
      { input: "hi", system_instruction: "sys", generation_config: { max_output_tokens: 5 } },
      false,
      () => new Response(JSON.stringify(COMPLETION)),
    );

    expect(at(bodies[0], "messages.#.role")).toEqual(["system", "user"]);
    const body: Json = JSON.parse((output as { payload: string }).payload);
    expect(at(body, "object")).toBe("interaction");
    expect(at(body, "steps.#.type")).toEqual(["model_output", "function_call"]);
  });

  it("translates an Interactions stream into step events", async () => {
    const { output } = await run(
      "interactions",
      { input: "hi" },
      true,
      () => new Response(STREAM.join(""), { headers: { "content-type": "text/event-stream" } }),
    );

    const text = [...(output as Iterable<string>)].join("");
    expect(text).toContain("event: interaction.created");
    expect(text).toContain("event: step.delta");
    expect(text).toContain("event: interaction.completed");
  });

  it("applies payload rules last for every source format", async () => {
    for (const [format, payload] of [
      [
        "gemini",
        { contents: [{ role: "user", parts: [{ text: "hi" }] }], metadata: { via: "client" } },
      ],
      ["interactions", { input: "hi", metadata: { via: "client" } }],
      [
        "claude",
        { max_tokens: 5, messages: [{ role: "user", content: "hi" }], metadata: { via: "client" } },
      ],
      ["openai-response", { input: "hi", metadata: { via: "client" } }],
    ] as const) {
      const { bodies } = await run(
        format,
        payload as Json,
        false,
        () => new Response(JSON.stringify(COMPLETION)),
      );

      expect(at(bodies[0], "metadata"), format).toEqual({ via: "payload-rule" });
    }
  });
});

describe("Images API against an OpenAI-compatible image model", () => {
  const IMAGE_RESPONSE = {
    created: 1700000001,
    data: [{ b64_json: "QUJD", revised_prompt: "a cat" }],
    usage: { total_tokens: 3 },
  };

  it("forwards generations with payload rules and converts the answer to response_format", async () => {
    const p = pipeline(() => jsonResponse(IMAGE_RESPONSE));
    afterAll(p.dispose);

    const response = await p.call(
      "/v1/images/generations",
      postJson({ model: "image-model", prompt: "cat", response_format: "url", stream: false }),
    );

    expect(response.status).toBe(200);
    expect(p.calls[0]!.url).toBe("https://upstream.test/v1/images/generations");
    expect(p.calls[0]!.headers["authorization"]).toBe("Bearer sk-test-1");
    expect(JSON.parse(p.calls[0]!.body)).toEqual({
      model: "image-model",
      prompt: "cat",
      response_format: "url",
      quality: "from-rule",
    });
    expect(await response.json()).toEqual({
      created: 1700000001,
      data: [{ url: "data:image/png;base64,QUJD", revised_prompt: "a cat" }],
      usage: { total_tokens: 3 },
    });
  });

  it("streams raw upstream frames", async () => {
    const frames = [
      'event: image_generation.partial_image\ndata: {"b64_json":"AA"}\n\n',
      'event: image_generation.completed\ndata: {"b64_json":"BB"}\n\n',
    ];

    const p = pipeline(() => sseResponse(frames));
    afterAll(p.dispose);

    const response = await p.call(
      "/v1/images/generations",
      postJson({ model: "image-model", prompt: "cat", stream: true }),
    );

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toBe(frames.join(""));
    expect(at(JSON.parse(p.calls[0]!.body), "stream")).toBe(true);
    expect(p.calls[0]!.headers["accept"]).toBe("text/event-stream");
  });

  it("rebuilds multipart edits for the upstream", async () => {
    const p = pipeline(() => jsonResponse(IMAGE_RESPONSE));
    afterAll(p.dispose);
    const form = new FormData();
    form.append("model", "image-model");
    form.append("prompt", "edit it");
    form.append("n", "2");
    form.append("image[]", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "a.png");
    const response = await p.call("/v1/images/edits", { method: "POST", body: form });
    expect(response.status).toBe(200);
    expect(p.calls[0]!.url).toBe("https://upstream.test/v1/images/edits");
    const entries = JSON.parse(p.calls[0]!.body) as Array<[string, unknown]>;
    expect(entries[0]).toEqual(["model", "image-model"]);
    expect(entries).toContainEqual(["prompt", "edit it"]);
    expect(entries).toContainEqual(["n", "2"]);
    expect(entries).toContainEqual([
      "image[]",
      { filename: "image-0.png", type: "image/png", size: 3 },
    ]);
    // The transport adds the multipart boundary; no JSON content type may be forced.
    expect(p.calls[0]!.headers["content-type"]).toBeUndefined();
  });

  it("keeps JSON edits as JSON", async () => {
    const p = pipeline(() => jsonResponse(IMAGE_RESPONSE));
    afterAll(p.dispose);
    await p.call(
      "/v1/images/edits",
      postJson({
        model: "image-model",
        prompt: "edit",
        images: [{ image_url: "data:image/png;base64,AAAA" }],
      }),
    );
    expect(p.calls[0]!.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(p.calls[0]!.body).images).toEqual([
      { image_url: "data:image/png;base64,AAAA" },
    ]);
  });

  it("rejects unknown image models and surfaces upstream failures", async () => {
    const p = pipeline(() => jsonResponse({ error: { message: "no" } }, { status: 429 }));
    afterAll(p.dispose);

    const unknown = await p.call(
      "/v1/images/generations",
      postJson({ model: "not-an-image", prompt: "x" }),
    );

    expect(unknown.status).toBe(400);
    expect(p.calls).toHaveLength(0);

    const failed = await p.call(
      "/v1/images/generations",
      postJson({ model: "image-model", prompt: "x" }),
    );

    expect(failed.status).toBe(429);
  });

  it("answers 502 when the upstream returns no image output", async () => {
    const p = pipeline(() => jsonResponse({ data: [] }));
    afterAll(p.dispose);

    const response = await p.call(
      "/v1/images/generations",
      postJson({ model: "image-model", prompt: "x" }),
    );

    expect(response.status).toBe(502);
  });
});

describe("buildImagesApiResponse", () => {
  it("normalises formats, mime types and missing timestamps", () => {
    expect(
      buildImagesApiResponse(
        '{"data":[{"url":"https://x/i.png"},{"b64_json":"AA","output_format":"jpg"}]}',
        "b64_json",
        42,
      ),
    ).toEqual({
      out: '{"created":42,"data":[{"url":"https://x/i.png"},{"b64_json":"AA"}]}',
    });
    expect(
      buildImagesApiResponse('{"data":[{"b64_json":"AA","output_format":"jpg"}]}', "URL", 42),
    ).toEqual({
      out: '{"created":42,"data":[{"url":"data:image/jpeg;base64,AA"}]}',
    });
    expect(buildImagesApiResponse("nope", "url", 1)).toEqual({
      error: "upstream returned invalid image response JSON",
    });
  });
});
