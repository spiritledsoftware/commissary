// The outbound guard on the client API (ADR 0044): a request through a provider key whose `base_url` the guard refuses
// (stored before the guard existed) is answered with the guard's message, and never reaches the address.
import { afterEach, describe, expect, it } from "vitest";
import { OUTBOUND_REFUSED_MESSAGE } from "@commissary/core";
import {
  jsonResponse,
  loadConfig,
  makePipeline,
  type PipelineHarness,
  type PipelineOptions,
  postJson,
} from "./support/pipeline.ts";

const open: Array<PipelineHarness> = [];

/** A pipeline disposed after the test, whatever it asserted. */
const pipelineOf = (options: PipelineOptions): PipelineHarness => {
  const pipeline = makePipeline(options);
  open.push(pipeline);

  return pipeline;
};

afterEach(async () => {
  await Promise.all(open.splice(0).map((pipeline) => pipeline.dispose()));
});

const configWith = (baseUrl: string) =>
  loadConfig(`
api-keys:
  openai-compatibility:
    - name: Mock
      base-url: ${baseUrl}
      models:
        - name: upstream-model
      keys:
        - api-key: sk-test-1
`);

const COMPLETION = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1700000000,
  model: "upstream-model",
  choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

const chat = postJson({ model: "upstream-model", messages: [{ role: "user", content: "hi" }] });

describe("outbound guard on the client API", () => {
  it.each(["http://api.example.com/v1", "https://10.0.0.5/v1", "https://[fd00::1]/v1"])(
    "refuses a request through a provider key with base_url %s",
    async (baseUrl) => {
      const pipeline = pipelineOf({
        config: await configWith(baseUrl),
        respond: () => jsonResponse(COMPLETION),
      });

      const response = await pipeline.call("/v1/chat/completions", chat);
      const body = await response.text();

      expect(response.status).toBe(400);
      expect(body).toContain(OUTBOUND_REFUSED_MESSAGE);
      expect(pipeline.calls).toEqual([]);
    },
  );

  it("refuses a redirect from a public base_url to a refused address", async () => {
    const pipeline = pipelineOf({
      config: await configWith("https://api.example.com/v1"),
      respond: () =>
        new Response(null, {
          status: 307,
          headers: { location: "https://169.254.169.254/latest/meta-data/" },
        }),
    });

    const response = await pipeline.call("/v1/chat/completions", chat);

    expect(response.status).toBe(400);
    expect(await response.text()).toContain(OUTBOUND_REFUSED_MESSAGE);
    expect(pipeline.calls.map((call) => call.url)).toEqual([
      "https://api.example.com/v1/chat/completions",
    ]);
  });

  it("serves a public https base_url as before", async () => {
    const pipeline = pipelineOf({
      config: await configWith("https://api.example.com/v1"),
      respond: () => jsonResponse(COMPLETION),
    });

    const response = await pipeline.call("/v1/chat/completions", chat);

    expect(response.status).toBe(200);
  });
});
