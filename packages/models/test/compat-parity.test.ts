// OpenAI-compatible parity (#29 part 2): text-only tool-result normalisation and derived prompt cache keys, against the
// real Go helpers (`go run ./tools/fixturegen/compatparity`) and through the executor.
import { describe, expect, it } from "vite-plus/test";
import type { OpenAICompatGroup } from "../src/config/schema.ts";
import { makeOpenAICompatExecutor } from "../src/executor/openai-compat/executor.ts";
import {
  normalizeToolResultsTextOnly,
  shouldNormalizeToolResults,
} from "../src/executor/helps/openai-compat-tool-results.ts";
import { get, type Json } from "@commissary/json";
import { credential, execute, harness, json, options } from "./support/executor-run.ts";
import fixtures from "./fixtures/compat-parity.json";

describe("normalizeToolResultsTextOnly (Go parity)", () => {
  for (const entry of fixtures.normalize) {
    it(entry.name, () => {
      const actual = normalizeToolResultsTextOnly(JSON.parse(entry.input) as Json);
      expect(JSON.stringify(actual)).toBe(JSON.stringify(JSON.parse(entry.output)));
    });
  }
});

describe("shouldNormalizeToolResults (Go parity)", () => {
  for (const entry of fixtures.models) {
    it(entry.name, () => {
      const group = {
        name: "g",
        "base-url": "u",
        keys: [],
        models: entry.models,
      } as unknown as OpenAICompatGroup;

      expect(shouldNormalizeToolResults(group, entry.upstream, entry.requested)).toBe(
        entry.normalize,
      );
    });
  }

  it("is false without a config group", () => {
    expect(shouldNormalizeToolResults(undefined, "m", "m")).toBe(false);
  });
});

const YAML = `
api-keys:
  openai-compatibility:
    - name: Mock
      base-url: https://upstream.test/v1
      support-prompt-cache-key: true
      models:
        - name: text-model
          input-modalities: [text]
        - name: vision-model
          input-modalities: [text, image]
      keys:
        - api-key: sk-test-1
`;

const mockCredential = () =>
  credential("openai-compatible-mock", {
    kind: "apikey",
    attributes: {
      base_url: "https://upstream.test/v1",
      api_key: "sk-test-1",
      compat_name: "Mock",
      config_index: "0",
    },
  });

const completion = () =>
  new Response(
    JSON.stringify({
      id: "c",
      object: "chat.completion",
      created: 1,
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const toolRequest = (model: string) =>
  json({
    model,
    messages: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
      },
      {
        role: "tool",
        tool_call_id: "c1",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      },
    ],
  });

describe("OpenAI-compatible executor parity", () => {
  it("flattens tool results for text-only models and leaves vision models untouched", async () => {
    const executor = makeOpenAICompatExecutor("openai-compatible-mock");

    for (const [model, expected] of [
      ["text-model", "a\n\nb"],
      [
        "vision-model",
        [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      ],
    ] as const) {
      const h = await harness(mockCredential(), completion, YAML);
      await execute(executor, h, { model, payload: toolRequest(model) }, options());
      expect(get(JSON.parse(h.calls[0]!.text) as Json, "messages.2.content")).toEqual(expected);
    }
  });

  it("derives a stable prompt_cache_key from the session identity (Go parity)", async () => {
    for (const entry of fixtures.promptCacheKeys) {
      const executor = makeOpenAICompatExecutor(entry.provider);
      const h = await harness(mockCredential(), completion, YAML);
      const base = options().metadata;

      const metadata = {
        ...base,
        ...(entry.derived !== undefined ? { derivedSessionId: entry.derived } : {}),
        ...(entry.execution !== undefined
          ? { websocket: { sessionId: entry.execution, requireUpstream: false } }
          : {}),
      };

      await execute(
        executor,
        h,
        {
          model: entry.model,
          payload: json({ model: entry.model, messages: [{ role: "user", content: "x" }] }),
        },
        options({ sourceFormat: entry.from, metadata }),
      );
      // Foreign protocols are translated to chat completions first; the key only depends on the source format.
      expect(get(JSON.parse(h.calls[0]!.text) as Json, "prompt_cache_key")).toBe(entry.key);
    }
  });

  it("keeps client keys, skips unknown sessions and respects support-prompt-cache-key", async () => {
    const executor = makeOpenAICompatExecutor("openai-compatible-mock");

    const request = (extra: Record<string, unknown>) => ({
      model: "m",
      payload: json({ model: "m", messages: [{ role: "user", content: "x" }], ...extra }),
    });

    const withSession = options({ metadata: { ...options().metadata, derivedSessionId: "s" } });
    const h1 = await harness(mockCredential(), completion, YAML);
    await execute(executor, h1, request({ prompt_cache_key: " client " }), withSession);
    expect(get(JSON.parse(h1.calls[0]!.text) as Json, "prompt_cache_key")).toBe("client");
    const h2 = await harness(mockCredential(), completion, YAML);
    await execute(executor, h2, request({}), options());
    expect(get(JSON.parse(h2.calls[0]!.text) as Json, "prompt_cache_key")).toBeUndefined();

    const h3 = await harness(
      mockCredential(),
      completion,
      YAML.replace("support-prompt-cache-key: true", ""),
    );

    await execute(executor, h3, request({}), withSession);
    expect(get(JSON.parse(h3.calls[0]!.text) as Json, "prompt_cache_key")).toBeUndefined();
  });
});
