// End-to-end tests (workerd) of the xAI media endpoints against a mocked upstream: images, videos (xAI-native and
// OpenAI-shaped, with the video -> credential binding in KV), text-to-speech and the client version cron task.
import { env } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Json } from "@commissary/json";
import type { ConfigReader } from "../src/config/reader.ts";
import type { Config } from "../src/config/schema.ts";
import { ModelProviders } from "../src/handlers/model-providers.ts";
import type { CredentialSnapshot } from "../src/executor/picker.ts";
import {
  currentXaiClientVersion,
  refreshXaiClientVersion,
  resetXaiClientVersionCache,
  XAI_FALLBACK_CLIENT_VERSION,
  XAI_VERSION_KV_KEY,
} from "../src/executor/xai/version.ts";
import { scheduledTasks } from "../src/scheduled-tasks.ts";
import {
  jsonResponse,
  loadConfig,
  makePipeline,
  postJson,
  type UpstreamResponder,
} from "./support/pipeline.ts";
import { xaiKey, xaiModels, xaiOauth, xaiPicker, type XaiPickerLog } from "./support/xai.ts";
import { type EnvServices, envContext } from "./support/context.ts";

let config: Config;

beforeAll(async () => {
  config = await loadConfig(`
requests:
  payload:
    override:
      - models: [{ name: "grok-imagine-image", protocol: openai }, { name: "grok-tts", protocol: openai }]
        params:
          "metadata.via": "payload-rule"
`);
});

const pipeline = (
  respond: UpstreamResponder,
  credentials: ReadonlyArray<CredentialSnapshot> = [xaiOauth()],
  overrides: {
    readonly config?: Config;
    readonly modelProviders?: Layer.Layer<ModelProviders, never, ConfigReader>;
  } = {},
) => {
  const log: XaiPickerLog = { picks: [], reports: [] };

  const p = makePipeline({
    config: overrides.config ?? config,
    respond,
    credentialPicker: xaiPicker(credentials, log),
    modelProviders: overrides.modelProviders ?? xaiModels,
  });

  afterAll(p.dispose);

  return { ...p, log };
};

const IMAGE_RESPONSE = {
  created: 1767225600,
  data: [{ b64_json: "aGVsbG8=", revised_prompt: "a cat", mime_type: "image/jpeg" }],
  usage: { total_tokens: 3 },
};

describe("images (xai models on /v1/images/*)", () => {
  it("converts generations to the xAI shape on the chat base URL and the answer back to the Images API", async () => {
    const p = pipeline(() => jsonResponse(IMAGE_RESPONSE));

    const response = await p.call(
      "/v1/images/generations",
      postJson({
        model: "xai/grok-imagine-image",
        prompt: " a cat ",
        size: "2048x2048",
        n: 2,
        quality: "high",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      created: 1767225600,
      data: [{ b64_json: "aGVsbG8=", revised_prompt: "a cat" }],
      usage: { total_tokens: 3 },
    });
    const call = p.calls[0]!;
    expect(call.url).toBe("https://cli-chat-proxy.grok.com/v1/images/generations");
    expect(call.headers["authorization"]).toBe("Bearer xai-access-1");
    // Media requests carry no CLI identity headers, even for OAuth credentials.
    expect(call.headers["x-xai-token-auth"]).toBeUndefined();
    expect(JSON.parse(call.body)).toEqual({
      model: "grok-imagine-image",
      prompt: "a cat",
      response_format: "b64_json",
      aspect_ratio: "1:1",
      resolution: "2k",
      quality: "high",
      n: 2,
      metadata: { via: "payload-rule" },
    });
  });

  it("returns data URLs for response_format=url and replays the result as SSE for stream requests", async () => {
    const p = pipeline(() => jsonResponse(IMAGE_RESPONSE), [xaiKey()]);

    const url = await p.call(
      "/v1/images/generations",
      postJson({ model: "grok-imagine-image", prompt: "p", response_format: "url" }),
    );

    expect(((await url.json()) as { data: Array<{ url: string }> }).data[0]?.url).toBe(
      "data:image/jpeg;base64,aGVsbG8=",
    );
    expect(p.calls[0]!.url).toBe("https://api.x.ai/v1/images/generations");

    const stream = await p.call(
      "/v1/images/generations",
      postJson({ model: "grok-imagine-image", prompt: "p", stream: true }),
    );

    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const text = await stream.text();
    expect(text).toContain("event: image_generation.completed");
    expect(text).toContain('"b64_json":"aGVsbG8="');
    expect(text).toContain('"usage":{"total_tokens":3}');
  });

  it("serves edits from JSON and multipart bodies", async () => {
    const p = pipeline(() => jsonResponse(IMAGE_RESPONSE));

    const one = await p.call(
      "/v1/images/edits",
      postJson({
        model: "grok-imagine-image-quality",
        prompt: "edit",
        images: [{ image_url: "https://img.test/a.png" }],
        size: "1792x1024",
      }),
    );

    expect(one.status).toBe(200);
    expect(p.calls[0]!.url).toBe("https://cli-chat-proxy.grok.com/v1/images/edits");
    expect(JSON.parse(p.calls[0]!.body)).toMatchObject({
      model: "grok-imagine-image-quality",
      aspect_ratio: "16:9",
      image: { type: "image_url", url: "https://img.test/a.png" },
    });

    const form = new FormData();
    form.set("model", "grok-imagine-image");
    form.set("prompt", "edit");
    form.set("image[]", new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" }));
    form.append("image[]", new File([new Uint8Array([4])], "b.png", { type: "image/png" }));
    const two = await p.call("/v1/images/edits", { method: "POST", body: form });
    expect(two.status).toBe(200);
    const body = JSON.parse(p.calls[1]!.body) as { images: Array<{ type: string; url: string }> };
    expect(body.images.map((image) => image.url)).toEqual([
      "data:image/png;base64,AQID",
      "data:image/png;base64,BA==",
    ]);

    const missing = await p.call(
      "/v1/images/edits",
      postJson({ model: "grok-imagine-image", prompt: "edit" }),
    );

    expect(missing.status).toBe(400);
  });

  it("answers 502 when the upstream returns no image and lists the xAI models for unknown ones", async () => {
    const p = pipeline(() => jsonResponse({ data: [] }));

    const empty = await p.call(
      "/v1/images/generations",
      postJson({ model: "grok-imagine-image", prompt: "p" }),
    );

    expect(empty.status).toBe(502);
    expect(await empty.text()).toContain("upstream did not return image output");

    const unknown = await p.call(
      "/v1/images/generations",
      postJson({ model: "nope", prompt: "p" }),
    );

    expect(unknown.status).toBe(400);
    expect(await unknown.text()).toContain("grok-imagine-image");
  });
});

/** Providers for exactly the `registered` ids (Go `registry.GetModelProviders`). */
const registeredModels = (registered: ReadonlyArray<string>) =>
  Layer.succeed(
    ModelProviders,
    ModelProviders.of({
      providersFor: (model) => Effect.succeed(registered.includes(model) ? ["xai"] : []),
      firstAvailableModel: Effect.undefined,
    }),
  );

describe("image model prefixes (45ccd9c3, 8a3e7622)", () => {
  const FORCE = "routing:\n  force-model-prefix: true\n";
  const image = "grok-imagine-image-2.0";

  const run = async (
    yaml: string,
    registered: ReadonlyArray<string>,
    model: string,
    path = "/v1/images/generations",
  ) => {
    const p = pipeline(() => jsonResponse(IMAGE_RESPONSE), [xaiKey({ id: "xai-key-img" })], {
      config: await loadConfig(yaml),
      modelProviders: registeredModels(registered),
    });

    const body = path.endsWith("edits")
      ? { model, prompt: "p", images: [{ image_url: "https://img.test/a.png" }] }
      : { model, prompt: "p" };

    const response = await p.call(path, postJson(body));

    return { response, picks: p.log.picks, calls: p.calls };
  };

  it("routes a registered custom credential prefix and sends the canonical model upstream", async () => {
    for (const path of ["/v1/images/generations", "/v1/images/edits"]) {
      const { response, picks, calls } = await run(
        FORCE,
        [`my-xai/${image}`],
        `my-xai/${image}`,
        path,
      );

      expect(response.status).toBe(200);
      expect(picks[0]?.model).toBe(`my-xai/${image}`);
      expect(JSON.parse(calls[0]!.body).model).toBe(image);
    }
  });

  it("keeps a built-in prefix when a credential registers it, case aside", async () => {
    const { response, picks } = await run(FORCE, [`xai/${image}`], `XAI/Grok-Imagine-Image-2.0`);
    expect(response.status).toBe(200);
    expect(picks[0]?.model).toBe(`xai/${image}`);
  });

  it("falls back to the unprefixed model for built-in aliases, even under force-model-prefix", async () => {
    for (const yaml of ["", FORCE]) {
      for (const alias of ["xai", "x-ai", "grok"]) {
        const { response, picks } = await run(yaml, [image], `${alias}/${image}`);
        expect(response.status).toBe(200);
        expect(picks[0]?.model).toBe(image);
      }
    }
  });

  it("rejects a built-in alias when only a custom prefix is registered under force-model-prefix", async () => {
    const { response, picks } = await run(FORCE, [`my-xai/${image}`], `xai/${image}`);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(`unknown provider for model xai/${image}`);
    expect(picks).toHaveLength(0);
  });

  it("rejects an unregistered custom prefix as an unsupported model", async () => {
    const { response } = await run("", [image], `nobody/${image}`);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("is not supported on /v1/images/generations");
  });
});

describe("image payload rules (826bb167)", () => {
  const DEFAULTS = `payload:
  default:
    - models: [{ name: "grok-imagine-*", protocol: openai }]
      params:
        response_format: url
        aspect_ratio: "16:9"
        resolution: 2k
`;

  const run = async (path: string, body: Json) => {
    const p = pipeline(() => jsonResponse(IMAGE_RESPONSE), [xaiKey({ id: "xai-key-img" })], {
      config: await loadConfig(DEFAULTS),
    });

    const response = await p.call(path, postJson(body));

    return { response, upstream: JSON.parse(p.calls[0]!.body) as Record<string, unknown> };
  };

  it("applies default rules to the fields the client omitted and formats the answer by the finalized response_format", async () => {
    const { response, upstream } = await run("/v1/images/generations", {
      model: "grok-imagine-image",
      prompt: "a cat",
    });

    expect(upstream).toMatchObject({
      response_format: "url",
      aspect_ratio: "16:9",
      resolution: "2k",
    });
    const body = (await response.json()) as { data: Array<Record<string, string>> };
    expect(body.data[0]).toEqual({
      url: "data:image/jpeg;base64,aGVsbG8=",
      revised_prompt: "a cat",
    });
  });

  it("keeps what the client set, including values equal to the handler defaults", async () => {
    const { response, upstream } = await run("/v1/images/generations", {
      model: "grok-imagine-image",
      prompt: "a cat",
      response_format: "b64_json",
      aspect_ratio: "1:1",
      resolution: "1k",
    });

    expect(upstream).toMatchObject({
      response_format: "b64_json",
      aspect_ratio: "1:1",
      resolution: "1k",
    });
    expect(
      ((await response.json()) as { data: Array<Record<string, string>> }).data[0],
    ).toHaveProperty("b64_json");
  });

  it("applies default rules on edits and to streamed results", async () => {
    const edit = await run("/v1/images/edits", {
      model: "grok-imagine-image",
      prompt: "p",
      images: [{ image_url: "https://img.test/a.png" }],
    });

    expect(edit.upstream).toMatchObject({
      response_format: "url",
      aspect_ratio: "16:9",
      resolution: "2k",
    });

    const stream = await run("/v1/images/generations", {
      model: "grok-imagine-image",
      prompt: "p",
      stream: true,
    });

    expect(stream.upstream).toMatchObject({ response_format: "url" });
    expect(await stream.response.text()).toContain('"url":"data:image/jpeg;base64,aGVsbG8="');
  });
});

const VIDEO_CREATED = { request_id: "req_1" };

const VIDEO_DONE = {
  status: "done",
  model: "grok-imagine-video",
  progress: 100,
  video: { url: "https://cdn.example.test/v.mp4", duration: 8 },
};

describe("videos", () => {
  it("creates xAI-native videos, forwards the idempotency key and binds the video to the serving credential", async () => {
    const p = pipeline(() => jsonResponse(VIDEO_CREATED), [xaiKey({ id: "xai-key-2" })]);

    const response = await p.call(
      "/v1/videos",
      postJson(
        {
          model: "grok-imagine-video",
          prompt: "a wave",
          image: { image_url: "https://img.test/a.png" },
        },
        { "x-idempotency-key": "idem-1" },
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(VIDEO_CREATED);
    const call = p.calls[0]!;
    expect(call.url).toBe("https://api.x.ai/v1/videos/generations");
    expect(call.method).toBe("POST");
    expect(call.headers["x-idempotency-key"]).toBe("idem-1");
    // image_url references are rewritten to the xAI field name.
    expect(JSON.parse(call.body)).toMatchObject({
      model: "grok-imagine-video",
      image: { url: "https://img.test/a.png" },
    });

    // Retrieval is pinned to the creating credential even though another one is available first.
    const other = pipeline(
      () => jsonResponse(VIDEO_DONE),
      [xaiOauth({ id: "xai-oauth-9" }), xaiKey({ id: "xai-key-2" })],
    );

    const poll = await other.call("/v1/videos/req_1");
    expect(poll.status).toBe(200);
    expect(await poll.json()).toEqual(VIDEO_DONE);
    expect(other.log.picks[0]?.pinnedId).toBe("xai-key-2");
    expect(other.calls[0]!.method).toBe("GET");
    expect(other.calls[0]!.url).toBe("https://api.x.ai/v1/videos/req_1");
    expect(other.calls[0]!.body).toBe("");

    // The binding expires after multimedia.video-result-auth-cache-ttl (3 h by default).
    const listed = await env.CACHE.list({ prefix: "xai/video-binding/" });
    const expiration = listed.keys[0]?.expiration ?? 0;
    expect(expiration - Math.floor(Date.now() / 1000)).toBeGreaterThan(3 * 3600 - 120);
    expect(expiration - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(3 * 3600);
  });

  it("rejects non-xAI models on the native routes and serves edits/extensions paths", async () => {
    const p = pipeline(() => jsonResponse(VIDEO_CREATED));
    const bad = await p.call("/v1/videos/generations", postJson({ model: "sora-2", prompt: "p" }));
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("Use grok-imagine-video");
    await p.call(
      "/v1/videos/edits",
      postJson({ prompt: "p", video: { url: "https://v.test/x.mp4" } }),
    );
    await p.call(
      "/v1/videos/extensions",
      postJson({ model: "grok-imagine-video-1.5", prompt: "p" }),
    );
    expect(p.calls.map((call) => call.url)).toEqual([
      "https://cli-chat-proxy.grok.com/v1/videos/edits",
      "https://cli-chat-proxy.grok.com/v1/videos/extensions",
    ]);
    expect(JSON.parse(p.calls[1]!.body).model).toBe("grok-imagine-video-1.5");
  });

  it("maps OpenAI video requests to xAI and xAI results back, including content downloads", async () => {
    const mp4 = new Uint8Array([0, 1, 2, 3, 255]);

    const p = pipeline(
      (call) => {
        if (call.url.startsWith("https://cdn.example.test/")) {
          return new Response(mp4, {
            headers: { "content-type": "video/mp4", "content-length": "5", etag: "abc" },
          });
        }

        return call.method === "POST"
          ? jsonResponse({ request_id: "req_77", status: "pending" })
          : jsonResponse(VIDEO_DONE);
      },
      [xaiKey({ id: "xai-key-3" })],
    );

    const created = await p.call(
      "/openai/v1/videos",
      postJson({ model: "sora-2", prompt: "a wave", seconds: "20", size: "1280x720" }),
    );

    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as Record<string, unknown>;
    expect(createdBody).toMatchObject({
      id: "req_77",
      object: "video",
      model: "grok-imagine-video",
      prompt: "a wave",
      seconds: "15",
      size: "1280x720",
      status: "queued",
      progress: 0,
    });
    expect(JSON.parse(p.calls[0]!.body)).toEqual({
      model: "grok-imagine-video",
      prompt: "a wave",
      duration: 15,
      aspect_ratio: "16:9",
      resolution: "720p",
    });

    const retrieved = await p.call("/openai/v1/videos/req_77");
    expect(await retrieved.json()).toEqual({
      object: "video",
      id: "req_77",
      model: "grok-imagine-video",
      status: "completed",
      progress: 100,
      seconds: "8",
      video_url: "https://cdn.example.test/v.mp4",
    });

    const content = await p.call("/openai/v1/videos/req_77/content");
    expect(content.status).toBe(200);
    expect(content.headers.get("content-type")).toBe("video/mp4");
    expect(content.headers.get("etag")).toBe("abc");
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(mp4);
    expect(p.log.picks.slice(1).every((pick) => pick.pinnedId === "xai-key-3")).toBe(true);
    expect(p.calls.at(-1)!.url).toBe("https://cdn.example.test/v.mp4");

    const variant = await p.call("/openai/v1/videos/req_77/content?variant=thumbnail");
    expect(variant.status).toBe(400);
  });

  it("serves Grok Imagine Video 1.5 Lite at 1080p and reports the bound model on retrieve (f0ddc38f, c69cdd93)", async () => {
    const p = pipeline(
      (call) =>
        call.method === "POST"
          ? jsonResponse({ request_id: "req_lite", status: "pending" })
          : jsonResponse({ status: "done", video: { url: "https://cdn.example.test/lite.mp4" } }),
      [xaiKey({ id: "xai-key-lite" })],
    );

    for (const model of ["grok-imagine-video-1.5-lite", "xai/grok-imagine-video-1.5-lite"]) {
      const created = await p.call(
        "/openai/v1/videos",
        postJson({ model, prompt: "a wave", resolution: "1080p" }),
      );

      expect(created.status).toBe(200);
      expect(await created.json()).toMatchObject({
        id: "req_lite",
        model: "grok-imagine-video-1.5-lite",
      });
    }

    expect(p.calls.map((call) => JSON.parse(call.body))).toEqual([
      expect.objectContaining({ model: "grok-imagine-video-1.5-lite", resolution: "1080p" }),
      expect.objectContaining({ model: "grok-imagine-video-1.5-lite", resolution: "1080p" }),
    ]);

    const native = await p.call(
      "/v1/videos/generations",
      postJson({ model: "grok/grok-imagine-video-1.5-lite", prompt: "p" }),
    );

    expect(native.status).toBe(200);
    expect(JSON.parse(p.calls[2]!.body).model).toBe("grok-imagine-video-1.5-lite");

    const retrieved = await p.call("/openai/v1/videos/req_lite");
    expect(await retrieved.json()).toMatchObject({
      id: "req_lite",
      model: "grok-imagine-video-1.5-lite",
      status: "completed",
    });

    const foreign = await p.call(
      "/openai/v1/videos",
      postJson({ model: "codex/grok-imagine-video-1.5-lite", prompt: "p" }),
    );

    expect(foreign.status).toBe(400);
  });

  it("answers OpenAI validation errors with failed video objects", async () => {
    const p = pipeline(() => jsonResponse(VIDEO_CREATED));
    const size = await p.call("/openai/v1/videos", postJson({ prompt: "p", size: "10x10" }));
    expect(size.status).toBe(400);
    expect(await size.json()).toMatchObject({
      object: "video",
      status: "failed",
      error: {
        code: "invalid_request_error",
        message: expect.stringContaining("size must be one of"),
      },
    });

    const model = await p.call(
      "/openai/v1/videos",
      postJson({ model: "gpt-image-2", prompt: "p" }),
    );

    expect(model.status).toBe(400);
    const prompt = await p.call("/openai/v1/videos", postJson({}));
    expect(((await prompt.json()) as { error: { message: string } }).error.message).toContain(
      "prompt is required",
    );
    expect(p.calls).toHaveLength(0);
  });
});

describe("speech", () => {
  const AUDIO = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x80, 0xfe]);

  it("maps OpenAI speech requests to /tts on the official API and returns the audio verbatim", async () => {
    const p = pipeline(
      () => new Response(AUDIO, { headers: { "content-type": "application/octet-stream" } }),
    );

    const response = await p.call(
      "/v1/audio/speech",
      postJson({
        model: "tts-1",
        input: "hello",
        voice: "nova",
        response_format: "wav",
        speed: 1.25,
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/wav");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(AUDIO);
    const call = p.calls[0]!;
    // /tts never goes to the CLI chat proxy, even for OAuth credentials.
    expect(call.url).toBe("https://api.x.ai/v1/tts");
    expect(call.headers["accept"]).toBe("*/*");
    expect(call.headers["authorization"]).toBe("Bearer xai-access-1");
    expect(JSON.parse(call.body)).toEqual({
      text: "hello",
      voice_id: "eve",
      language: "auto",
      speed: 1.25,
      output_format: { codec: "wav", sample_rate: 24000 },
      metadata: { via: "payload-rule" },
    });

    const tts = await p.call(
      "/v1/tts",
      postJson({ input: "hi", voice: "custom-voice", language: "de" }),
    );

    expect(tts.headers.get("content-type")).toBe("audio/mpeg");
    expect(JSON.parse(p.calls[1]!.body)).toMatchObject({
      voice_id: "custom-voice",
      language: "de",
    });
  });

  it("validates requests", async () => {
    const p = pipeline(() => new Response(AUDIO));
    const model = await p.call("/v1/audio/speech", postJson({ model: "whisper-1", input: "x" }));
    expect(model.status).toBe(400);
    expect(await model.text()).toContain(
      "Model whisper-1 is not supported on /v1/audio/speech. Use grok-tts.",
    );
    expect((await p.call("/v1/audio/speech", postJson({ input: " " }))).status).toBe(400);
    expect(
      (await p.call("/v1/audio/speech", postJson({ input: "x", response_format: "flac" }))).status,
    ).toBe(400);
    expect((await p.call("/v1/audio/speech", postJson({ input: "x".repeat(60001) }))).status).toBe(
      400,
    );
    expect(p.calls).toHaveLength(0);
  });

  it("treats unknown-voice 404s as request-scoped but fails over on model unavailability", async () => {
    const voice = pipeline(
      () => new Response('{"error":"unknown voice_id"}', { status: 404 }),
      [xaiKey({ id: "a" }), xaiKey({ id: "b" })],
    );

    const response = await voice.call("/v1/audio/speech", postJson({ input: "x" }));
    expect(response.status).toBe(404);
    expect(voice.calls).toHaveLength(1);

    const model = pipeline(
      () => new Response('{"error":"model not available for your plan"}', { status: 404 }),
      [xaiKey({ id: "a" }), xaiKey({ id: "b" })],
    );

    const failed = await model.call("/v1/audio/speech", postJson({ input: "x" }));
    expect(failed.status).toBe(404);
    expect(model.calls).toHaveLength(2);
  });
});

const registry = (respond: () => Response) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => Effect.sync(() => HttpClientResponse.fromWeb(request, respond()))),
  );

describe("client version task", () => {
  const run = <A>(
    effect: Effect.Effect<A, never, HttpClient.HttpClient | EnvServices>,
    respond: () => Response,
  ) =>
    Effect.runPromise(
      effect.pipe(Effect.provide(registry(respond)), Effect.provideContext(envContext(env))),
    );

  it("is registered in the cron task list", () => {
    expect(scheduledTasks.map((task) => task.name)).toContain("xai-client-version-refresh");
  });

  it("stores an acceptable npm version in KV and serves it to request handling", async () => {
    resetXaiClientVersionCache();
    expect(
      await Effect.runPromise(currentXaiClientVersion.pipe(Effect.provideContext(envContext(env)))),
    ).toBe(XAI_FALLBACK_CLIENT_VERSION);

    const stored = await run(refreshXaiClientVersion("https://registry.test/latest"), () =>
      jsonResponse({ version: "1.2.3" }),
    );

    expect(stored).toBe("1.2.3");
    expect(await env.CACHE.get(XAI_VERSION_KV_KEY)).toBe("1.2.3");
    resetXaiClientVersionCache();
    expect(
      await Effect.runPromise(currentXaiClientVersion.pipe(Effect.provideContext(envContext(env)))),
    ).toBe("1.2.3");
    await env.CACHE.delete(XAI_VERSION_KV_KEY);
    resetXaiClientVersionCache();
  });

  it("keeps the stored version for failures, pre-release tags and versions below the server floor", async () => {
    await env.CACHE.put(XAI_VERSION_KV_KEY, "1.0.50");
    expect(
      await run(refreshXaiClientVersion(), () => new Response("boom", { status: 500 })),
    ).toBeUndefined();
    expect(
      await run(refreshXaiClientVersion(), () => jsonResponse({ version: "1.0.51-alpha.1" })),
    ).toBeUndefined();
    expect(
      await run(refreshXaiClientVersion(), () => jsonResponse({ version: "1.0.12" })),
    ).toBeUndefined();
    expect(await run(refreshXaiClientVersion(), () => jsonResponse({}))).toBeUndefined();
    expect(await env.CACHE.get(XAI_VERSION_KV_KEY)).toBe("1.0.50");
    await env.CACHE.delete(XAI_VERSION_KV_KEY);
    resetXaiClientVersionCache();
  });
});

describe("xAI image edit options (Go drops Codex-only mask / input_fidelity)", () => {
  it("builds the xAI edit body from size/quality/n only", async () => {
    const { buildEditRequest } = await import("../src/handlers/openai/xai-images.ts");

    const body = buildEditRequest(
      {
        prompt: "p",
        size: "1024x1792",
        quality: "high",
        n: 2,
        mask: { image_url: "data:image/png;base64,AAAA" },
        input_fidelity: "high",
        output_format: "png",
      },
      "grok-imagine-image",
      "b64_json",
      ["data:image/png;base64,BBBB"],
    );

    expect(body).toEqual({
      model: "grok-imagine-image",
      prompt: "p",
      response_format: "b64_json",
      aspect_ratio: "9:16",
      quality: "high",
      n: 2,
      image: { type: "image_url", url: "data:image/png;base64,BBBB" },
    });
  });
});
