import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { asString, exists, get, type Json } from "@commissary/json";
import {
  applyPayloadRules,
  type DisableImageGenerationMode,
  matchModelPattern,
  PayloadConfig,
  type PayloadRequest,
  type PayloadRulesConfig,
  payloadModelCandidates,
  resolvePayloadRulePaths,
} from "../../src/config/payload/index.ts";
import fixtures from "../fixtures/payload-rules.json";

const decodePayload = Schema.decodeUnknownSync(PayloadConfig);

const makeConfig = (
  payload: Json,
  disable: DisableImageGenerationMode = false,
): PayloadRulesConfig => ({
  requests: { payload: decodePayload(payload) },
  multimedia: { "disable-image-generation": disable },
});

const apply = (
  payload: Json,
  request: PayloadRequest,
  body: Json,
  disable: DisableImageGenerationMode = false,
): Json => applyPayloadRules(makeConfig(payload, disable), request, body).payload;

// Golden cases generated from helps.ApplyPayloadConfigWithTrackedPathsForExecutor by
// `go run ./tools/fixturegen/payload`.
describe("payload rules parity (golden fixtures)", () => {
  for (const c of fixtures) {
    it(c.name, () => {
      const v8 = c.config as {
        requests: { payload: Json };
        multimedia?: { "disable-image-generation": DisableImageGenerationMode };
      };

      const config = makeConfig(
        v8.requests.payload,
        v8.multimedia?.["disable-image-generation"] ?? false,
      );

      const request: PayloadRequest = {
        model: c.request.model,
        protocol: c.request.protocol,
        ...(c.request.requestedModel !== undefined
          ? { requestedModel: c.request.requestedModel }
          : {}),
        ...(c.request.fromProtocol !== undefined ? { fromProtocol: c.request.fromProtocol } : {}),
        ...(c.request.root !== undefined ? { root: c.request.root } : {}),
        ...(c.request.requestPath !== undefined ? { requestPath: c.request.requestPath } : {}),
        ...(c.request.headers !== undefined ? { headers: c.request.headers } : {}),
        ...(c.request.trackedPaths !== undefined ? { trackedPaths: c.request.trackedPaths } : {}),
        ...(c.original !== undefined ? { original: structuredClone(c.original) } : {}),
      };

      const result = applyPayloadRules(config, request, structuredClone(c.payload));
      expect(result.payload).toEqual(c.out);
      expect([...result.touched].toSorted()).toEqual(c.touched);
    });
  }
});

// Ported from internal/runtime/executor/helps/payload_helpers_disable_image_generation_test.go and
// payload_finalizer_test.go.
describe("payload rules (ported Go tests)", () => {
  const headerRule = {
    override: [
      {
        models: [
          { name: "gpt-*", protocol: "openai", headers: { "X-Client-Tier": "tenant-*-region-*" } },
        ],
        params: { "metadata.enabled": true },
      },
    ],
  };

  it("header gate requires wildcard match", () => {
    const request = (tier: string): PayloadRequest => ({
      model: "gpt-5.4",
      protocol: "openai",
      fromProtocol: "responses",
      headers: new Headers({ "X-Client-Tier": tier }),
    });

    expect(
      get(
        apply(headerRule, request("tenant-alpha-region-us"), { model: "gpt-5.4" }),
        "metadata.enabled",
      ),
    ).toBe(true);
    expect(
      exists(apply(headerRule, request("tenant-alpha"), { model: "gpt-5.4" }), "metadata.enabled"),
    ).toBe(false);
  });

  it("header gate accepts plain records with multi-valued headers", () => {
    const out = apply(
      headerRule,
      {
        model: "gpt-5.4",
        protocol: "openai",
        headers: { "x-client-tier": ["other", "tenant-a-region-b"] },
      },
      { model: "gpt-5.4" },
    );

    expect(get(out, "metadata.enabled")).toBe(true);
  });

  it("disable-image-generation removes tools entries with root", () => {
    const out = apply(
      {},
      { model: "gpt-5.4", protocol: "antigravity", root: "request" },
      { request: { tools: [{ type: "image_generation" }, { type: "web_search" }] } },
      true,
    );

    expect(get(out, "request.tools")).toEqual([{ type: "web_search" }]);
  });

  it("disable-image-generation removes tool_choice by type and by name", () => {
    const byType = apply(
      {},
      { model: "gpt-5.4", protocol: "openai-response" },
      {
        tools: [{ type: "image_generation" }, { type: "function", name: "f1" }],
        tool_choice: { type: "image_generation" },
      },
      true,
    );

    expect(exists(byType, "tool_choice")).toBe(false);

    const byName = apply(
      {},
      { model: "gpt-5.4", protocol: "antigravity", root: "request" },
      {
        request: {
          tools: [{ type: "image_generation" }],
          tool_choice: { type: "tool", name: "image_generation" },
        },
      },
      true,
    );

    expect(exists(byName, "request.tool_choice")).toBe(false);
  });

  it("chat mode keeps image_generation on images endpoints, passthrough never strips", () => {
    const body = (): Json => ({
      tools: [{ type: "image_generation" }, { type: "function", name: "f1" }],
      tool_choice: { type: "image_generation" },
    });

    const chatImages = apply(
      {},
      { model: "m", protocol: "x", requestPath: "/v1/images/generations" },
      body(),
      "chat",
    );

    expect(get(chatImages, "tools.#")).toBe(2);
    expect(exists(chatImages, "tool_choice")).toBe(true);

    const chatResponses = apply(
      {},
      { model: "m", protocol: "x", requestPath: "/v1/responses" },
      body(),
      "chat",
    );

    expect(get(chatResponses, "tools.#")).toBe(1);

    for (const requestPath of ["", "/v1/responses", "/v1/images/generations"]) {
      const out = apply({}, { model: "m", protocol: "x", requestPath }, body(), "passthrough");
      expect(get(out, "tools.#")).toBe(2);
      expect(asString(get(out, "tools.0.type"))).toBe("image_generation");
      expect(exists(out, "tool_choice")).toBe(true);
    }
  });

  it("payload override can restore image_generation after built-in stripping", () => {
    const out = apply(
      {
        "override-raw": [
          {
            models: [{ name: "gpt-5.4", protocol: "openai-response" }],
            params: {
              tools: '[{"type":"image_generation"},{"type":"function","name":"f1"}]',
              tool_choice: '{"type":"image_generation"}',
            },
          },
        ],
      },
      { model: "gpt-5.4", protocol: "openai-response" },
      {
        tools: [{ type: "image_generation" }, { type: "function", name: "f1" }],
        tool_choice: { type: "image_generation" },
      },
      true,
    );

    expect(get(out, "tools.#")).toBe(2);
    expect(get(out, "tool_choice.type")).toBe("image_generation");
  });

  it("defaults use the original payload and user rules run on the final body (TestPayloadFinalizerDefaultsUseOriginal...)", () => {
    const rules = {
      default: [
        {
          models: [
            {
              name: "alias",
              protocol: "openai",
              "from-protocol": "claude",
              headers: { "X-Test": "yes" },
            },
          ],
          params: { missing: "user default", present: "not applied" },
        },
      ],
      override: [
        {
          models: [{ name: "alias" }],
          params: { "tools.0.function.parameters.properties.count.type": "number" },
        },
      ],
      filter: [{ models: [{ name: "alias" }], params: ["late"] }],
    };

    const out = apply(
      rules,
      {
        model: "upstream",
        requestedModel: "alias",
        protocol: "openai",
        fromProtocol: "claude",
        headers: { "X-Test": "yes", "User-Agent": "codex-cli/0.1" },
        original: { present: "caller" },
      },
      {
        missing: "built-in",
        present: "caller",
        late: "injected",
        tools: [
          {
            type: "function",
            function: {
              name: "f",
              parameters: { type: "object", properties: { count: { type: "integer" } } },
            },
          },
        ],
      },
    );

    expect(get(out, "missing")).toBe("user default");
    expect(get(out, "present")).toBe("caller");
    expect(exists(out, "late")).toBe(false);
    expect(get(out, "tools.0.function.parameters.properties.count.type")).toBe("number");
  });

  it("rules match the final body and track paths (TestPayloadRulesMatchFinalBodyAndTrackPaths)", () => {
    const rules = {
      override: [
        { models: [{ name: "*", match: [{ max_tokens: 100 }] }], params: { unexpected: true } },
        {
          models: [{ name: "*", match: [{ max_tokens: 300 }] }],
          params: { "diagnostics.user": true },
        },
      ],
      filter: [
        {
          models: [{ name: "*", match: [{ max_tokens: 300 }] }],
          params: ["context_management", "messages.0"],
        },
      ],
    };

    const result = applyPayloadRules(
      makeConfig(rules),
      {
        model: "model",
        protocol: "claude",
        fromProtocol: "claude",
        original: { max_tokens: 100, messages: [{}, {}] },
        trackedPaths: ["diagnostics", "context_management"],
      },
      { max_tokens: 300, context_management: { builtin: true }, messages: [{}, {}, {}] },
    );

    expect(exists(result.payload, "unexpected")).toBe(false);
    expect(get(result.payload, "diagnostics.user")).toBe(true);
    expect(exists(result.payload, "context_management")).toBe(false);
    expect(get(result.payload, "messages.#")).toBe(2);
    expect([...result.touched].toSorted()).toEqual(["context_management", "diagnostics"]);
  });

  it("conditions evaluate once per rule against the current body (TestClaudePayloadConditionsEvaluateOnceAtFinalBarrier)", () => {
    const rules = {
      override: [
        {
          models: [{ name: "*", match: [{ max_tokens: 100 }] }],
          params: { max_tokens: 200, temperature: 0.2, diagnostics: { user: true } },
        },
        { models: [{ name: "*", match: [{ max_tokens: 200 }] }], params: { top_p: 0.4 } },
      ],
      filter: [{ models: [{ name: "*", match: [{ max_tokens: 200 }] }], params: ["messages.0"] }],
    };

    const out = apply(
      rules,
      { model: "claude-opus-5", protocol: "claude" },
      {
        model: "claude-opus-5",
        max_tokens: 100,
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "second" },
          { role: "user", content: "third" },
        ],
      },
    );

    expect(get(out, "max_tokens")).toBe(200);
    expect(get(out, "temperature")).toBe(0.2);
    expect(get(out, "top_p")).toBe(0.4);
    expect(get(out, "diagnostics.user")).toBe(true);
    expect(get(out, "messages.#")).toBe(2);
  });

  it("observes built-in removal in conditions (TestClaudePayloadConditionsObserveBuiltinThinkingRemoval)", () => {
    const present = [{ name: "*", exist: ["thinking"] }];
    const absent = [{ name: "*", "not-exist": ["thinking"] }];

    const rules = {
      default: [
        { models: absent, params: { default_matched: true } },
        { models: present, params: { default_unmatched: true } },
      ],
      "default-raw": [
        { models: absent, params: { default_raw_matched: "true" } },
        { models: present, params: { default_raw_unmatched: "true" } },
      ],
      override: [
        { models: absent, params: { override_matched: true } },
        { models: present, params: { override_unmatched: true } },
      ],
      "override-raw": [
        { models: absent, params: { override_raw_matched: "true" } },
        { models: present, params: { override_raw_unmatched: "true" } },
      ],
      filter: [
        { models: absent, params: ["metadata"] },
        { models: present, params: ["system"] },
      ],
    };

    // The executor already removed `thinking` (forced tool choice) before calling the barrier.
    const out = apply(
      rules,
      { model: "claude-opus-5", protocol: "claude" },
      { max_tokens: 100, metadata: { a: 1 }, system: "s" },
    );

    for (const prefix of ["default", "default_raw", "override", "override_raw"]) {
      expect(get(out, `${prefix}_matched`)).toBe(true);
      expect(exists(out, `${prefix}_unmatched`)).toBe(false);
    }

    expect(exists(out, "metadata")).toBe(false);
    expect(exists(out, "system")).toBe(true);
  });

  it("filters Codex image tools by query path (TestPayloadBarrierCodexImageFilter)", () => {
    const rules = {
      filter: [
        {
          models: [{ name: "gpt-5.6-sol" }],
          params: ['tools.#(type=="image_generation")#', "instructions", "prompt_cache_key"],
        },
      ],
    };

    const body = (): Json => ({
      input: "hello",
      tools: [{ type: "image_generation" }, { type: "function", name: "f" }],
      instructions: "x",
      prompt_cache_key: "k",
    });

    const sol = apply(rules, { model: "gpt-5.6-sol", protocol: "codex" }, body());
    expect(get(sol, 'tools.#(type=="image_generation")')).toBeUndefined();
    expect(get(sol, "tools.#")).toBe(1);
    expect(exists(sol, "instructions")).toBe(false);
    const luna = apply(rules, { model: "gpt-5.6-luna", protocol: "codex" }, body());
    expect(get(luna, "tools.#")).toBe(2);
  });

  it("Antigravity root: overrides and filters relative to `request`, applied once per rebuilt attempt", () => {
    const rules = {
      override: [
        {
          models: [{ name: "gemini-*" }],
          params: {
            "generationConfig.maxOutputTokens": 123,
            "toolConfig.functionCallingConfig.mode": "CUSTOM",
          },
        },
      ],
      filter: [{ models: [{ name: "gemini-*" }], params: ["sessionId", "contents.0"] }],
    };

    const config = makeConfig(rules);

    for (let attempt = 0; attempt < 2; attempt++) {
      const body: Json = {
        request: {
          sessionId: "injected",
          contents: [
            { role: "user", parts: [{ text: "first" }] },
            { role: "user", parts: [{ text: "second" }] },
          ],
        },
      };

      const out = applyPayloadRules(
        config,
        { model: "gemini-3.1-pro-preview", protocol: "antigravity", root: "request" },
        body,
      ).payload;

      expect(get(out, "request.generationConfig.maxOutputTokens")).toBe(123);
      expect(exists(out, "request.sessionId")).toBe(false);
      expect(get(out, "request.contents.#")).toBe(1);
    }
  });
});

describe("payload rules engine details", () => {
  it("is a no-op without config or rules and never reads the original as mutable", () => {
    const body: Json = { a: 1 };
    expect(applyPayloadRules(undefined, { model: "m", protocol: "x" }, body).payload).toBe(body);
    const original: Json = { a: 1 };
    applyPayloadRules(
      makeConfig({ override: [{ models: [{ name: "*" }], params: { b: 2 } }] }),
      { model: "m", protocol: "x", original },
      body,
    );
    expect(original).toEqual({ a: 1 });
  });

  it("defaults compare against a snapshot of the received payload when no original is given", () => {
    const rules = { default: [{ models: [{ name: "*" }], params: { a: "dflt", b: "dflt" } }] };
    const out = apply(rules, { model: "m", protocol: "x" }, { a: 1 });
    expect(out).toEqual({ a: 1, b: "dflt" });
  });

  it("does not alias config values into the payload", () => {
    const config = makeConfig({
      override: [
        { models: [{ name: "*" }], params: { shared: { list: [1] } } },
        { models: [{ name: "*" }], params: { "shared.list.-1": 2 } },
      ],
    });

    const first = applyPayloadRules(config, { model: "m", protocol: "x" }, {}).payload;
    const second = applyPayloadRules(config, { model: "m", protocol: "x" }, {}).payload;
    expect(first).toEqual({ shared: { list: [1, 2] } });
    expect(second).toEqual(first);
  });

  it("matchModelPattern follows the Go matcher", () => {
    expect(matchModelPattern("gpt-*", "gpt-5")).toBe(true);
    expect(matchModelPattern("*-5", "gpt-5")).toBe(true);
    expect(matchModelPattern("gemini-*-pro", "gemini-2.5-pro")).toBe(true);
    expect(matchModelPattern("*", "")).toBe(true);
    expect(matchModelPattern("", "x")).toBe(false);
    expect(matchModelPattern("a?c", "abc")).toBe(false); // only `*` is a wildcard
    expect(matchModelPattern(" gpt-* ", " gpt-5 ")).toBe(true);
  });

  it("payloadModelCandidates deduplicates and strips the thinking suffix", () => {
    expect(payloadModelCandidates("gpt-5", "GPT-5(high)")).toEqual(["gpt-5", "GPT-5(high)"]);
    expect(payloadModelCandidates("up", "alias(8192)")).toEqual(["up", "alias", "alias(8192)"]);
    expect(payloadModelCandidates("", "")).toEqual([]);
  });

  it("resolvePayloadRulePaths expands queries into index paths", () => {
    const body: Json = { items: [{ k: "a" }, { k: "b" }, { k: "a" }] };
    expect(resolvePayloadRulePaths(body, 'items.#(k=="a")#.x')).toEqual(["items.0.x", "items.2.x"]);
    expect(resolvePayloadRulePaths(body, 'items.#(k=="a").x')).toEqual(["items.0.x"]);
    expect(resolvePayloadRulePaths(body, 'items.#(k=="z")#')).toEqual([]);
    expect(resolvePayloadRulePaths(body, 'items.#(k=="a" && k!="a" || k=="b")#')).toEqual([
      "items.1",
    ]);
    expect(resolvePayloadRulePaths(body, " plain.path ")).toEqual(["plain.path"]);
    expect(resolvePayloadRulePaths(body, "  ")).toEqual([]);
  });
});
