// Unit tests for the Claude executor building blocks: xxHash64, CCH signing, betas, cache control, MCP aliases,
// rate-limit classification, sanitising and cloaking helpers.
import { describe, expect, it } from "vitest";
import type { JsonObject, Json } from "@commissary/json";
import {
  BETA,
  claudeCodeCLIBetas,
  countTokensBetas,
  extractAndRemoveBetas,
  requestedBetas,
  withAdvisorToolBeta,
} from "../src/executor/claude/betas.ts";
import {
  enforceCacheControlLimit,
  ensureCacheControl,
  normalizeCacheControlTTL,
  upgradeCacheControlTTL,
} from "../src/executor/claude/cache-control.ts";
import { computeFingerprint, generateBillingHeader } from "../src/executor/claude/cloaking.ts";
import {
  AliasResolver,
  AliasRestoreError,
  allocateToolAlias,
  isMCPToolName,
  remapToolNames,
  restoreToolNamesInResponse,
  restoreToolNamesInStreamLine,
} from "../src/executor/claude/mcp-alias.ts";
import {
  classifyUpstreamError,
  headersIndicateUnifiedRejection,
  parseRateLimitResetMs,
} from "../src/executor/claude/ratelimit.ts";
import { sanitizeForClaudeUpstream } from "../src/executor/claude/sanitize.ts";
import { claudeSignature } from "./support/signatures.ts";
import {
  ensureBillingCCHPlaceholder,
  normalizeCchInput,
  serializeAndSign,
} from "../src/executor/claude/signing.ts";
import { xxh64 } from "../src/executor/claude/xxhash64.ts";
import { claudeCodeLocalDate } from "../src/executor/claude/cloaking.ts";
import { Effect } from "effect";
import { it as effectIt } from "@effect/vitest";
import { parseConfigYaml } from "../src/config/codec.ts";
import { resolveWirePolicy } from "../src/executor/claude/credentials.ts";
import type { CredentialSnapshot } from "../src/executor/picker.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("xxh64", () => {
  it("matches the reference vectors", () => {
    expect(xxh64(bytes(""), 0n)).toBe(0xef46db3751d8e999n);
    expect(xxh64(bytes("abc"), 0n)).toBe(0x44bc2cf5ad770999n);
    expect(xxh64(bytes("Nobody inspects the spammish repetition"), 0n)).toBe(0xfbcea83c8a378bf1n);
  });
});

describe("CCH signing", () => {
  const body = (): JsonObject => ({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    system: [
      {
        type: "text",
        text: "x-anthropic-billing-header: cc_version=2.1.280.abc; cc_entrypoint=cli;",
      },
    ],
    messages: [{ role: "user", content: "hi" }],
  });

  it("inserts the placeholder after cc_entrypoint and signs it in place", () => {
    const value = body();
    ensureBillingCCHPlaceholder(value, "");
    expect((value.system as JsonObject[])[0]?.text).toContain("cc_entrypoint=cli; cch=00000;");
    const text = serializeAndSign(value, true);
    const match = /cch=([0-9a-f]{5});/.exec(text);
    expect(match?.[1]).toMatch(/^[0-9a-f]{5}$/);
    expect(match?.[1]).not.toBe("00000");
    // the rest of the body is untouched and the digits are the only difference
    expect(text.replace(/cch=[0-9a-f]{5};/, "cch=00000;")).toBe(JSON.stringify(value));
  });

  it("ignores model, max_tokens, fallbacks and fallback_credit_token when hashing", () => {
    const a = body();
    ensureBillingCCHPlaceholder(a, "");

    const b = {
      ...body(),
      model: "claude-opus-4-6",
      max_tokens: 5,
      fallbacks: [{ model: "x" }],
    } as JsonObject;

    ensureBillingCCHPlaceholder(b, "");
    const cchOf = (text: string) => /cch=([0-9a-f]{5});/.exec(text)?.[1];
    expect(cchOf(serializeAndSign(a, true))).toBe(cchOf(serializeAndSign(b, true)));
    const c = body();
    ensureBillingCCHPlaceholder(c, "");
    (c.messages as JsonObject[])[0] = { role: "user", content: "different" };
    expect(cchOf(serializeAndSign(c, true))).not.toBe(cchOf(serializeAndSign(a, true)));
  });

  it("normalises like the Go scanner (comma handling for trailing excluded members)", () => {
    expect(normalizeCchInput('{"a":1,"max_tokens":5}')).toBe('{"a":1}');
    expect(normalizeCchInput('{"max_tokens":5,"a":1}')).toBe('{"a":1}');
    expect(normalizeCchInput('{"a":1,"max_tokens":5,"fallbacks":[]}')).toBe('{"a":1,}');
    expect(normalizeCchInput('{"model":"claude-x","n":{"model":"y"}}')).toBe(
      '{"model":"","n":{"model":""}}',
    );
    expect(normalizeCchInput('{"s":"max_tokens","max_tokens":1}')).toBe('{"s":"max_tokens"}');
  });

  it("prepends a fallback billing block when the body has none", () => {
    const value: JsonObject = { model: "m", system: "caller", messages: [] };
    ensureBillingCCHPlaceholder(
      value,
      "x-anthropic-billing-header: cc_version=1.abc; cc_entrypoint=cli; cch=00000;",
    );
    expect(value.system).toEqual([
      {
        type: "text",
        text: "x-anthropic-billing-header: cc_version=1.abc; cc_entrypoint=cli; cch=00000;",
      },
      { type: "text", text: "caller" },
    ]);
  });
});

describe("cloaking helpers", () => {
  it("computes the billing fingerprint from UTF-16 positions 4, 7 and 20", () => {
    expect(computeFingerprint("", "2.1.280")).toBe(
      computeFingerprint("0000000000000000000000", "2.1.280").slice(0, 3),
    );
    expect(computeFingerprint("hello world, this is a test", "2.1.280")).toMatch(/^[0-9a-f]{3}$/);
    expect(computeFingerprint("abcdefghij", "1.0.0")).toBe(
      computeFingerprint("xxxxefxhxx", "1.0.0"),
    );
  });

  it("builds the billing header with optional tags", () => {
    const text = generateBillingHeader({
      cchSigning: true,
      version: "2.1.280",
      messageText: "hello",
      entrypoint: "",
      workload: "w",
      isSubagent: true,
      prevReq: "req_1",
      promptId: "p",
      turnOrigin: "human",
    });

    expect(text).toMatch(
      /^x-anthropic-billing-header: cc_version=2\.1\.280\.[0-9a-f]{3}; cc_entrypoint=cli; cch=00000; cc_workload=w; cc_is_subagent=true; cc_prev_req=req_1; cc_prompt_id=p; cc_turn_origin=human;$/,
    );
  });

  it("formats the pinned date in the requested timezone", () => {
    const now = new Date("2026-03-01T23:30:00Z");
    expect(claudeCodeLocalDate(now, "UTC")).toBe("2026-03-01");
    expect(claudeCodeLocalDate(now, "Asia/Tokyo")).toBe("2026-03-02");
    expect(claudeCodeLocalDate(now, "Not/AZone")).toBe("2026-03-01");
  });
});

describe("cloak level", () => {
  const API_KEY = "sk-ant-api03-level";
  const OAUTH_TOKEN = "sk-ant-oat01-level";

  const apiKeyCredential = (attributes: Record<string, string> = {}): CredentialSnapshot => ({
    id: "claude-key-1",
    provider: "claude",
    kind: "apikey",
    label: "key",
    attributes: { api_key: API_KEY, ...attributes },
    metadata: {},
  });

  const oauthCredential = (attributes: Record<string, string> = {}): CredentialSnapshot => ({
    id: "claude-oauth-1",
    provider: "claude",
    kind: "oauth",
    label: "dev@example.com",
    attributes,
    metadata: { access_token: OAUTH_TOKEN },
  });

  const keyYaml = (cloak: string) => `
api-keys:
  claude:
    - keys:
        - api-key: ${API_KEY}
          cloak: ${cloak}
`;

  const resolve = (yaml: string, credential: CredentialSnapshot, confirmedClaudeCode = false) =>
    parseConfigYaml(yaml).pipe(
      Effect.map(
        (config) =>
          resolveWirePolicy(
            config,
            credential,
            credential.attributes["api_key"] ?? OAUTH_TOKEN,
            confirmedClaudeCode,
          ).policy,
      ),
    );

  effectIt.effect("defaults to full", () =>
    Effect.gen(function* () {
      expect(yield* resolve("", oauthCredential())).toMatchObject({ cloak: true, level: "full" });
    }),
  );

  effectIt.effect(
    "takes the global level, then the cloak_level attribute, then the key's cloak.level",
    () =>
      Effect.gen(function* () {
        const global = "upstream: { claude: { cloak-level: minimal } }";
        expect((yield* resolve(global, oauthCredential())).level).toBe("minimal");
        expect((yield* resolve(global, oauthCredential({ cloak_level: "FULL " }))).level).toBe(
          "full",
        );
        expect((yield* resolve("", oauthCredential({ cloak_level: " Minimal" }))).level).toBe(
          "minimal",
        );

        const keyMinimal = `${global}\n${keyYaml("{ mode: always, level: minimal }")}`;
        expect((yield* resolve(keyMinimal, apiKeyCredential({ cloak_level: "full" }))).level).toBe(
          "minimal",
        );

        const keyFull = keyYaml("{ mode: always, level: full }");
        expect((yield* resolve(keyFull, apiKeyCredential({ cloak_level: "minimal" }))).level).toBe(
          "full",
        );
      }),
  );

  effectIt.effect("resolves an unknown value to full and an empty one to the next source", () =>
    Effect.gen(function* () {
      expect((yield* resolve("", oauthCredential({ cloak_level: "off" }))).level).toBe("full");
      const global = "upstream: { claude: { cloak-level: minimal } }";
      expect((yield* resolve(global, oauthCredential({ cloak_level: "  " }))).level).toBe(
        "minimal",
      );
      const unknown = keyYaml("{ mode: always, level: stealth }");
      expect((yield* resolve(unknown, apiKeyCredential({ cloak_level: "minimal" }))).level).toBe(
        "full",
      );
    }),
  );

  effectIt.effect("never turns cloaking on by itself", () =>
    Effect.gen(function* () {
      expect((yield* resolve(keyYaml("{ level: minimal }"), apiKeyCredential())).cloak).toBe(false);
      expect((yield* resolve("", apiKeyCredential({ cloak_level: "minimal" }))).cloak).toBe(false);
      expect(
        yield* resolve(keyYaml("{ mode: always, level: minimal }"), apiKeyCredential()),
      ).toMatchObject({ cloak: true, level: "minimal" });
      // Another cloak setting still counts, as before.
      expect(
        (yield* resolve(keyYaml("{ level: minimal, strict-mode: true }"), apiKeyCredential()))
          .cloak,
      ).toBe(true);
    }),
  );

  effectIt.effect("leaves never and confirmed Claude Code uncloaked at either level", () =>
    Effect.gen(function* () {
      const off = "upstream: { claude: { disable-claude-cloak-mode: true, cloak-level: minimal } }";
      expect((yield* resolve(off, oauthCredential())).cloak).toBe(false);
      expect((yield* resolve("", oauthCredential({ cloak_level: "minimal" }), true)).cloak).toBe(
        false,
      );
    }),
  );
});

describe("betas", () => {
  const body = (extra: JsonObject = {}): JsonObject => ({
    model: "claude-sonnet-4-5",
    messages: [{ role: "user", content: "hi" }],
    ...extra,
  });

  it("assembles the Claude Code CLI list in order", () => {
    const betas = claudeCodeCLIBetas(
      body({ model: "claude-opus-4-6", thinking: { type: "adaptive" } }),
      new Set(),
      true,
    ).split(",");

    expect(betas.slice(0, 7)).toEqual([
      BETA.claudeCode,
      BETA.oauth,
      "interleaved-thinking-2025-05-14",
      BETA.redactThinking,
      "thinking-token-count-2026-05-13",
      "context-management-2025-06-27",
      "prompt-caching-scope-2026-01-05",
    ]);
    // legacy model: no mid-conversation system betas; effort and the OAuth extended cache ttl are present
    expect(betas).not.toContain(BETA.midConvSystem);
    expect(betas).toContain(BETA.effort);
    expect(betas).toContain(BETA.extendedCacheTTL);
  });

  it("adds the mid-conversation betas for current models and conditional betas from the body", () => {
    const betas = claudeCodeCLIBetas(
      body({
        model: "claude-sonnet-5-5",
        speed: "fast",
        fallbacks: [{ model: "x" }],
        diagnostics: { previous_message_id: null },
        tools: [{ type: "tool_search_tool_bm25_20251119", name: "t" }],
      }),
      new Set([BETA.context1M]),
      false,
    ).split(",");

    expect(betas).toContain(BETA.midConvSystem);
    expect(betas).toContain(BETA.midConvToolChanges);
    expect(betas).toContain(BETA.fastMode);
    expect(betas).toContain(BETA.serverSideFallback);
    expect(betas).toContain(BETA.advancedToolUse);
    expect(betas).toContain(BETA.cacheDiagnosis);
    expect(betas).toContain(BETA.context1M);
    expect(betas).not.toContain(BETA.oauth);
  });

  it("skips redact-thinking when a display is set and effort for haiku", () => {
    const betas = claudeCodeCLIBetas(
      body({ model: "claude-haiku-4-5", thinking: { type: "enabled", display: "summarized" } }),
      new Set(),
      false,
    );

    expect(betas).not.toContain(BETA.redactThinking);
    expect(betas).not.toContain(BETA.effort);
  });

  it("count_tokens list and helpers", () => {
    expect(countTokensBetas(true)).toBe(
      `${BETA.claudeCode},${BETA.oauth},interleaved-thinking-2025-05-14,context-management-2025-06-27,${BETA.tokenCounting}`,
    );
    expect(withAdvisorToolBeta("a,effort-2025-11-24,b")).toBe(
      `a,${BETA.advisorTool},effort-2025-11-24,b`,
    );
    expect([...requestedBetas("a, b", ["c", " "])]).toEqual(["a", "b", "c"]);
    const value: JsonObject = { betas: [" x ", "y"], model: "m" };
    expect(extractAndRemoveBetas(value)).toEqual(["x", "y"]);
    expect(value).toEqual({ model: "m" });
  });
});

describe("cache control", () => {
  const eph = { type: "ephemeral" };

  it("places breakpoints on the last system block and the last message", () => {
    const body: JsonObject = {
      system: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
      tools: [{ name: "t" }],
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: [{ type: "text", text: "two" }] },
        { role: "user", content: "three" },
      ],
    };

    ensureCacheControl(body);
    expect(body.tools).toEqual([{ name: "t" }]);
    expect((body.system as JsonObject[])[1]?.cache_control).toEqual(eph);
    expect((body.messages as JsonObject[])[2]?.content).toEqual([
      { type: "text", text: "three", cache_control: eph },
    ]);
  });

  it("puts the tools breakpoint only without a cacheable system prompt", () => {
    const body: JsonObject = {
      tools: [{ name: "a" }, { name: "b", defer_loading: true }],
      messages: [{ role: "user", content: "x" }],
    };

    ensureCacheControl(body);
    expect((body.tools as JsonObject[])[0]?.cache_control).toEqual(eph);
    expect((body.tools as JsonObject[])[1]?.cache_control).toBeUndefined();
  });

  it("enforces the limit by stripping earlier system and tool markers first", () => {
    const body: JsonObject = {
      system: [
        { text: "a", cache_control: eph },
        { text: "b", cache_control: eph },
      ],
      tools: [
        { name: "a", cache_control: eph },
        { name: "b", cache_control: eph },
      ],
      messages: [{ role: "user", content: [{ type: "text", text: "m", cache_control: eph }] }],
    };

    enforceCacheControlLimit(body, 4);
    expect((body.system as JsonObject[]).map((block) => block.cache_control !== undefined)).toEqual(
      [false, true],
    );
    expect((body.tools as JsonObject[]).map((block) => block.cache_control !== undefined)).toEqual([
      true,
      true,
    ]);
    const threaded: JsonObject = { ...body, thread: { type: "continue" } };
    enforceCacheControlLimit(threaded, 4);
    expect(JSON.stringify(threaded)).toContain("cache_control");
  });

  it("upgrades missing ttls to 1h and downgrades a 1h marker after a 5m one", () => {
    const body: JsonObject = {
      system: [{ text: "a", cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "m", cache_control: { type: "ephemeral", ttl: "1h" } }],
        },
      ],
    };

    upgradeCacheControlTTL(body, "1h");
    expect((body.system as JsonObject[])[0]?.cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });

    const mixed: JsonObject = {
      system: [
        { text: "a", cache_control: { type: "ephemeral" } },
        { text: "b", cache_control: { type: "ephemeral", ttl: "1h" } },
      ],
    };

    normalizeCacheControlTTL(mixed);
    expect((mixed.system as JsonObject[])[1]?.cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("MCP tool aliases", () => {
  const SECRET = "caller-scope";

  it("recognises MCP names and allocates deterministic, collision-free aliases", () => {
    expect(isMCPToolName("mcp__server__tool")).toBe(true);
    expect(isMCPToolName("mcp__server")).toBe(false);
    expect(isMCPToolName("bash")).toBe(false);
    const a = allocateToolAlias(SECRET, "get_weather", new Set());
    expect(a).toMatch(/^mcp__[a-z]+_[a-z]+__[a-z]+_get_weather$/);
    expect(allocateToolAlias(SECRET, "get_weather", new Set())).toBe(a);
    expect(allocateToolAlias(SECRET, "get_weather", new Set([a as string]))).not.toBe(a);
    expect(allocateToolAlias(SECRET, "weird.name:x", new Set())).toMatch(/_weird_name_x$/);
    expect(
      (allocateToolAlias(SECRET, "x".repeat(100), new Set()) as string).length,
    ).toBeLessThanOrEqual(64);
  });

  it("rewrites tools, tool_choice and history and restores responses and stream lines", () => {
    const body: JsonObject = {
      tools: [
        { name: "get_weather", description: "d", input_schema: {} },
        { type: "custom", name: "other", input_schema: {} },
        { type: "web_search_20250305", name: "web_search" },
        { name: "mcp__srv__keep", input_schema: {} },
      ],
      tool_choice: { type: "tool", name: "get_weather" },
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "get_weather", input: {} }],
        },
      ],
    };

    const reverse = remapToolNames(body, SECRET);
    const tools = body.tools as JsonObject[];
    const alias = tools[0]?.name as string;
    expect(isMCPToolName(alias)).toBe(true);
    expect(alias).not.toBe("get_weather");
    expect(tools[1]).not.toHaveProperty("type");
    expect(tools[2]).toEqual({ type: "web_search_20250305", name: "web_search" });
    expect(tools[3]?.name).toBe("mcp__srv__keep");
    expect((body.tool_choice as JsonObject).name).toBe(alias);

    const historyContent = ((body.messages as JsonObject[])[0] as JsonObject)
      .content as JsonObject[];

    expect((historyContent[0] as JsonObject).name).toBe(alias);
    expect(reverse.get(alias)).toBe("get_weather");

    const response: JsonObject = {
      content: [
        { type: "tool_use", id: "x", name: alias, input: {} },
        { type: "text", text: alias },
      ],
    };

    restoreToolNamesInResponse(response, reverse);
    expect((response.content as JsonObject[])[0]?.name).toBe("get_weather");
    expect((response.content as JsonObject[])[1]?.text).toBe(alias);

    const line = `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "x", name: alias, input: {} } })}`;
    const restored = restoreToolNamesInStreamLine(line, reverse);
    expect(restored.startsWith("data: ")).toBe(true);
    expect(JSON.parse(restored.slice(6)).content_block.name).toBe("get_weather");
    expect(restoreToolNamesInStreamLine('data: {"type":"content_block_delta"}', reverse)).toBe(
      'data: {"type":"content_block_delta"}',
    );
  });

  it("recovers drifted names and refuses ambiguous ones", () => {
    const reverse = new Map([
      ["mcp__alpha_beta__word_read_file", "read_file"],
      ["mcp__alpha_beta__zzz_write_file", "write_file"],
      ["mcp__srv__keep", "mcp__srv__keep"],
    ]);

    const resolver = new AliasResolver(reverse);
    expect(resolver.resolve("mcp__alpha_beta__word_read_file")).toBe("read_file");
    expect(resolver.resolve("mcp__alpha_beta__alpha_beta__word_read_file")).toBe("read_file");
    expect(resolver.resolve("mcp__alpha_beta__other_write_file")).toBe("write_file");
    expect(resolver.resolve("unrelated")).toBeUndefined();
    expect(resolver.resolve("mcp__srv__keep")).toBeUndefined();

    const ambiguous = new AliasResolver(
      new Map([
        ["mcp__a_b__w1_file", "file"],
        ["mcp__a_b__w2_file", "file2"],
      ]),
    );

    expect(() => ambiguous.resolve("mcp__a_b__w3_file")).toThrow(AliasRestoreError);
  });
});

describe("rate limit classification", () => {
  const headers = (values: Record<string, string>) => new Headers(values);
  const NOW = 1_800_000_000_000;

  it("detects unified rejections and parses the latest reset with fuzz", () => {
    const h = headers({
      "anthropic-ratelimit-unified-5h-status": "rejected",
      "anthropic-ratelimit-unified-5h-reset": String((NOW + 600_000) / 1000),
      "anthropic-ratelimit-unified-7d-status": "allowed",
      "retry-after": "30",
    });

    expect(headersIndicateUnifiedRejection(h)).toBe(true);
    expect(parseRateLimitResetMs(h, NOW, () => 5)).toBe(600_000 + 5000);
    expect(parseRateLimitResetMs(headers({}), NOW, () => 5)).toBeUndefined();
    expect(
      parseRateLimitResetMs(headers({ "retry-after": String(8 * 24 * 3600) }), NOW, () => 1),
    ).toBeUndefined();
  });

  it("treats overage-only rejections as model-level", () => {
    const h = headers({
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-5h-status": "allowed",
      "anthropic-ratelimit-unified-7d-status": "allowed_warning",
      "anthropic-ratelimit-unified-representative-claim": "overage",
    });

    expect(headersIndicateUnifiedRejection(h)).toBe(false);
  });

  it("classifies 429s as credential-scoped, entitlement (request-scoped) or model-level", () => {
    const credential = classifyUpstreamError(
      429,
      headers({ "anthropic-ratelimit-unified-7d-status": "rejected" }),
      "{}",
      false,
      NOW,
    );

    expect(credential.credentialScoped).toBe(true);

    const modelLevelConfigured = classifyUpstreamError(
      429,
      headers({ "anthropic-ratelimit-unified-7d-status": "rejected" }),
      "{}",
      true,
      NOW,
    );

    expect(modelLevelConfigured.credentialScoped).toBe(false);

    const entitlement = classifyUpstreamError(
      429,
      headers({}),
      '{"error":{"message":"Fast request rejected: usage credits are required"}}',
      false,
      NOW,
    );

    expect(entitlement.requestScoped).toBe(true);
    expect(classifyUpstreamError(500, headers({}), "boom", false, NOW)).toMatchObject({
      status: 500,
      message: "boom",
    });
  });
});

describe("history sanitising", () => {
  it("drops thinking blocks without a Claude signature and tool_use provenance fields", () => {
    const body: JsonObject = {
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "x", signature: "gemini-signature" },
            { type: "thinking", thinking: "y", signature: "" },
            { type: "thinking", thinking: "ok", signature: claudeSignature() },
            {
              type: "tool_use",
              id: "t",
              name: "n",
              input: {},
              thought_signature: "s",
              model: "gemini",
            },
          ],
        },
        { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "" }] },
      ],
    };

    sanitizeForClaudeUpstream(body, "claude-sonnet-4-5", false);
    const messages = body.messages as JsonObject[];
    expect(messages).toHaveLength(2);
    expect(messages[1]?.content).toEqual([
      { type: "thinking", thinking: "ok", signature: claudeSignature() },
      { type: "tool_use", id: "t", name: "n", input: {} },
    ]);
  });
});

describe("Responses reasoning replay", () => {
  it("replays a decodable Claude signature as a thinking block and drops foreign ones unless compat mode keeps them", async () => {
    const {
      convertOpenAIResponsesRequestToClaude,
      convertOpenAIResponsesRequestToClaudeWithCompat,
    } = await import("@commissary/translation");

    const input = (signature: string): JsonObject => ({
      model: "gpt-5",
      input: [
        { type: "message", role: "user", content: "q" },
        {
          type: "reasoning",
          encrypted_content: signature,
          summary: [{ type: "summary_text", text: "why" }],
        },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "a" }] },
      ],
    });

    const blocks = (body: JsonObject): Json => (body.messages as JsonObject[])[1]?.content as Json;

    const native = convertOpenAIResponsesRequestToClaude(
      "claude-sonnet-4-5",
      input(claudeSignature()),
      false,
    ) as JsonObject;

    expect(blocks(native)).toEqual([
      { type: "thinking", thinking: "why", signature: claudeSignature() },
      { type: "text", text: "a" },
    ]);

    const foreign = convertOpenAIResponsesRequestToClaude(
      "claude-sonnet-4-5",
      input("opaque"),
      false,
    ) as JsonObject;

    expect(blocks(foreign)).toBe("a");

    const compat = convertOpenAIResponsesRequestToClaudeWithCompat(
      "claude-sonnet-4-5",
      input("opaque"),
      false,
    ) as JsonObject;

    expect(blocks(compat)).toEqual([
      { type: "thinking", thinking: "why", signature: "opaque" },
      { type: "text", text: "a" },
    ]);
  });
});
