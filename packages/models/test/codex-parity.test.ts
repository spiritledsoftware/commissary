// Parity backlog (#29 part 2) for Codex: `resolveCodexModelIsCompat` config fallback and models.json override headers.
import { Effect, Result } from "effect";
import { describe, expect, it } from "vitest";
import { resolveCodexModelIsCompat } from "../src/executor/codex/compat.ts";
import { makeCodexExecutor } from "../src/executor/codex/executor.ts";
import { modelOverrideHeaders } from "../src/executor/helps/model-headers.ts";
import type { ThinkingModelInfo } from "@commissary/translation/thinking";
import { oauthCredential, providerKeyCredential } from "./support/codex.ts";
import { execute, harness, json, loadConfig, options } from "./support/executor-run.ts";
import { get, type Json, tryParseJson } from "@commissary/json";

const compatYaml = `
api-keys:
  codex:
    - base-url: https://codex.example.test/v1
      keys:
        - api-key: sk-codex-1
          models:
            - name: gpt-5.4
              alias: team-gpt
              is-compat: true
            - name: plain
`;

describe("resolveCodexModelIsCompat", () => {
  it("prefers the resolved model info", async () => {
    const config = await loadConfig(compatYaml);
    const credential = providerKeyCredential();
    const info: ThinkingModelInfo = { id: "gpt-5.4", isCompat: false };
    expect(
      resolveCodexModelIsCompat(
        config,
        credential,
        { model: "gpt-5.4", modelInfo: info },
        "gpt-5.4",
      ),
    ).toBe(false);
    expect(
      resolveCodexModelIsCompat(
        config,
        credential,
        { model: "plain", modelInfo: { id: "plain", isCompat: true } },
        "plain",
      ),
    ).toBe(true);
  });

  it("falls back to the credential's config entry by name or alias when no model info is bound", async () => {
    const config = await loadConfig(compatYaml);
    const credential = providerKeyCredential();
    expect(resolveCodexModelIsCompat(config, credential, { model: "team-gpt" }, "team-gpt")).toBe(
      true,
    );
    expect(
      resolveCodexModelIsCompat(config, credential, { model: "GPT-5.4(high)" }, "gpt-5.4"),
    ).toBe(true);
    // A configured models list is authoritative: unknown models are not compat.
    expect(resolveCodexModelIsCompat(config, credential, { model: "plain" }, "plain")).toBe(false);
    expect(resolveCodexModelIsCompat(config, credential, { model: "other" }, "other")).toBe(false);
  });

  it("is false without a config entry and honours config_index", async () => {
    const config = await loadConfig(compatYaml);
    expect(
      resolveCodexModelIsCompat(
        config,
        providerKeyCredential({ attributes: { api_key: "sk-unknown" } }),
        { model: "team-gpt" },
        "team-gpt",
      ),
    ).toBe(false);
    expect(
      resolveCodexModelIsCompat(
        config,
        providerKeyCredential({
          attributes: { config_index: "0", base_url: "https://codex.example.test/v1" },
        }),
        { model: "team-gpt" },
        "team-gpt",
      ),
    ).toBe(true);
  });
});

describe("models.json override_header", () => {
  it("copies the entry's headers with trimmed names and drops empty ones", () => {
    const lookup = (id: string): ThinkingModelInfo | undefined =>
      id === "m" ? { id, config: { overrideHeader: { " X-A ": "1", " ": "2" } } } : { id };

    expect(modelOverrideHeaders(lookup, "m")).toEqual({ "X-A": "1" });
    expect(modelOverrideHeaders(lookup, "other")).toBeUndefined();
    expect(modelOverrideHeaders(undefined, "m")).toBeUndefined();
  });

  it("forces the headers onto the upstream request from the attempt's registry lookup", async () => {
    const lookup = (id: string): ThinkingModelInfo | undefined =>
      id === "gpt-5.4"
        ? { id, config: { overrideHeader: { "X-Forced": "yes", "User-Agent": "custom-agent" } } }
        : undefined;

    const h = await harness(
      providerKeyCredential(),
      () =>
        new Response(
          `data: ${JSON.stringify({ type: "response.completed", response: { id: "r", status: "completed", output: [], usage: {} } })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );

    await execute(
      makeCodexExecutor(),
      h,
      { model: "gpt-5.4", payload: json({ model: "gpt-5.4", input: "hi" }), modelLookup: lookup },
      options({
        sourceFormat: "openai-response",
        metadata: { ...options().metadata, requestPath: "/v1/responses" },
      }),
    );
    expect(h.calls[0]?.headers["x-forced"]).toBe("yes");
    expect(h.calls[0]?.headers["user-agent"]).toBe("custom-agent");
  });
});

describe("Responses-Lite routing from the model's override_header", () => {
  const lookup = (id: string): ThinkingModelInfo | undefined =>
    id === "gpt-5.4"
      ? { id, config: { overrideHeader: { "X-OpenAI-Internal-Codex-Responses-Lite": "true" } } }
      : undefined;

  const completed = `data: ${JSON.stringify({ type: "response.completed", response: { id: "r", status: "completed", output: [], usage: {} } })}\n\n`;

  const run = async (payload: Json) => {
    const h = await harness(oauthCredential(), () => new Response(completed, { status: 200 }));

    const result = await Effect.runPromise(
      Effect.result(
        makeCodexExecutor()
          .execute(
            h.context,
            { model: "gpt-5.4", payload, modelLookup: lookup },
            options({
              sourceFormat: "openai-response",
              metadata: { ...options().metadata, requestPath: "/v1/responses" },
            }),
          )
          .pipe(Effect.provide(h.layers)),
      ),
    );

    return { h, result };
  };

  it("does not auto-inject the hosted tool", async () => {
    const { h, result } = await run(json({ model: "gpt-5.4", input: "hi" }));

    expect(Result.isSuccess(result)).toBe(true);
    expect(get(tryParseJson(h.calls[0]!.text), "tools")).toBeUndefined();
  });

  it("rejects a forced hosted image_generation before any upstream call", async () => {
    const { h, result } = await run(
      json({
        model: "gpt-5.4",
        input: "draw",
        tools: [{ type: "image_generation" }],
        tool_choice: { type: "image_generation" },
      }),
    );

    expect(Result.isFailure(result)).toBe(true);
    expect(h.calls).toHaveLength(0);
  });
});

describe("image tool usage (PublishAdditionalModel)", () => {
  const completed = (toolUsage: Json | undefined) =>
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "r",
        status: "completed",
        output: [],
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
        ...(toolUsage === undefined ? {} : { tool_usage: { image_gen: toolUsage } }),
      },
    })}\n\n`;

  const run = async (toolUsage: Json | undefined, tools: Json[]) => {
    const h = await harness(
      providerKeyCredential(),
      () => new Response(completed(toolUsage), { status: 200 }),
    );

    await execute(
      makeCodexExecutor(),
      h,
      { model: "gpt-5.4", payload: json({ model: "gpt-5.4", input: "draw", tools }) },
      options({
        sourceFormat: "openai-response",
        metadata: { ...options().metadata, requestPath: "/v1/responses" },
      }),
    );

    return h.usage.additionalRecords(1);
  };

  it("publishes the tool's tokens under the image_generation tool model as an extra record", async () => {
    const [record, ...rest] = await run({ input_tokens: 7, output_tokens: 3, total_tokens: 10 }, [
      { type: "image_generation", model: "gpt-image-1.5" },
    ]);

    expect(rest).toEqual([]);
    expect(record).toMatchObject({ model: "gpt-image-1.5", failed: false, provider: "codex" });
    expect(record?.detail).toMatchObject({ inputTokens: 7, outputTokens: 3, totalTokens: 10 });
    expect(record?.requestId).not.toBe("");
  });

  it("defaults the model and ignores a missing or empty tool usage", async () => {
    expect((await run({ input_tokens: 1, output_tokens: 1, total_tokens: 2 }, []))[0]?.model).toBe(
      "gpt-image-2",
    );
    expect(await run(undefined, [])).toEqual([]);
    expect(await run({ input_tokens: 0, output_tokens: 0, total_tokens: 0 }, [])).toEqual([]);
  });
});

// 51bde0ff: the direct Images API call keeps the resolved upstream model; only a model without a configured upstream
// is normalised to the builtin image model (the legacy routing-prefix behaviour).
describe("direct image requests keep the configured upstream model (51bde0ff)", () => {
  const yamlFor = (configured: string) => `
api-keys:
  codex:
    - base-url: https://codex.example.test/v1
      keys:
        - api-key: sk-codex-1
          models:
            - name: ${configured}
              alias: gpt-image-2
`;

  interface Case {
    readonly requested: string;
    readonly resolved: string;
    /** The credential's configured upstream model; empty for none. */
    readonly configured: string;
    readonly want: string;
  }

  const cases = {
    "a custom configured upstream": {
      requested: "gpt-image-2",
      resolved: "openai/gpt-image-2-cpr",
      configured: "openai/gpt-image-2-cpr",
      want: "openai/gpt-image-2-cpr",
    },
    "a prefixed builtin upstream": {
      requested: "gpt-image-2",
      resolved: "openai/gpt-image-2",
      configured: "openai/gpt-image-2",
      want: "openai/gpt-image-2",
    },
    "a case-sensitive upstream": {
      requested: "gpt-image-2",
      resolved: "OpenAI/GPT-Image-2",
      configured: "OpenAI/GPT-Image-2",
      want: "OpenAI/GPT-Image-2",
    },
    "another builtin upstream": {
      requested: "gpt-image-2",
      resolved: "gpt-image-1.5",
      configured: "gpt-image-1.5",
      want: "gpt-image-1.5",
    },
    "a routing-like configured prefix": {
      requested: "gpt-image-2",
      resolved: "codex/gpt-image-2",
      configured: "codex/gpt-image-2",
      want: "codex/gpt-image-2",
    },
    "a thinking suffix on the configured upstream": {
      requested: "tenant/gpt-image-2(high)",
      resolved: "OpenAI/GPT-Image-2(high)",
      configured: "OpenAI/GPT-Image-2",
      want: "OpenAI/GPT-Image-2",
    },
    "an unconfigured resolved model": {
      requested: "gpt-image-2",
      resolved: "openai/gpt-image-2-cpr",
      configured: "",
      want: "openai/gpt-image-2-cpr",
    },
    "a legacy builtin prefix without an upstream": {
      requested: "codex/gpt-image-1.5(high)",
      resolved: "codex/gpt-image-1.5(high)",
      configured: "",
      want: "gpt-image-1.5",
    },
    "a legacy builtin case without an upstream": {
      requested: "CODEX/GPT-Image-2(high)",
      resolved: "CODEX/GPT-Image-2(high)",
      configured: "",
      want: "gpt-image-2",
    },
  } satisfies Record<string, Case>;

  it.each(Object.entries(cases))("%s", async (_name, { requested, resolved, configured, want }) => {
    for (const path of ["/v1/images/generations", "/v1/images/edits"]) {
      const h = await harness(
        providerKeyCredential(),
        () => new Response('{"created":1,"data":[{"b64_json":"AA=="}]}', { status: 200 }),
        configured === "" ? undefined : yamlFor(configured),
      );

      await execute(
        makeCodexExecutor(),
        h,
        {
          model: resolved,
          payload: json({
            model: requested,
            prompt: "diagnostic",
            images: [{ image_url: "data:image/png;base64,AA==" }],
          }),
        },
        options({
          sourceFormat: "openai-image",
          metadata: { ...options().metadata, requestPath: path, requestedModel: requested },
        }),
      );

      const call = h.calls[0]!;

      expect(call.url).toBe(
        `https://codex.example.test/v1${path === "/v1/images/edits" ? "/images/edits" : "/images/generations"}`,
      );
      expect(get(tryParseJson(call.text), "model")).toBe(want);
    }
  });
});
