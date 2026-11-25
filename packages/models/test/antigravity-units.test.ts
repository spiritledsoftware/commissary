// Unit tests of the Antigravity helpers: error decisions, SSE handling, state, credits, version, model probes,
// signature cache + store and the web search grounding translation.
import { env } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  antigravityStateFor,
  CREDITS_REFRESH_INTERVAL_MS,
  creditsAvailable,
  makeKvAntigravityState,
  makeMemoryAntigravityState,
  sessionStateCreditsClaim,
} from "../src/executor/antigravity/state.ts";
import {
  parseCreditsReply,
  probeCredits,
  shouldAttemptCreditsFallback,
} from "../src/executor/antigravity/credits.ts";
import type { CredentialSnapshot } from "../src/executor/picker.ts";
import { ExecutionError } from "../src/executor/errors.ts";
import {
  decideAntigravity429,
  hasExplicitCreditsBalanceExhaustedReason,
} from "../src/executor/antigravity/errors.ts";
import { parseGoDuration } from "../src/config/accessors.ts";
import { parseGoogleRetryDelayMs } from "../src/executor/helps/google-retry.ts";
import {
  geminiToAntigravity,
  requestBaseUrl,
  sanitizeRequestSchemas,
  constrainRequestPayload,
  stableSessionId,
} from "../src/executor/antigravity/envelope.ts";
import { prepareClaudeStructuredOutput } from "../src/executor/antigravity/structured-output.ts";
import { scopeAntigravitySessionIdForCredential } from "../src/executor/antigravity/derived-session.ts";
import { serializeAntigravityPayload } from "../src/executor/antigravity/payload-order.ts";
import { aggregatesStream } from "../src/executor/antigravity/executor.ts";
import {
  antigravitySignatureScope,
  scopedSignatureCache,
  scopedSignatureText,
} from "../src/executor/antigravity/signature-scope.ts";
import { normalizeFunctionResponseRoles } from "../src/executor/antigravity/content.ts";
import { usesReasoningReplay } from "../src/executor/helps/reasoning-replay.ts";
import {
  loadAntigravityHints,
  nextFailure,
  parseModelHints,
  refreshAntigravityModels,
} from "../src/executor/antigravity/models.ts";
import {
  convertStreamToNonStream,
  inBandErrorStatus,
  JsonAssembler,
  UsageFilter,
} from "../src/executor/antigravity/stream.ts";
import {
  ANTIGRAVITY_FALLBACK_VERSION,
  ANTIGRAVITY_HUB_CHANGELISTS,
  ANTIGRAVITY_VERSION_KEY,
  antigravityRequestUserAgent,
  antigravityVersionFromUserAgent,
  parseManifestVersion,
  refreshAntigravityVersion,
  resetAntigravityVersionCache,
  resolveStoredVersion,
} from "../src/executor/antigravity/version.ts";
import { asString, get, type Json } from "@commissary/json";
import { applyAntigravityHints } from "../src/registry/antigravity-hints.ts";
import { embeddedCatalogs, sectionModels } from "../src/registry/catalog.ts";
import {
  DEFAULT_SIGNATURE_SCOPE,
  MemorySignatureCache,
  SIGNATURE_CACHE_TTL_MS,
  signatureStoreKey,
  withSignatureContext,
  getCachedSignature,
  cacheSignature,
  flushSignatureWrites,
  makeMemorySignatureStore,
  prefetchSignatures,
} from "@commissary/translation/signature";
import {
  builtinTranslators,
  makeTranslationState,
  withModelInfoLookup,
} from "@commissary/translation";
import { mockHttpClient, type UpstreamCall } from "./support/pipeline.ts";
import { CurrentOrg, GLOBAL_ORG, OrgId, orgKv } from "@commissary/core";
import { envContext } from "./support/context.ts";

const LONG_SIGNATURE = "S".repeat(80);

describe("429 decisions and retry delays", () => {
  const body = (reason: string, delay?: string, status = "RESOURCE_EXHAUSTED") =>
    JSON.stringify({
      error: {
        status,
        message: "x",
        details: [
          { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason },
          ...(delay === undefined
            ? []
            : [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: delay }]),
        ],
      },
    });

  it("parses Go durations as Google emits them", () => {
    expect(parseGoDuration("3.500s")).toBe(3500);
    expect(parseGoDuration("1h2m3s")).toBe(3_723_000);
    expect(parseGoDuration("300ms")).toBe(300);
    expect(parseGoDuration("abc")).toBeUndefined();
  });

  it("reads RetryInfo, quotaResetDelay and message hints in Go's order", () => {
    expect(parseGoogleRetryDelayMs(body("X", "2.000s"))).toBe(2000);

    const meta = JSON.stringify({
      error: {
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            metadata: { quotaResetDelay: "9s" },
          },
        ],
      },
    });

    expect(parseGoogleRetryDelayMs(meta)).toBe(9000);
    expect(
      parseGoogleRetryDelayMs(JSON.stringify({ error: { message: "Try again after 12s." } })),
    ).toBe(12_000);
    expect(
      parseGoogleRetryDelayMs(JSON.stringify({ error: { message: "reset after 1h30m" } })),
    ).toBe(5_400_000);
    expect(parseGoogleRetryDelayMs("{}")).toBeUndefined();
  });

  it("follows the decision table", () => {
    expect(decideAntigravity429("", undefined, 0).kind).toBe("soft_retry");
    expect(
      decideAntigravity429(body("RATE_LIMIT_EXCEEDED", "1s", "NOT_EXHAUSTED"), undefined, 0).kind,
    ).toBe("soft_retry");
    expect(decideAntigravity429(body("QUOTA_EXHAUSTED"), undefined, 0).kind).toBe(
      "full_quota_exhausted",
    );
    expect(decideAntigravity429(body("INSUFFICIENT_G1_CREDITS_BALANCE"), undefined, 0).kind).toBe(
      "full_quota_exhausted",
    );
    expect(decideAntigravity429(body("RATE_LIMIT_EXCEEDED"), undefined, 0).kind).toBe("soft_retry");
    expect(decideAntigravity429(body("RATE_LIMIT_EXCEEDED", "2s"), undefined, 0).kind).toBe(
      "instant_retry_same_auth",
    );
    expect(decideAntigravity429(body("rate_limit_exceeded", "30s"), undefined, 0)).toMatchObject({
      kind: "short_cooldown_switch_auth",
      retryAfterMs: 30_000,
    });
    expect(decideAntigravity429(body("RATE_LIMIT_EXCEEDED", "300s"), undefined, 0).kind).toBe(
      "full_quota_exhausted",
    );
    expect(
      decideAntigravity429(
        JSON.stringify({
          error: { status: "RESOURCE_EXHAUSTED", message: "Quota exhausted today" },
        }),
        undefined,
        0,
      ).kind,
    ).toBe("full_quota_exhausted");
    expect(
      decideAntigravity429(
        JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED" } }),
        undefined,
        0,
      ).kind,
    ).toBe("soft_retry");
  });

  it("recognises the explicit credits exhaustion reason", () => {
    expect(hasExplicitCreditsBalanceExhaustedReason(body("insufficient_g1_credits_balance"))).toBe(
      true,
    );
    expect(hasExplicitCreditsBalanceExhaustedReason(body("QUOTA_EXHAUSTED"))).toBe(false);
  });

  it("starts the credits fallback only after capacity failures", () => {
    const failure = (status: number, code?: string) =>
      new ExecutionError({ status, message: "m", ...(code === undefined ? {} : { code }) });

    expect(shouldAttemptCreditsFallback(failure(429))).toBe(true);
    expect(shouldAttemptCreditsFallback(failure(503))).toBe(true);
    expect(shouldAttemptCreditsFallback(failure(500, "model_cooldown"))).toBe(true);
    expect(shouldAttemptCreditsFallback(failure(400))).toBe(false);
  });
});

const envelopeOptions = (credentialId = "", sessionId = "", now = 1_700_000_000_000) => ({
  credentialId,
  org: "org-test",
  sessionId,
  now,
});

describe("envelope", () => {
  it("derives stable session ids from the first user text and completes the envelope", () => {
    const payload: Json = {
      request: { contents: [{ role: "user", parts: [{ text: "hello" }] }], safetySettings: [{}] },
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      model: "x",
    };

    expect(stableSessionId(payload)).toBe(stableSessionId(structuredClone(payload)));
    // Signed int64 (CLIProxyAPI 55e5a7ea): FNV-1a of "hello".
    expect(stableSessionId(payload)).toBe("-6615550055289275125");
    // Scoped per credential (3a24d03c).
    expect(stableSessionId(payload, "auth-a")).not.toBe(stableSessionId(payload, "auth-b"));
    const before = structuredClone(payload);

    const { payload: out, isAgent } = geminiToAntigravity(
      "claude-sonnet-4-5",
      payload,
      "proj",
      envelopeOptions(),
    );

    expect(payload).toEqual(before);
    expect(isAgent).toBe(true);
    expect(get(out, "project")).toBe("proj");
    expect(get(out, "requestType")).toBe("agent");
    expect(get(out, "request.safetySettings")).toBeUndefined();
    expect(get(out, "request.toolConfig.functionCallingConfig.mode")).toBe("AUTO");
    expect(get(out, "toolConfig")).toBeUndefined();
    expect(asString(get(out, "requestId"))).toMatch(
      /^agent\/[0-9a-f-]{36}\/1700000000000\/[0-9a-f-]{36}\/1$/,
    );
    expect(get(out, "request.labels.used_claude")).toBe("true");
    expect(get(out, "request.labels.used_non_gemini_model")).toBe("true");
    expect(get(out, "request.labels.last_step_index")).toBe("0");
  });

  it("scans every part of a user turn for the session text (CLIProxyAPI 18a03e40)", () => {
    const payload: Json = {
      request: {
        contents: [{ role: "user", parts: [{ inlineData: { data: "AA" } }, { text: "hello" }] }],
      },
    };

    expect(stableSessionId(payload)).toBe("-6615550055289275125");
  });

  it("keeps one cascade per credential session and counts the agent's steps", () => {
    const payload: Json = {
      request: {
        contents: [
          { role: "user", parts: [{ text: "go" }] },
          { role: "model", parts: [{ functionCall: { name: "f", args: {} } }] },
          { role: "user", parts: [{ functionResponse: { name: "f", response: {} } }] },
        ],
      },
    };

    const first = geminiToAntigravity("gemini-3-pro", payload, "p", envelopeOptions("a", "s", 5));
    const again = geminiToAntigravity("gemini-3-pro", payload, "p", envelopeOptions("a", "s", 5));
    const other = geminiToAntigravity("gemini-3-pro", payload, "p", envelopeOptions("b", "s", 5));
    const cascade = get(first.payload, "request.labels.cascade_id");
    expect(get(again.payload, "request.labels.cascade_id")).toBe(cascade);
    expect(get(other.payload, "request.labels.cascade_id")).not.toBe(cascade);
    expect(get(first.payload, "request.labels.last_step_index")).toBe("2");
    // Two requests within one millisecond still get distinct request ids.
    expect(get(again.payload, "requestId")).not.toBe(get(first.payload, "requestId"));
    expect(get(first.payload, "request.labels.used_non_gemini_model")).toBe("false");
  });

  it("scopes the session per credential, prefers the request's own session, skips image and web search", () => {
    const explicit: Json = { request: { sessionId: "mine", contents: [] } };
    const unscoped = geminiToAntigravity("gemini-3-pro", explicit, "p", envelopeOptions());
    expect(get(unscoped.payload, "request.sessionId")).toBe("mine");
    const scoped = geminiToAntigravity("gemini-3-pro", explicit, "p", envelopeOptions("auth-a"));

    expect(get(scoped.payload, "request.sessionId")).toBe(
      scopeAntigravitySessionIdForCredential("auth-a", "mine"),
    );

    const derived = geminiToAntigravity("gemini-3-pro", explicit, "p", envelopeOptions("a", "-9"));
    expect(get(derived.payload, "request.sessionId")).toBe("-9");
    const image: Json = { request: { contents: [] } };

    const imageOut = geminiToAntigravity(
      "gemini-3.1-flash-image",
      image,
      "p",
      envelopeOptions("", "", 5),
    );

    expect(imageOut.isAgent).toBe(false);
    expect(get(imageOut.payload, "requestType")).toBe("image_gen");

    expect(asString(get(imageOut.payload, "requestId"))).toMatch(
      /^image_gen\/5\/[0-9a-f-]{36}\/12$/,
    );

    expect(get(imageOut.payload, "request.sessionId")).toBeUndefined();
    const search: Json = { requestType: "web_search", request: { contents: [] } };
    const searchOut = geminiToAntigravity("gemini-3-pro", search, "p", envelopeOptions("a"));
    expect(get(searchOut.payload, "requestId")).toBeUndefined();
    expect(get(searchOut.payload, "request.sessionId")).toBeUndefined();
  });

  it("orders agent requests like the native client and compacts the rest unchanged", () => {
    const payload: Json = {
      requestType: "agent",
      model: "m",
      request: {
        sessionId: "s",
        generationConfig: { thinkingConfig: { thinkingLevel: "HIGH", includeThoughts: true } },
        contents: [
          { parts: [{ functionCall: { args: { b: 1, a: 2 }, name: "f" } }], role: "model" },
        ],
      },
      project: "p",
    };

    expect(serializeAntigravityPayload(payload, true)).toBe(
      '{"project":"p","request":{"contents":[{"role":"model","parts":[{"functionCall":{"name":"f","args":{"a":2,"b":1}}}]}],"generationConfig":{"thinkingConfig":{"includeThoughts":true,"thinkingLevel":"HIGH"}},"sessionId":"s"},"model":"m","requestType":"agent"}',
    );

    expect(serializeAntigravityPayload(payload, false)).toBe(JSON.stringify(payload));
  });

  it("selects the daily endpoint unless a base URL is configured", () => {
    expect(requestBaseUrl({}, {})).toBe("https://daily-cloudcode-pa.googleapis.com");
    expect(requestBaseUrl({ base_url: "https://x.test/" }, {})).toBe("https://x.test");
    expect(requestBaseUrl({}, { base_url: "https://m.test//" })).toBe("https://m.test");
  });

  it("cleans schemas only where they live and shapes model dependent fields", () => {
    const payload: Json = {
      request: {
        contents: [
          {
            role: "model",
            parts: [{ functionCall: { name: "t", args: { title: "keep", format: "keep" } } }],
          },
        ],
        tools: [
          {
            functionDeclarations: [
              {
                name: "t",
                parametersJsonSchema: {
                  type: "object",
                  properties: { a: { type: "string", format: "date" } },
                },
              },
            ],
          },
        ],
        generationConfig: { maxOutputTokens: 10 },
      },
    };

    sanitizeRequestSchemas(payload, { useAntigravitySchema: true });
    // The schema keyword is rewritten, the replayed call arguments are not.
    expect(get(payload, "request.tools.0.functionDeclarations.0.parameters")).toBeDefined();
    expect(
      get(payload, "request.tools.0.functionDeclarations.0.parametersJsonSchema"),
    ).toBeUndefined();
    expect(get(payload, "request.contents.0.parts.0.functionCall.args")).toEqual({
      title: "keep",
      format: "keep",
    });
    const gemini = constrainRequestPayload("gemini-2.5-flash", structuredClone(payload));
    expect(get(gemini, "request.generationConfig.maxOutputTokens")).toBeUndefined();
    const claude = constrainRequestPayload("claude-sonnet-4-5", structuredClone(payload));
    expect(get(claude, "request.toolConfig.functionCallingConfig.mode")).toBe("VALIDATED");
  });
});

describe("Claude request constraints", () => {
  it("keeps a NONE function calling mode instead of VALIDATED (Go e0cc1cf8)", () => {
    for (const [container, key] of [
      ["toolConfig", "functionCallingConfig"],
      ["tool_config", "function_calling_config"],
    ] as const) {
      const payload: Json = { request: { [container]: { [key]: { mode: " none " } } } };

      constrainRequestPayload("claude-sonnet-4-5", payload);
      expect(get(payload, `request.${container}.${key}.mode`)).toBe("NONE");
      expect(get(payload, "request.toolConfig.functionCallingConfig.mode")).toBe(
        container === "toolConfig" ? "NONE" : undefined,
      );
    }
  });

  it("re-clamps a Claude thinking budget below the capped output (Go 16bcf5a0)", () => {
    const lookup = (id: string) =>
      id.startsWith("claude-") || id.startsWith("gemini-")
        ? { id, maxCompletionTokens: 64000 }
        : undefined;

    const constrained = (model: string): Json =>
      withModelInfoLookup(lookup, () =>
        constrainRequestPayload(model, {
          request: {
            generationConfig: {
              maxOutputTokens: 128000,
              thinkingConfig: { thinkingBudget: 100000, thinking_budget: 64000 },
            },
          },
        }),
      );

    const claude = constrained("claude-opus-4-6-thinking");
    expect(get(claude, "request.generationConfig.maxOutputTokens")).toBe(64000);
    expect(get(claude, "request.generationConfig.thinkingConfig.thinkingBudget")).toBe(63999);
    expect(get(claude, "request.generationConfig.thinkingConfig.thinking_budget")).toBe(63999);
    // Only Claude budgets are re-clamped.
    expect(
      get(
        constrained("gemini-3-pro-high"),
        "request.generationConfig.thinkingConfig.thinkingBudget",
      ),
    ).toBe(100000);
  });

  // Go `CapAntigravityMaxOutputTokensDoc` on the static-catalog path (antigravity_executor_request.go).
  it("merges the max_output_tokens alias and keeps a smaller caller limit when capping", () => {
    const lookup = (id: string) =>
      id === "claude-sonnet-4-5" ? { id, maxCompletionTokens: 64000 } : undefined;

    const capped = withModelInfoLookup(lookup, () =>
      constrainRequestPayload("claude-sonnet-4-5", {
        request: { generationConfig: { maxOutputTokens: 128000, max_output_tokens: 500 } },
      }),
    );

    expect(get(capped, "request.generationConfig.maxOutputTokens")).toBe(500);
    expect(get(capped, "request.generationConfig.max_output_tokens")).toBeUndefined();
  });

  // CLIProxyAPI 18a03e40: model families match case-insensitively, with a lower-case catalog retry.
  it("treats a mixed-case Claude model as Claude", () => {
    const lookup = (id: string) =>
      id === "claude-sonnet-4-5" ? { id, maxCompletionTokens: 64000 } : undefined;

    const out = withModelInfoLookup(lookup, () =>
      constrainRequestPayload("Claude-Sonnet-4-5", {
        request: {
          generationConfig: {
            maxOutputTokens: 128000,
            thinkingConfig: { thinkingBudget: 100000 },
          },
        },
      }),
    );

    expect(get(out, "request.generationConfig.maxOutputTokens")).toBe(64000);
    expect(get(out, "request.generationConfig.thinkingConfig.thinkingBudget")).toBe(63999);
    expect(get(out, "request.toolConfig.functionCallingConfig.mode")).toBe("VALIDATED");
    expect(aggregatesStream("Claude-Sonnet-4-5")).toBe(true);
    expect(aggregatesStream("Gemini-3-Pro-High")).toBe(true);
    expect(aggregatesStream("Gemini-3.1-Flash-Image")).toBe(true);
    expect(aggregatesStream("gemini-2.5-flash")).toBe(false);
  });
});

// CLIProxyAPI 531aea15: numeric protobuf Schema.Type enums are decoded before the tool schema is nested under the
// cleaner's wrapper key, where the cleaner's own normalization does not reach.
describe("numeric protobuf schema types in tool schemas", () => {
  it("decodes them before nested cleaning, so array items and placeholders survive", () => {
    const payload: Json = {
      request: {
        tools: [
          {
            functionDeclarations: [
              {
                name: "t",
                parametersJsonSchema: {
                  type: 6,
                  properties: { tags: { type: 5, items: { type: 1 } }, emptyObj: { type: 6 } },
                },
              },
            ],
          },
        ],
      },
    };

    sanitizeRequestSchemas(payload, { useAntigravitySchema: true, isClaudeModel: true });
    const parameters = "request.tools.0.functionDeclarations.0.parameters";

    expect(get(payload, `${parameters}.type`)).toBe("object");
    expect(get(payload, `${parameters}.properties.tags.type`)).toBe("array");
    expect(get(payload, `${parameters}.properties.tags.items.type`)).toBe("string");
    expect(get(payload, `${parameters}.properties.emptyObj.properties.reason.type`)).toBe("string");
  });
});

const payloadOf = (request: Json): Json => ({ request: structuredClone(request) });

/** The system instruction's text parts joined, as a prompt. */
const promptOf = (payload: Json, key = "request.systemInstruction"): string =>
  ((get(payload, key + ".parts") as Json[] | undefined) ?? [])
    .map((part) => asString(get(part, "text")))
    .join("\n");

// CLIProxyAPI 1d45a5f3 (antigravity_issue7000_test.go, antigravity_issue7000_boundary_test.go): Claude 5.5 rejects the
// forced tool use behind native structured output, so the schema moves into the system instruction as a prompt.
describe("Claude 5.5 structured output on Antigravity", () => {
  // A schema whose literals ("anthropic", "json_schema", "response_schema") must reach the prompt unmodified.
  const LITERAL_SCHEMA = {
    type: "object",
    properties: {
      anthropic: { type: "string", enum: ["anthropic", "json_schema"], const: "anthropic" },
      response_schema: { $ref: "#/$defs/anthropic" },
    },
    $defs: { anthropic: { type: "string" } },
    required: ["anthropic"],
    additionalProperties: false,
  };

  const LITERAL_SCHEMA_JSON =
    '{"type":"object","properties":{"anthropic":{"type":"string","enum":["anthropic","json_schema"],"const":"anthropic"},"response_schema":{"$ref":"#/$defs/anthropic"}},"$defs":{"anthropic":{"type":"string"}},"required":["anthropic"],"additionalProperties":false}';

  const lookupTool = {
    functionDeclarations: [
      {
        name: "lookup",
        parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      },
    ],
  };

  const NATIVE_KEYS = [
    "responseSchema",
    "responseJsonSchema",
    "response_schema",
    "response_json_schema",
    "responseMimeType",
    "response_mime_type",
  ];

  /** A request with unrelated settings in both containers and function calling in the given spelling and mode. */
  const structuredRequest = (
    systemKey: string,
    toolContainer: string,
    callingKey: string,
    mode: string,
  ): Json =>
    payloadOf({
      generationConfig: { temperature: 0.25 },
      generation_config: { stopSequences: ["STOP"] },
      [systemKey]: { role: "system", parts: [{ text: "keep system" }] },
      contents: [{ role: "user", parts: [{ text: "keep history" }] }],
      tools: [lookupTool],
      [toolContainer]: {
        [callingKey]: {
          mode,
          allowedFunctionNames: ["lookup"],
          allowed_function_names: ["lookup"],
          streamFunctionCallArguments: true,
        },
      },
    });

  const withNativeSchema = (payload: Json, container: string, schemaKey: string): Json => {
    const config = get(payload, "request." + container) as Record<string, Json>;
    config[schemaKey] = structuredClone(LITERAL_SCHEMA);
    config.responseMimeType = "application/json";
    config.response_mime_type = "application/json";

    return payload;
  };

  // Every schema alias in both containers, each with a different tool-config spelling, and forced function calling.
  it.each([
    [
      "generationConfig",
      "responseSchema",
      "toolConfig",
      "functionCallingConfig",
      "systemInstruction",
    ],
    [
      "generationConfig",
      "responseJsonSchema",
      "tool_config",
      "functionCallingConfig",
      "systemInstruction",
    ],
    [
      "generationConfig",
      "response_schema",
      "toolConfig",
      "function_calling_config",
      "systemInstruction",
    ],
    [
      "generationConfig",
      "response_json_schema",
      "tool_config",
      "function_calling_config",
      "systemInstruction",
    ],
    [
      "generation_config",
      "responseSchema",
      "toolConfig",
      "functionCallingConfig",
      "system_instruction",
    ],
    [
      "generation_config",
      "responseJsonSchema",
      "tool_config",
      "functionCallingConfig",
      "system_instruction",
    ],
    [
      "generation_config",
      "response_schema",
      "toolConfig",
      "function_calling_config",
      "system_instruction",
    ],
    [
      "generation_config",
      "response_json_schema",
      "tool_config",
      "function_calling_config",
      "system_instruction",
    ],
  ])(
    "moves the %s.%s schema into the prompt and downgrades %s.%s",
    (container, schemaKey, toolContainer, callingKey, systemKey) => {
      const payload = withNativeSchema(
        structuredRequest(systemKey, toolContainer, callingKey, "ANY"),
        container,
        schemaKey,
      );

      expect(prepareClaudeStructuredOutput("claude-opus-5-5-high", payload)).toBe(true);

      // The schema is in the prompt, complete and unmodified, after the original system text.
      expect(promptOf(payload, "request." + systemKey)).toContain(LITERAL_SCHEMA_JSON);
      expect(get(payload, "request." + systemKey + ".parts.0.text")).toBe("keep system");
      expect(get(payload, "request." + systemKey + ".role")).toBe("system");

      // Everything else stays.
      expect(get(payload, "request.generationConfig.temperature")).toBe(0.25);
      expect(get(payload, "request.generation_config.stopSequences.0")).toBe("STOP");
      expect(get(payload, "request.contents.0.parts.0.text")).toBe("keep history");
      expect(get(payload, "request.tools.0.functionDeclarations.0.name")).toBe("lookup");

      for (const config of ["generationConfig", "generation_config"]) {
        for (const key of NATIVE_KEYS) {
          expect(get(payload, "request." + config + "." + key)).toBeUndefined();
        }
      }

      const calling = "request." + toolContainer + "." + callingKey;
      expect(get(payload, calling + ".mode")).toBe("AUTO");
      expect(get(payload, calling + ".allowedFunctionNames")).toBeUndefined();
      expect(get(payload, calling + ".allowed_function_names")).toBeUndefined();
      expect(get(payload, calling + ".streamFunctionCallArguments")).toBe(true);
    },
  );

  it.each([
    ["AUTO", "AUTO", true],
    ["NONE", "NONE", true],
    ["ANY", "AUTO", false],
    ["VALIDATED", "AUTO", false],
    ["any", "AUTO", false],
  ])(
    "function calling mode %s becomes %s (allowlist kept: %s)",
    (mode, wantMode, keepsAllowlist) => {
      const payload = withNativeSchema(
        structuredRequest("systemInstruction", "toolConfig", "functionCallingConfig", mode),
        "generationConfig",
        "responseSchema",
      );

      expect(prepareClaudeStructuredOutput("claude-opus-5-5", payload)).toBe(true);
      const calling = "request.toolConfig.functionCallingConfig";
      expect(get(payload, calling + ".mode")).toBe(wantMode);
      expect(get(payload, calling + ".allowedFunctionNames") !== undefined).toBe(keepsAllowlist);
      expect(get(payload, calling + ".allowed_function_names") !== undefined).toBe(keepsAllowlist);
      expect(get(payload, calling + ".streamFunctionCallArguments")).toBe(true);
    },
  );

  it("converts once: a second call finds no schema and appends nothing", () => {
    const payload = withNativeSchema(
      structuredRequest("systemInstruction", "toolConfig", "functionCallingConfig", "ANY"),
      "generationConfig",
      "responseSchema",
    );

    expect(prepareClaudeStructuredOutput("claude-opus-5-5", payload)).toBe(true);
    const once = structuredClone(payload);
    expect(prepareClaudeStructuredOutput("claude-opus-5-5", payload)).toBe(false);
    expect(payload).toEqual(once);
    expect(get(payload, "request.systemInstruction.parts.0.text")).toBe("keep system");
    expect(get(payload, "request.systemInstruction.parts.2")).toBeUndefined();
  });

  it("creates the system instruction when the request has none", () => {
    const payload = payloadOf({
      generationConfig: {
        responseSchema: { type: "object" },
        responseMimeType: "application/json",
      },
    });

    expect(prepareClaudeStructuredOutput("claude-sonnet-5-5", payload)).toBe(true);
    expect(promptOf(payload)).toContain('{"type":"object"}');
    expect(get(payload, "request.systemInstruction.role")).toBeUndefined();
    expect(get(payload, "request.generationConfig.responseMimeType")).toBeUndefined();
  });

  it.each([
    ["claude-opus-5-5", true],
    ["claude-sonnet-5-5-high", true],
    ["claude-opus-5-5-reasoning", true],
    // The low, medium and max effort variants (CLIProxyAPI c813f779).
    ["claude-opus-5-5-low", true],
    ["claude-sonnet-5-5-medium", true],
    ["claude-opus-5-5-max-20261001", true],
    ["claude-opus-5-5-minimal", false],
    ["claude-sonnet-5-5(high)", true],
    ["claude-opus-5-5-20261001", true],
    ["claude-sonnet-5-5[1m]", true],
    ["claude-opus-5-5-20261001[1m](high)", true],
    ["claude-opus-5-50-high", false],
    ["claude-sonnet-5-50", false],
    ["claude-opus-4-6", false],
    ["claude-haiku-5-5", false],
    ["gemini-3.8-flash-high", false],
    ["other/claude-opus-5-5-high", false],
  ])("converts the schema only for model %s (%s)", (model, convert) => {
    const payload = payloadOf({
      generationConfig: {
        responseSchema: { type: "object", properties: { title: { type: "string" } } },
        responseMimeType: "application/json",
      },
    });

    expect(prepareClaudeStructuredOutput(model, payload)).toBe(convert);
    expect(get(payload, "request.generationConfig.responseSchema") === undefined).toBe(convert);
    expect(promptOf(payload) !== "").toBe(convert);
  });

  it("leaves a request without an object schema alone, and VALIDATED stays for it", () => {
    for (const generationConfig of [
      { temperature: 0.4 },
      { responseMimeType: "text/plain" },
      { responseSchema: "not an object" },
    ]) {
      const payload = payloadOf({
        generationConfig,
        systemInstruction: { parts: [{ text: "unchanged" }] },
        toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["lookup"] } },
      });

      expect(prepareClaudeStructuredOutput("claude-opus-5-5-high", payload)).toBe(false);
      expect(promptOf(payload)).toBe("unchanged");
      constrainRequestPayload("claude-opus-5-5-high", payload);
      expect(get(payload, "request.toolConfig.functionCallingConfig.mode")).toBe("VALIDATED");
    }
  });

  it("does not restore VALIDATED after the schema became a prompt", () => {
    const payload = payloadOf({
      generationConfig: { responseSchema: { type: "object" } },
      tools: [lookupTool],
      toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["lookup"] } },
    });

    constrainRequestPayload("claude-opus-5-5-high", payload);
    expect(get(payload, "request.toolConfig.functionCallingConfig.mode")).toBe("AUTO");
    // A request without any tool config keeps none instead of gaining VALIDATED.
    const bare = payloadOf({ generationConfig: { responseSchema: { type: "object" } } });
    constrainRequestPayload("claude-sonnet-5-5", bare);
    expect(get(bare, "request.toolConfig")).toBeUndefined();
    expect(promptOf(bare)).toContain('{"type":"object"}');
  });
});

describe("content fixes", () => {
  it("reorders function responses, repairs names and gives response-only turns the model role", () => {
    const payload: Json = {
      request: {
        contents: [
          { role: "user", parts: [{ text: "go" }] },
          {
            role: "model",
            parts: [
              { functionCall: { id: "a", name: "first", args: {} } },
              { functionCall: { id: "b", name: "second", args: {} } },
            ],
          },
          {
            role: "user",
            parts: [
              { functionResponse: { id: "b", name: "unknown", response: {} } },
              { functionResponse: { id: "a", name: "", response: {} } },
            ],
          },
        ],
      },
    };

    normalizeFunctionResponseRoles(payload);
    expect(get(payload, "request.contents.2.role")).toBe("model");
    expect(get(payload, "request.contents.2.parts.0.functionResponse.id")).toBe("a");
    expect(get(payload, "request.contents.2.parts.0.functionResponse.name")).toBe("first");
    expect(get(payload, "request.contents.2.parts.1.functionResponse.name")).toBe("second");
  });

  it("applies the reasoning-replay model rule", () => {
    expect(usesReasoningReplay("gemini-3-pro")).toBe(true);
    expect(usesReasoningReplay("claude-sonnet-4-5")).toBe(false);
    expect(usesReasoningReplay("gpt-oss-120b")).toBe(false);
  });
});

/** One streamed Antigravity response with a single text part. */
const text = (value: string) => ({ candidates: [{ content: { parts: [{ text: value }] } }] });

describe("SSE handling", () => {
  const data = (value: Json) => `data: ${JSON.stringify(value)}`;

  it("renames usage on non-terminal chunks and lets the follow-up usage of a stop chunk through", () => {
    const filter = new UsageFilter();

    const partial = filter.filter(
      data({ response: { candidates: [{}], usageMetadata: { a: 1 } }, traceId: "t" }),
    );

    expect(partial).toContain("cpaUsageMetadata");
    expect(partial).not.toContain('"usageMetadata"');
    const stop = data({ response: { candidates: [{ finishReason: "STOP" }] }, traceId: "t" });
    expect(filter.filter(stop)).toBe(stop);
    const usage = data({ response: { candidates: [{}], usageMetadata: { a: 2 } }, traceId: "t" });
    expect(filter.filter(usage)).toBe(usage);
    // Only once: the next non-terminal usage is renamed again.
    expect(filter.filter(usage)).toContain("cpaUsageMetadata");

    const terminal = data({
      response: { candidates: [{ finishReason: "STOP" }], usageMetadata: { a: 3 } },
    });

    expect(filter.filter(terminal)).toBe(terminal);
  });

  it("joins JSON split over several lines like Go's SSE assembler (CLIProxyAPI 892fc486)", () => {
    const assembler = new JsonAssembler();
    expect(assembler.push('data: {"response":')).toBeUndefined();
    // Comments and other fields inside an event are skipped; a bare line does not continue a `data:` payload.
    expect(assembler.push(": keep-alive")).toBeUndefined();
    expect(assembler.push('{"ignored":1}')).toBeUndefined();
    expect(assembler.push('data: {"x":1}}')).toBe('{"response":\n{"x":1}}');
    // A malformed event ends at its empty line and does not swallow the next one.
    expect(assembler.push('data: {"broken":')).toBeUndefined();
    expect(assembler.push("")).toBeUndefined();
    expect(assembler.push('data: {"ok":true}')).toBe('{"ok":true}');
    // Raw JSON lines (no `data:`) continue with raw lines.
    expect(assembler.push('{"a":')).toBeUndefined();
    expect(assembler.push("2}")).toBe('{"a":\n2}');
  });

  it("reads in-band error objects as statuses (antigravityInBandErrorStatusCode)", () => {
    expect(inBandErrorStatus({ error: { code: 503, message: "down" } })).toBe(503);
    expect(inBandErrorStatus({ error: { code: 200, message: "?" } })).toBe(502);
    expect(inBandErrorStatus({ error: "text" })).toBe(502);
    expect(inBandErrorStatus({ error: null })).toBeUndefined();
    expect(inBandErrorStatus({ response: {} })).toBeUndefined();
  });

  it("merges a streamed response: text runs, thoughts with signatures, calls and the last usage", () => {
    const lines = [
      {
        response: {
          candidates: [{ content: { role: "model", parts: [{ text: "think ", thought: true }] } }],
        },
        traceId: "t0",
      },
      {
        response: {
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ text: "more", thought: true, thoughtSignature: "sig" }],
              },
            },
          ],
        },
      },
      { response: { candidates: [{ content: { parts: [{ text: "Hel" }] } }] } },
      { response: { candidates: [{ content: { parts: [{ text: "lo" }] } }] } },
      {
        response: {
          candidates: [
            {
              content: { parts: [{ functionCall: { name: "f", args: {} } }] },
              finishReason: "STOP",
            },
          ],
          usageMetadata: { promptTokenCount: 1 },
          modelVersion: "m",
          responseId: "r",
        },
        traceId: "t1",
      },
    ].map((line) => JSON.stringify(line));

    const merged = convertStreamToNonStream(lines);
    expect(get(merged, "traceId")).toBe("t1");
    expect(get(merged, "response.candidates.0.content.parts")).toEqual([
      { text: "think more", thought: true, thoughtSignature: "sig" },
      { text: "Hello" },
      { functionCall: { name: "f", args: {} } },
    ]);
    expect(get(merged, "response.candidates.0.finishReason")).toBe("STOP");
    expect(get(merged, "response.usageMetadata.promptTokenCount")).toBe(1);
    expect(get(convertStreamToNonStream([]), "response.usageMetadata.totalTokenCount")).toBe(0);
  });

  it("keeps text signatures, empty-text carriers and same-chunk part boundaries (Go 9176cb22)", () => {
    const chunk = (parts: Json[]): string =>
      JSON.stringify({ response: { candidates: [{ content: { parts } }] } });

    const merged = convertStreamToNonStream([
      chunk([{ text: "a" }, { text: "b" }]),
      chunk([{ text: " " }]),
      chunk([
        { text: "", thoughtSignature: "s1" },
        { text: "", thoughtSignature: "s2" },
      ]),
      chunk([{ text: "signed", thoughtSignature: "s3" }]),
      chunk([{ text: "after" }]),
    ]);

    expect(get(merged, "response.candidates.0.content.parts")).toEqual([
      { text: "a" },
      { text: "b " },
      { text: "", thoughtSignature: "s1" },
      { text: "", thoughtSignature: "s2" },
      { text: "signed", thoughtSignature: "s3" },
      { text: "after" },
    ]);
  });

  it("keeps grounding from an earlier chunk when the terminal chunk has none (Go d0da9a9a)", () => {
    const grounding = { groundingChunks: [{ web: { uri: "https://example.com" } }] };

    const merged = convertStreamToNonStream([
      JSON.stringify({
        response: {
          candidates: [{ content: { parts: [{ text: "x" }] }, groundingMetadata: grounding }],
        },
      }),
      JSON.stringify({
        response: { candidates: [{ content: { parts: [] }, finishReason: "STOP" }] },
      }),
    ]);

    expect(get(merged, "response.candidates.0.groundingMetadata")).toEqual(grounding);
  });

  it("keeps the usage of a stream without a terminal usage chunk (Go d5eb4ca1)", () => {
    const nonTerminal = convertStreamToNonStream([
      JSON.stringify({ response: { ...text("a"), usageMetadata: { totalTokenCount: 30 } } }),
    ]);

    expect(get(nonTerminal, "response.usageMetadata.totalTokenCount")).toBe(30);

    const renamed = convertStreamToNonStream([
      JSON.stringify({ response: { ...text("a"), cpaUsageMetadata: { totalTokenCount: 7 } } }),
      JSON.stringify({ response: { ...text("b"), cpaUsageMetadata: { totalTokenCount: 9 } } }),
    ]);

    expect(get(renamed, "response.usageMetadata.totalTokenCount")).toBe(7);
    expect(get(renamed, "response.cpaUsageMetadata")).toBeUndefined();

    const terminalWins = convertStreamToNonStream([
      JSON.stringify({ response: { ...text("a"), cpaUsageMetadata: { totalTokenCount: 7 } } }),
      JSON.stringify({ response: { ...text("b"), usageMetadata: { totalTokenCount: 12 } } }),
    ]);

    expect(get(terminalWins, "response.usageMetadata.totalTokenCount")).toBe(12);
  });
});

describe("state and credits", () => {
  it("tracks short cooldowns in memory", async () => {
    const state = makeMemoryAntigravityState(GLOBAL_ORG);
    await state.markShortCooldown("a", "m", 30_000, 1000);
    expect(await state.shortCooldownRemaining("a", "m", 11_000)).toBe(20_000);
    expect(await state.shortCooldownRemaining("a", "m", 40_000)).toBe(0);
    expect(await state.shortCooldownRemaining("b", "m", 1000)).toBe(0);
  });

  it("persists short cooldowns and credits in KV and degrades without state", async () => {
    const state = makeKvAntigravityState(orgKv(env.CACHE, GLOBAL_ORG));
    const id = `kv-${crypto.randomUUID()}`;
    await state.markShortCooldown(id, "claude-x", 30_000, 1_000);
    expect(await state.shortCooldownRemaining(id, "claude-x", 11_000)).toBe(20_000);
    expect(await state.credits(id)).toBeUndefined();
    expect(creditsAvailable(await state.credits(id))).toBe(true);
    await state.markCreditsExhausted(id, 5);
    expect(creditsAvailable(await state.credits(id))).toBe(false);
    await state.setCredits(id, {
      creditAmount: 50,
      minCreditAmount: 1,
      paidTierId: "t",
      updatedAt: 6,
    });
    expect(creditsAvailable(await state.credits(id))).toBe(true);
    expect(await state.claimCreditsRefresh(id, 7)).toBe(true);
    expect(await state.claimCreditsRefresh(id, 8)).toBe(false);
  });

  it("keeps each org's cooldowns, credits and probe slot apart; global keeps its keys", async () => {
    const acme = OrgId.make("acme");
    const id = `org-${crypto.randomUUID()}`;
    const global = makeKvAntigravityState(orgKv(env.CACHE, GLOBAL_ORG));
    const scoped = antigravityStateFor(env, acme);

    await global.markShortCooldown(id, "claude-x", 30_000, 1_000);
    await global.markCreditsExhausted(id, 5);
    expect(await scoped.shortCooldownRemaining(id, "claude-x", 2_000)).toBe(0);
    expect(await scoped.credits(id)).toBeUndefined();
    expect(await env.CACHE.get(`ag:credits:${id}`)).not.toBeNull();

    await scoped.markShortCooldown(id, "claude-x", 60_000, 1_000);
    expect(await env.CACHE.get(`org.acme.ag:credits:${id}`)).toBeNull();
    expect(await scoped.shortCooldownRemaining(id, "claude-x", 2_000)).toBe(59_000);
    expect(await global.shortCooldownRemaining(id, "claude-x", 2_000)).toBe(29_000);

    const now = Date.now();
    expect(await sessionStateCreditsClaim(env.SESSION_STATE, GLOBAL_ORG)(id, now)).toBe(true);
    expect(await sessionStateCreditsClaim(env.SESSION_STATE, acme)(id, now)).toBe(true);
    expect(await sessionStateCreditsClaim(env.SESSION_STATE, acme)(id, now + 1)).toBe(false);

    const memoryGlobal = makeMemoryAntigravityState(GLOBAL_ORG);
    await memoryGlobal.markCreditsExhausted(id, now);
    expect(await makeMemoryAntigravityState(acme).credits(id)).toBeUndefined();
  });

  it("claims the credits probe slot atomically in the SessionState Durable Object", async () => {
    const claim = sessionStateCreditsClaim(env.SESSION_STATE, GLOBAL_ORG);
    const id = `lock-${crypto.randomUUID()}`;
    const now = Date.now();
    // Concurrent claims of one credential: exactly one wins (KV get-then-put let both through).
    const results = await Promise.all(Array.from({ length: 8 }, () => claim(id, now)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await claim(id, now + CREDITS_REFRESH_INTERVAL_MS - 1)).toBe(false);
    // The slot expires with its TTL.
    expect(await claim(id, now + CREDITS_REFRESH_INTERVAL_MS + 1)).toBe(true);
    expect(await claim(`other-${id}`, now)).toBe(true);
    // The production store uses it whenever the binding exists.
    const state = antigravityStateFor(env, GLOBAL_ORG);
    const second = `lock-${crypto.randomUUID()}`;
    expect(await state.claimCreditsRefresh(second, now)).toBe(true);
    expect(await state.claimCreditsRefresh(second, now + 1)).toBe(false);
  });

  it("sends the credits probe to a custom base_url", async () => {
    const calls: Array<UpstreamCall> = [];

    const credential = {
      attributes: { base_url: "https://custom.example/" },
      metadata: {},
    } as unknown as CredentialSnapshot;

    await Effect.runPromise(
      probeCredits(
        credential,
        "tok",
        "ua",
        makeKvAntigravityState(orgKv(env.CACHE, GLOBAL_ORG)),
        1,
      ).pipe(Effect.provide(mockHttpClient(calls, () => Response.json({})))),
    );

    expect(calls[0]?.url).toBe("https://custom.example/v1internal:loadCodeAssist");
  });

  it("probes the credits balance on the daily endpoint without an Accept header", async () => {
    const calls: Array<UpstreamCall> = [];
    const credential = { attributes: {}, metadata: {} } as unknown as CredentialSnapshot;

    await Effect.runPromise(
      probeCredits(
        credential,
        "tok",
        "antigravity/hub/2.29.0",
        makeKvAntigravityState(orgKv(env.CACHE, GLOBAL_ORG)),
        1,
      ).pipe(Effect.provide(mockHttpClient(calls, () => Response.json({})))),
    );

    expect(calls[0]?.url).toBe(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    );
    expect(calls[0]?.headers["accept"]).toBeUndefined();
    expect(calls[0]?.headers["user-agent"]).toBe("antigravity/hub/2.29.0");
  });

  it("parses the loadCodeAssist credits reply", () => {
    const reply = {
      paidTier: {
        id: "g1-pro-tier",
        availableCredits: [
          { creditType: "OTHER", creditAmount: "9", minimumCreditAmountForUsage: "1" },
          { creditType: "google_one_ai", creditAmount: "25000", minimumCreditAmountForUsage: "50" },
        ],
      },
    };

    expect(parseCreditsReply(reply, 1)).toEqual({
      known: true,
      record: {
        creditAmount: 25_000,
        minCreditAmount: 50,
        paidTierId: "g1-pro-tier",
        updatedAt: 1,
      },
    });
    expect(parseCreditsReply({ paidTier: { id: "x" } }, 1).record).toMatchObject({
      creditAmount: 0,
      minCreditAmount: 1,
    });
    expect(parseCreditsReply({ paidTier: { availableCredits: [] } }, 1).known).toBe(false);
  });
});

describe("version", () => {
  it("parses the Hub manifest strictly and falls back when missing or expired", () => {
    expect(parseManifestVersion("version: 2.10.3\npath: x\n")).toBe("2.10.3");
    expect(parseManifestVersion("version: '3.0.1'")).toBe("3.0.1");
    expect(parseManifestVersion("version: 2.10")).toBeUndefined();
    expect(parseManifestVersion("other: 1")).toBeUndefined();
    const fresh = JSON.stringify({ version: "2.12.0", fetchedAt: 1000 });
    expect(resolveStoredVersion(fresh, 1000 + 60_000)).toBe("2.12.0");
    expect(resolveStoredVersion(fresh, 1000 + 7 * 3_600_000)).toBe(ANTIGRAVITY_FALLBACK_VERSION);
    expect(resolveStoredVersion(null, 0)).toBe(ANTIGRAVITY_FALLBACK_VERSION);
  });

  it("builds user agents like Go", () => {
    expect(ANTIGRAVITY_HUB_CHANGELISTS.get(ANTIGRAVITY_FALLBACK_VERSION)).toBeDefined();

    for (const configured of [
      "antigravity/hub/2.24.0 darwin/arm64",
      "antigravity/hub/2.24.0 (aidev_client; os_type=darwin; arch=arm64; cl=1000335682)",
      "antigravity/hub/2.24.0 (aidev_client; os_type=darwin; arch=arm64; cl=1000335682) google-api-nodejs-client/10.3.0",
    ]) {
      expect(antigravityVersionFromUserAgent(configured, "2.29.0")).toBe("2.24.0");
    }

    expect(antigravityRequestUserAgent("", "2.29.0")).toBe(
      "antigravity/hub/2.29.0 (aidev_client; os_type=darwin; arch=arm64; cl=1013060670)",
    );
    // Unknown releases keep their online version without claiming another build's changelist.
    expect(antigravityRequestUserAgent("", "2.30.0")).toBe(
      "antigravity/hub/2.30.0 (aidev_client; os_type=darwin; arch=arm64)",
    );
    expect(
      antigravityRequestUserAgent(
        "antigravity/hub/2.1.0 linux/x64 google-api-nodejs-client/10.3.0",
        "2.9.1",
      ),
    ).toBe("antigravity/hub/2.1.0 linux/x64");
    expect(antigravityRequestUserAgent("custom/1", "2.9.1")).toBe("custom/1");
    expect(antigravityVersionFromUserAgent("antigravity/2.4.6 darwin/arm64", "2.9.1")).toBe(
      "2.4.6",
    );
    expect(antigravityVersionFromUserAgent("custom/1", "2.9.1")).toBe("2.9.1");
  });

  it("stores the fetched version in KV and keeps the old value when the fetch fails", async () => {
    const calls: UpstreamCall[] = [];

    const run = (respond: () => Response) =>
      Effect.runPromise(
        refreshAntigravityVersion.pipe(
          Effect.provide(Layer.mergeAll(mockHttpClient(calls, respond))),
          Effect.provideContext(envContext(env)),
        ),
      );

    resetAntigravityVersionCache();
    expect(await run(() => new Response("version: 2.11.0\n"))).toEqual({ version: "2.11.0" });
    expect(calls[0]?.url).toContain("manifest/latest-arm64-mac.yml");
    expect(calls[0]?.headers["user-agent"]).toBe("electron-builder");
    expect(JSON.parse((await env.CACHE.get(ANTIGRAVITY_VERSION_KEY)) ?? "{}").version).toBe(
      "2.11.0",
    );
    expect(await run(() => new Response("nope", { status: 500 }))).toEqual({ version: undefined });
    expect(JSON.parse((await env.CACHE.get(ANTIGRAVITY_VERSION_KEY)) ?? "{}").version).toBe(
      "2.11.0",
    );
  });
});

describe("model catalog probes", () => {
  it("parses entitlements and web search ids; legacy replies never revoke models", () => {
    expect(
      parseModelHints(
        JSON.stringify({
          models: { "Claude-X ": {}, "gemini-y": {} },
          webSearchModelIds: [" Gemini-Y"],
        }),
      ),
    ).toEqual({
      modelIds: ["claude-x", "gemini-y"],
      webSearchModelIds: ["gemini-y"],
    });
    expect(parseModelHints(JSON.stringify({ webSearchModelIds: ["a"] }))).toEqual({
      webSearchModelIds: ["a"],
    });
    expect(parseModelHints("not json")).toBeUndefined();
  });

  it("intersects the static list with the entitlements and flags web search", () => {
    const catalog = sectionModels(embeddedCatalogs(), "antigravity");
    expect(catalog.length).toBeGreaterThan(1);
    const keep = catalog[0]?.id ?? "";

    const filtered = applyAntigravityHints(catalog, {
      modelIds: [keep.toLowerCase()],
      webSearchModelIds: [keep.toLowerCase()],
    });

    expect(filtered.map((model) => model.id)).toEqual([keep]);
    expect(filtered[0]?.supportsWebSearch).toBe(true);
    expect(applyAntigravityHints(catalog, { webSearchModelIds: [] })).toHaveLength(catalog.length);
    expect(applyAntigravityHints(catalog, undefined)).toBe(catalog);
  });

  it("backs off 2, 4, 8, 16, 30 min with equal jitter and resets after a long quiet period", () => {
    let state = nextFailure(undefined, 0, 0);
    expect(state).toMatchObject({ count: 1, nextRetryAt: 60_000 });
    state = nextFailure(state, 1000, 1);
    expect(state).toMatchObject({ count: 2, nextRetryAt: 1000 + 240_000 });

    for (let i = 0; i < 10; i++) state = nextFailure(state, 2000, 1);
    expect(state.count).toBe(5);
    expect(state.nextRetryAt).toBe(2000 + 30 * 60_000);
    expect(nextFailure(state, 2000 + 7 * 3_600_000, 0).count).toBe(1);
  });

  it("loads stored hints and the cron task probes enabled credentials through the ControlPlane", async () => {
    const id = `antigravity-${crypto.randomUUID()}.json`;
    const calls: UpstreamCall[] = [];
    await env.CACHE.put(
      "ag:models:known",
      JSON.stringify({ hints: { modelIds: ["a"], webSearchModelIds: [] }, fetchedAt: 1 }),
    );
    expect([
      ...(await loadAntigravityHints(orgKv(env.CACHE, GLOBAL_ORG), ["known", "missing"])).keys(),
    ]).toEqual(["known"]);

    const plane = {
      listModelSources: async () => [
        { id, provider: "antigravity", disabled: false },
        { id: "other", provider: "claude", disabled: false },
        { id: "off", provider: "antigravity", disabled: true },
      ],
      ensureFresh: async () => ({
        ok: true,
        refreshed: false,
        credential: { attributes: {}, metadata: { access_token: "tok", project_id: "proj" } },
      }),
    };

    const stubEnv = {
      ...env,
      CONTROL_PLANE: { getByName: () => ({ models: () => plane }) },
    } as unknown as Cloudflare.Env;

    const results = await Effect.runPromise(
      refreshAntigravityModels.pipe(
        Effect.provide(
          mockHttpClient(calls, () =>
            Response.json({
              models: { "claude-sonnet-4-5": {}, "gemini-3-pro-high": {} },
              webSearchModelIds: ["gemini-3-pro-high"],
            }),
          ),
        ),
        Effect.provideContext(envContext(stubEnv)),
        Effect.provideService(CurrentOrg, GLOBAL_ORG),
      ),
    );

    expect(results).toEqual([{ id, status: "success" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
    );
    expect(calls[0]?.headers["authorization"]).toBe("Bearer tok");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ project: "proj" });
    const stored = (await loadAntigravityHints(orgKv(env.CACHE, GLOBAL_ORG), [id])).get(id);
    expect(stored).toEqual({
      modelIds: ["claude-sonnet-4-5", "gemini-3-pro-high"],
      webSearchModelIds: ["gemini-3-pro-high"],
    });

    // A failing probe keeps the last good entitlements and records the failure.
    const failed = await Effect.runPromise(
      refreshAntigravityModels.pipe(
        Effect.provide(mockHttpClient(calls, () => new Response("down", { status: 503 }))),
        Effect.provideContext(envContext(stubEnv)),
        Effect.provideService(CurrentOrg, GLOBAL_ORG),
      ),
    );

    expect(failed).toEqual([{ id, status: "transient" }]);
    expect((await loadAntigravityHints(orgKv(env.CACHE, GLOBAL_ORG), [id])).get(id)).toEqual(
      stored,
    );

    // The failure window suppresses the next probe.
    const backoff = await Effect.runPromise(
      refreshAntigravityModels.pipe(
        Effect.provide(mockHttpClient(calls, () => new Response("never", { status: 500 }))),
        Effect.provideContext(envContext(stubEnv)),
        Effect.provideService(CurrentOrg, GLOBAL_ORG),
      ),
    );

    expect(backoff).toEqual([{ id, status: "backoff" }]);
  });
});

describe("signature cache", () => {
  it("returns the Gemini sentinel on a miss, slides the TTL and bounds writes", () => {
    let now = 0;
    const cache = new MemorySignatureCache(() => now);
    expect(cache.get("gemini-3-pro", "text")).toBe("skip_thought_signature_validator");
    expect(cache.get("claude-x", "text")).toBe("");
    expect(cache.set("claude-x", "text", "short")).toBe(false);
    expect(cache.set("claude-x", "text", LONG_SIGNATURE)).toBe(true);
    // gpt/claude/gemini models share a bucket per family.
    expect(cache.get("claude-opus", "text")).toBe(LONG_SIGNATURE);
    now += SIGNATURE_CACHE_TTL_MS - 1;
    expect(cache.get("claude-x", "text")).toBe(LONG_SIGNATURE);
    now += SIGNATURE_CACHE_TTL_MS - 1;
    expect(cache.get("claude-x", "text")).toBe(LONG_SIGNATURE);
    now += SIGNATURE_CACHE_TTL_MS + 1;
    expect(cache.get("claude-x", "text")).toBe("");
  });

  it("scopes the ambient cache to a synchronous call and persists writes best-effort through the store", async () => {
    // The global org's cache is the isolate default the translators read outside an attempt.
    expect(DEFAULT_SIGNATURE_SCOPE).toBe(GLOBAL_ORG);
    const cache = new MemorySignatureCache();
    withSignatureContext({ cache }, () => {
      expect(cacheSignature("claude-x", "thought", LONG_SIGNATURE)).toBe(true);
      expect(getCachedSignature("claude-x", "thought")).toBe(LONG_SIGNATURE);
    });
    const store = makeMemorySignatureStore();
    await flushSignatureWrites(cache, store);
    expect(store.entries.get(signatureStoreKey("claude-x", "thought"))).toBe(LONG_SIGNATURE);
    // A fresh isolate prefetches before translating and never rewrites what it only read.
    const other = new MemorySignatureCache();
    await prefetchSignatures(other, store, "claude-x", ["thought", "unknown", ""]);
    expect(other.get("claude-x", "thought")).toBe(LONG_SIGNATURE);
    expect(other.drainPendingWrites()).toEqual([]);
  });

  it("survives a failing store", async () => {
    const cache = new MemorySignatureCache();
    cache.set("claude-x", "t", LONG_SIGNATURE);

    const broken = {
      get: async () => {
        throw new Error("kv down");
      },
      put: async () => {
        throw new Error("kv down");
      },
      delete: async () => {},
    };

    await expect(flushSignatureWrites(cache, broken)).resolves.toBeUndefined();
    const throwing = new MemorySignatureCache();
    await expect(prefetchSignatures(throwing, broken, "claude-x", ["a"])).resolves.toBeUndefined();
  });
});

describe("claude web search grounding", () => {
  const grounding = {
    webSearchQueries: ["capital of france"],
    groundingChunks: [
      { web: { uri: "https://a.test/x", title: "A" } },
      { web: { uri: "https://a.test/x" } },
    ],
    groundingSupports: [
      { segment: { startIndex: 0, endIndex: 5, text: "Paris" }, groundingChunkIndices: [0] },
    ],
  };

  const original = { tools: [{ type: "web_search_20250305", name: "web_search" }] };
  const translated = { model: "m", request: { tools: [{ googleSearch: {} }] } };

  const reply = {
    response: {
      candidates: [
        {
          content: { role: "model", parts: [{ text: "Paris is it" }] },
          groundingMetadata: grounding,
        },
      ],
    },
  };

  it("turns grounding metadata into server_tool_use, results and cited text (non-stream)", () => {
    const out = builtinTranslators.translateNonStream(
      "claude",
      "antigravity",
      {
        model: "m",
        originalRequest: original,
        translatedRequest: translated,
        state: makeTranslationState(),
      },
      JSON.stringify(reply),
    );

    const message = JSON.parse(out ?? "{}") as {
      content: Array<Record<string, unknown>>;
      usage: Record<string, unknown>;
    };

    expect(message.content.map((block) => block["type"])).toEqual([
      "server_tool_use",
      "web_search_tool_result",
      "text",
      "text",
    ]);
    expect(message.content[2]?.["citations"]).toEqual([
      {
        cited_text: "Paris",
        title: "A",
        type: "web_search_result_location",
        url: "https://a.test/x",
      },
    ]);
    expect(message.usage["server_tool_use"]).toEqual({ web_search_requests: 1 });
  });

  it("emits the same blocks as stream events and finalises after usage", () => {
    const state = makeTranslationState();
    const context = { model: "m", originalRequest: original, translatedRequest: translated, state };

    const first = builtinTranslators.translateStream(
      "claude",
      "antigravity",
      context,
      JSON.stringify(reply),
    );

    expect(first.join("")).toContain('"type":"server_tool_use"');
    expect(first.join("")).toContain('"type":"citations_delta"');

    const last = builtinTranslators.translateStream(
      "claude",
      "antigravity",
      context,
      JSON.stringify({
        response: {
          candidates: [{ finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 },
        },
      }),
    );

    expect(last.join("")).toContain('"web_search_requests":1');
  });
});

// CLIProxyAPI 85225381, 06225fcf (antigravitySignatureCacheScope): one credential's signatures stay its own.
describe("antigravity signature scope", () => {
  const grant = { refresh_token: "1//refresh", access_token: "ya29.first", project_id: "proj" };

  it("keys the scope by credential, grant and stored project, and keeps it across an access-token refresh", () => {
    const scope = antigravitySignatureScope("cred-a", grant);
    expect(scope).toContain("id:cred-a");
    expect(scope).not.toContain("1//refresh");
    expect(antigravitySignatureScope("cred-a", { ...grant, access_token: "ya29.next" })).toBe(
      scope,
    );
    expect(antigravitySignatureScope("cred-b", grant)).not.toBe(scope);
    expect(antigravitySignatureScope("cred-a", { ...grant, project_id: "other" })).not.toBe(scope);
    expect(antigravitySignatureScope("cred-a", { ...grant, refresh_token: "1//relogin" })).not.toBe(
      scope,
    );
    // Without a refresh token the access token is the grant; without either there is no scope.
    expect(antigravitySignatureScope("cred-a", { access_token: "ya29.x" })).not.toBe("");
    expect(antigravitySignatureScope("cred-a", {})).toBe("");
  });

  it("isolates two credentials in one org cache and fails closed without a scope", async () => {
    const base = new MemorySignatureCache();
    const a = scopedSignatureCache(base, antigravitySignatureScope("cred-a", grant));
    const b = scopedSignatureCache(base, antigravitySignatureScope("cred-b", grant));
    const none = scopedSignatureCache(base, "");

    expect(a.set("claude-x", "thought", LONG_SIGNATURE)).toBe(true);
    expect(a.get("claude-x", "thought")).toBe(LONG_SIGNATURE);
    expect(b.get("claude-x", "thought")).toBe("");
    expect(base.get("claude-x", "thought")).toBe("");
    expect(none.set("claude-x", "thought", LONG_SIGNATURE)).toBe(false);
    expect(none.get("claude-x", "thought")).toBe("");

    // The persisted key carries the scope too, so a prefetch for another credential finds nothing.
    const store = makeMemorySignatureStore();
    await flushSignatureWrites(base, store);
    expect(store.entries.size).toBe(1);
    expect(store.entries.has(signatureStoreKey("claude-x", "thought"))).toBe(false);
    const fresh = new MemorySignatureCache();
    const scopeB = antigravitySignatureScope("cred-b", grant);
    await prefetchSignatures(fresh, store, "claude-x", [scopedSignatureText(scopeB, "thought")]);
    expect(fresh.size).toBe(0);
    const scopeA = antigravitySignatureScope("cred-a", grant);
    await prefetchSignatures(fresh, store, "claude-x", [scopedSignatureText(scopeA, "thought")]);
    expect(scopedSignatureCache(fresh, scopeA).get("claude-x", "thought")).toBe(LONG_SIGNATURE);
  });
});
