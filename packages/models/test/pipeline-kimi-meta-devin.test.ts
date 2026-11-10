// End-to-end (workerd) through Access, model resolution, the credential picker, the executor registry and the
// conductor for the Kimi, Meta and Devin providers against mocked upstreams.
import { Effect, Layer } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import type { CredentialSnapshot } from "../src/executor/picker.ts";
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
