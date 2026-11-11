// The reasoning-signature policy of the Responses executors (Go openai_responses_signature_test.go: 7a0b7563, 674dbe8f,
// cc5682c5, be9fbd94, a68c7d8e): which `encrypted_content` replays to which upstream, by target family and base URL.
import { describe, expect, it } from "vitest";
import { get, type Json } from "@commissary/json";
import {
  canonicalReasoningSignatureKey,
  isNativeMetaUpstreamUrl,
  isOpenRouterUpstreamUrl,
  reasoningOptionsForMeta,
  reasoningOptionsForTarget,
  sanitizeReasoningEncryptedContent,
} from "../../src/executor/helps/responses-signature.ts";
import {
  claudeSignature,
  gptSignature,
  metaSignature,
  routerSuffixed,
} from "../support/signatures.ts";

const reasoning = (encrypted: string, extra: Record<string, Json> = {}): Json => ({
  type: "reasoning",
  summary: [],
  encrypted_content: encrypted,
  ...extra,
});

const body = (...items: Json[]): Json => ({ store: false, input: items });

const encryptedOf = (out: Json, index: number): Json | undefined =>
  get(out, `input.${index}.encrypted_content`);

const OPENROUTER = "https://openrouter.ai/api/v1";

const OFFICIAL = "https://chatgpt.com/backend-api/codex";

describe("upstream hosts", () => {
  it("recognises the native Meta host and OpenRouter", () => {
    expect(isNativeMetaUpstreamUrl("")).toBe(true);
    expect(isNativeMetaUpstreamUrl("https://api.meta.ai/api/v1")).toBe(true);
    expect(isNativeMetaUpstreamUrl("https://eu.meta.ai/v1")).toBe(true);
    expect(isNativeMetaUpstreamUrl("https://openrouter.ai/api/v1")).toBe(false);
    expect(isNativeMetaUpstreamUrl("https://example-proxy.internal/v1")).toBe(false);

    expect(isOpenRouterUpstreamUrl("https://openrouter.ai/api/v1")).toBe(true);
    expect(isOpenRouterUpstreamUrl("https://eu.openrouter.ai/api/v1")).toBe(true);
    expect(isOpenRouterUpstreamUrl("https://notopenrouter.ai/v1")).toBe(false);
    expect(isOpenRouterUpstreamUrl("https://chatgpt.com/backend-api/codex")).toBe(false);
    expect(isOpenRouterUpstreamUrl("")).toBe(false);
  });
});

describe("upstream host look-alikes", () => {
  it.each([
    "https://evil-openrouter.ai.example/v1",
    "https://evil-openrouter.ai/v1",
    "https://openrouter.ai.evil.com/v1",
    "https://openrouter.ai@evil.com/v1",
    "https://evil.com/openrouter.ai",
    "OPENROUTER.AI",
    "openrouter.ai/api/v1",
  ])("%s is not OpenRouter", (url) => {
    expect(isOpenRouterUpstreamUrl(url)).toBe(false);
  });

  it.each([
    "https://OPENROUTER.AI/api/v1",
    "https://OpenRouter.ai",
    "https://openrouter.ai:443/api/v1",
    "https://user@openrouter.ai/api/v1",
  ])("%s is OpenRouter", (url) => {
    expect(isOpenRouterUpstreamUrl(url)).toBe(true);
  });

  it.each([
    "https://api.meta.ai.evil.com/v1",
    "https://evilmeta.ai/v1",
    "https://meta.ai@evil.com/v1",
    "https://evil.com/api.meta.ai",
  ])("%s is not the native Meta host", (url) => {
    expect(isNativeMetaUpstreamUrl(url)).toBe(false);
  });

  it("keeps the router suffix only on the real OpenRouter host", () => {
    const routed = routerSuffixed(gptSignature(), 79);

    for (const [baseUrl, kept] of [
      ["https://openrouter.ai/api/v1", true],
      ["https://evil-openrouter.ai.example/v1", false],
      ["https://openrouter.ai@evil.com/v1", false],
    ] as const) {
      const out = sanitizeReasoningEncryptedContent(
        body(reasoning(routed)),
        reasoningOptionsForTarget({ isCompat: false, targetModel: "gpt-5.4", baseUrl }),
      );

      expect(encryptedOf(out, 0), baseUrl).toBe(kept ? routed : gptSignature());
    }
  });
});

describe("orphan ids, reasoning content and unknown blobs", () => {
  it("strips invalid encrypted_content and the orphan ids behind it when store is disabled", () => {
    const out = sanitizeReasoningEncryptedContent(
      body(
        reasoning("bad", { id: "rs_bad" }),
        { id: "rs_orphan", type: "reasoning", summary: [] },
        reasoning(gptSignature(), { id: "rs_good" }),
      ),
    );

    expect(encryptedOf(out, 0)).toBeUndefined();
    expect(get(out, "input.0.id")).toBeUndefined();
    expect(get(out, "input.1.id")).toBeUndefined();
    expect(encryptedOf(out, 2)).toBe(gptSignature());
    expect(get(out, "input.2.id")).toBe("rs_good");
  });

  it("moves cleartext reasoning into an empty summary, but keeps content and ids for compat models", () => {
    const item = (): Json =>
      reasoning(gptSignature(), {
        id: "rs_1",
        content: [{ type: "reasoning_text", text: "cleartext thinking" }],
      });

    const plain = sanitizeReasoningEncryptedContent(body(item()));

    expect(get(plain, "input.0.content")).toEqual([]);
    expect(get(plain, "input.0.summary.0.text")).toBe("cleartext thinking");

    const compat = sanitizeReasoningEncryptedContent(body(item()), {
      isCompat: true,
      keepForeign: true,
    });

    expect(get(compat, "input.0.content.0.text")).toBe("cleartext thinking");
    expect(get(compat, "input.0.summary")).toEqual([]);
  });

  it("replays an unknown-format blob only when foreign blobs are kept, and never a Claude signature", () => {
    const input = (): Json =>
      body(
        reasoning("opaque-encrypted-reasoning-token-xyz"),
        reasoning(""),
        reasoning(claudeSignature()),
      );

    const kept = sanitizeReasoningEncryptedContent(input(), { isCompat: true, keepForeign: true });

    expect(encryptedOf(kept, 0)).toBe("opaque-encrypted-reasoning-token-xyz");
    expect(encryptedOf(kept, 1)).toBeUndefined();
    expect(encryptedOf(kept, 2)).toBeUndefined();

    expect(encryptedOf(sanitizeReasoningEncryptedContent(input()), 0)).toBeUndefined();
  });

  it("drops encrypted_content that is not a string", () => {
    const out = sanitizeReasoningEncryptedContent({
      store: false,
      input: [{ type: "reasoning", summary: [], encrypted_content: null }],
    });

    expect(encryptedOf(out, 0)).toBeUndefined();
  });
});

describe("a Meta target (Go 7a0b7563, 674dbe8f, cc5682c5)", () => {
  const input = (): Json =>
    body(
      reasoning(metaSignature()),
      reasoning(routerSuffixed(metaSignature())),
      reasoning(gptSignature()),
      reasoning("opaque-encrypted-reasoning-token-xyz"),
      reasoning(claudeSignature()),
    );

  it("replays native and routed envelopes verbatim through an OpenRouter route, and nothing foreign", () => {
    const out = sanitizeReasoningEncryptedContent(
      input(),
      reasoningOptionsForTarget({
        isCompat: false,
        targetModel: "meta/muse-wonder",
        baseUrl: OPENROUTER,
      }),
    );

    expect(encryptedOf(out, 0)).toBe(metaSignature());
    expect(encryptedOf(out, 1)).toBe(routerSuffixed(metaSignature()));

    for (const index of [2, 3, 4])
      expect(encryptedOf(out, index), `input[${index}]`).toBeUndefined();
  });

  it("resolves a namespaced router model to its Meta tail segment", () => {
    const out = sanitizeReasoningEncryptedContent(
      input(),
      reasoningOptionsForTarget({
        isCompat: false,
        targetModel: "openrouter/meta/muse-wonder",
        baseUrl: OPENROUTER,
      }),
    );

    expect(encryptedOf(out, 1)).toBe(routerSuffixed(metaSignature()));
  });

  it("strips the OpenRouter suffix down to the native envelope on another third-party host", () => {
    const out = sanitizeReasoningEncryptedContent(
      input(),
      reasoningOptionsForTarget({
        isCompat: false,
        targetModel: "meta/muse-wonder",
        baseUrl: "https://example-proxy.internal/v1",
      }),
    );

    expect(encryptedOf(out, 1)).toBe(metaSignature());
  });

  it("is native-only on the native Meta host, and drops a routed envelope", () => {
    const out = sanitizeReasoningEncryptedContent(
      input(),
      reasoningOptionsForMeta("https://api.meta.ai/api/v1"),
    );

    expect(encryptedOf(out, 0)).toBe(metaSignature());

    for (const index of [1, 2, 3, 4])
      expect(encryptedOf(out, index), `input[${index}]`).toBeUndefined();
  });

  it("keeps the routed envelope through the Meta executor on an OpenRouter base URL", () => {
    const out = sanitizeReasoningEncryptedContent(input(), reasoningOptionsForMeta(OPENROUTER));

    expect(encryptedOf(out, 0)).toBe(metaSignature());
    expect(encryptedOf(out, 1)).toBe(routerSuffixed(metaSignature()));
    expect(encryptedOf(out, 2)).toBeUndefined();
  });

  it.each([
    ["gpt-5.4", false],
    ["deepseek-v4", true],
  ])("strips a Meta envelope for %s (isCompat %s)", (targetModel, isCompat) => {
    const out = sanitizeReasoningEncryptedContent(
      body(reasoning(metaSignature()), reasoning(routerSuffixed(metaSignature()))),
      reasoningOptionsForTarget({ isCompat, targetModel, baseUrl: OPENROUTER }),
    );

    expect(encryptedOf(out, 0)).toBeUndefined();
    expect(encryptedOf(out, 1)).toBeUndefined();
  });

  it("is not claimed by the generic keep-foreign path either", () => {
    const out = sanitizeReasoningEncryptedContent(
      body(reasoning(metaSignature()), reasoning("opaque-blob")),
      { keepForeign: true },
    );

    expect(encryptedOf(out, 0)).toBeUndefined();
    expect(encryptedOf(out, 1)).toBe("opaque-blob");
  });
});

describe("router suffixes on GPT and cache prefixes (Go be9fbd94, a68c7d8e)", () => {
  const routed = routerSuffixed(gptSignature(), 79);

  it("strips the suffix on official and non-OpenRouter upstreams and keeps it on OpenRouter", () => {
    const official = sanitizeReasoningEncryptedContent(
      body(reasoning(routed)),
      reasoningOptionsForTarget({ isCompat: false, targetModel: "gpt-5.4", baseUrl: OFFICIAL }),
    );

    expect(encryptedOf(official, 0)).toBe(gptSignature());

    const router = sanitizeReasoningEncryptedContent(
      body(reasoning(routed)),
      reasoningOptionsForTarget({
        isCompat: false,
        targetModel: "openrouter/openai/o4-mini",
        baseUrl: OPENROUTER,
      }),
    );

    expect(encryptedOf(router, 0)).toBe(routed);
  });

  it.each(["openrouter/x-ai/grok-4.7", "openrouter/google/gemini-3.8-flash"])(
    "strips a GPT envelope for the %s target",
    (targetModel) => {
      const out = sanitizeReasoningEncryptedContent(
        body(reasoning(routed)),
        reasoningOptionsForTarget({ isCompat: true, targetModel, baseUrl: OPENROUTER }),
      );

      expect(encryptedOf(out, 0)).toBeUndefined();
    },
  );

  it("rewrites a cache-prefixed signature to its native payload", () => {
    const swe = sanitizeReasoningEncryptedContent(
      body(reasoning("swe#sealed.v1.token")),
      reasoningOptionsForTarget({
        isCompat: true,
        targetModel: "devin/swe-2",
        baseUrl: OPENROUTER,
      }),
    );

    expect(encryptedOf(swe, 0)).toBe("sealed.v1.token");

    const gpt = sanitizeReasoningEncryptedContent(
      body(reasoning(`gpt#${gptSignature()}`)),
      reasoningOptionsForTarget({ isCompat: false, targetModel: "gpt-5.4", baseUrl: OFFICIAL }),
    );

    expect(encryptedOf(gpt, 0)).toBe(gptSignature());
  });

  it("drops a value with surrounding whitespace", () => {
    const out = sanitizeReasoningEncryptedContent(body(reasoning(` ${gptSignature()}`)));

    expect(encryptedOf(out, 0)).toBeUndefined();
  });

  it("keys a reasoning item without its suffix or cache prefix", () => {
    expect(canonicalReasoningSignatureKey(routed)).toBe(gptSignature());
    expect(canonicalReasoningSignatureKey(`gpt#${gptSignature()}`)).toBe(gptSignature());
    expect(canonicalReasoningSignatureKey(routerSuffixed(metaSignature()))).toBe(metaSignature());
    expect(canonicalReasoningSignatureKey("opaque")).toBe("opaque");
  });
});
