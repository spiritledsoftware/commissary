// C9 PR B (Go 7a0b7563, a4660260, cc5682c5, be9fbd94, 674dbe8f, a68c7d8e): Meta Muse reasoning envelopes, OpenRouter
// router suffixes on GPT, Grok and Meta signatures, and family detection by the last model-name segment. Expected values
// come from the Go tests of those commits (meta_validation_test.go, gpt_validation_test.go, grok_validation_test.go);
// the signatures are synthetic, as in Go.
import { describe, expect, it } from "vitest";
import {
  inspectGptReasoningSignature,
  isValidGptReasoningSignature,
} from "../src/signature/gpt.ts";
import {
  inspectGrokEncryptedContent,
  isRecognizedReasoningSignature,
  isValidGrokEncryptedContent,
} from "../src/signature/grok.ts";
import {
  inspectMetaReasoningSignature,
  isValidMetaReasoningSignature,
} from "../src/signature/meta.ts";
import { stripRouterSuffix } from "../src/signature/router-suffix.ts";
import {
  compatibleSignatureForProvider,
  decideSignatureCompatibility,
  detectSignatureProvider,
  signatureProviderFromModelName,
} from "../src/signature/provider.ts";
import {
  fernetReasoningSignature,
  metaSignature,
  grokCiphertext,
  metaSignatureBytes,
  rawUrl,
  routerSuffixed,
} from "./support/reasoning-signatures.ts";

const SUFFIX = routerSuffixed("").slice(1);

describe("Meta Muse reasoning envelopes (Go 7a0b7563)", () => {
  it.each([
    [1024, 1069, 0],
    [2048, 2093, 1],
    [4096, 4141, 2],
    [32768, 32813, 5],
  ])("recognises the %i byte bucket", (payload, decodedLen, exponent) => {
    const signature = metaSignature(payload);

    expect(inspectMetaReasoningSignature(signature)).toEqual({
      decodedLen,
      payloadLen: payload,
      bucketExponent: exponent,
      routerSuffix: "",
    });
    expect(isValidMetaReasoningSignature(signature)).toBe(true);
    expect(detectSignatureProvider(signature)).toBe("meta");
  });

  it("rejects malformed envelopes and never claims them as Meta", () => {
    const valid = metaSignature(1024);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = alphabet.indexOf(valid.at(-1) ?? "");

    const other = alphabet
      .split("")
      .findIndex((_, i) => i !== last && (i & 0x30) === (last & 0x30));

    const cases = {
      empty: "",
      "mock prefix only": "Q-PaDg-mock-muse-spark-encrypted-reasoning-payload",
      "wrong literal start": `R${valid.slice(1)}`,
      "header byte flipped": rawUrl(
        metaSignatureBytes(1024, (b) => {
          b[2] = (b[2] ?? 0) ^ 0xff;
        }),
      ),
      "version byte zero": rawUrl(
        metaSignatureBytes(1024, (b) => {
          b[4] = 0;
        }),
      ),
      "payload below min": metaSignature(512),
      "payload not power2": metaSignature(1025),
      "payload off by one": metaSignature(2047),
      "padded encoding": `${valid}=`,
      "standard base64 +": `${valid.slice(0, 100)}+${valid.slice(101)}`,
      "embedded whitespace": `${valid.slice(0, 100)} ${valid.slice(100)}`,
      "length mod4 is 1": valid.slice(0, -1),
      "non-canonical bits": `${valid.slice(0, -1)}${alphabet.charAt(other)}`,
    };

    for (const [name, signature] of Object.entries(cases)) {
      expect(inspectMetaReasoningSignature(signature), name).toBeUndefined();
      expect(detectSignatureProvider(signature), name).not.toBe("meta");
    }
  });

  it("accepts a router suffix, reports it and replays the full value verbatim", () => {
    const native = metaSignature(2048);
    const routed = `${native}.${SUFFIX}`;
    const info = inspectMetaReasoningSignature(routed);

    expect(info?.routerSuffix).toBe(SUFFIX);
    expect(info).toEqual({ ...inspectMetaReasoningSignature(native), routerSuffix: SUFFIX });
    expect(detectSignatureProvider(routed)).toBe("meta");
    expect(compatibleSignatureForProvider("meta", routed)).toBe(routed);
    expect(stripRouterSuffix(routed, SUFFIX)).toBe(native);

    // Still a foreign envelope to other targets.
    expect(decideSignatureCompatibility("gpt", routed)).toMatchObject({
      compatible: false,
      detectedProvider: "meta",
      action: "drop_block",
    });
  });

  it("rejects malformed router suffixes", () => {
    const native = metaSignature(1024);
    const at = (char: string) => `${native}.${SUFFIX.slice(0, 60)}${char}${SUFFIX.slice(61)}`;

    const cases = {
      "trailing dot": `${native}.`,
      "oversized suffix": `${native}.${"a".repeat(129)}`,
      "suffix with dash": at("-"),
      "suffix with underscore": at("_"),
      "suffix with padding": at("="),
      "suffix with plus": at("+"),
      "suffix with slash": at("/"),
      "suffix with space": at(" "),
      "second dot": at("."),
      "bad native header": `${rawUrl(
        metaSignatureBytes(1024, (b) => {
          b[2] = (b[2] ?? 0) ^ 0xff;
        }),
      )}.${SUFFIX}`,
      "non-bucket native": `${metaSignature(1025)}.${SUFFIX}`,
      "suffix only": `.${SUFFIX}`,
    };

    for (const [name, signature] of Object.entries(cases)) {
      expect(inspectMetaReasoningSignature(signature), name).toBeUndefined();
      expect(detectSignatureProvider(signature), name).not.toBe("meta");
    }
  });

  it("is compatible with a Meta target only, and drops or replaces it for the others", () => {
    const signature = metaSignature(2048);

    expect(decideSignatureCompatibility("meta", signature)).toMatchObject({
      compatible: true,
      action: "preserve",
      normalizedSignature: signature,
    });
    expect(compatibleSignatureForProvider("meta", signature)).toBe(signature);

    expect(decideSignatureCompatibility("meta", fernetReasoningSignature())).toMatchObject({
      compatible: false,
      detectedProvider: "gpt",
      action: "drop_block",
    });

    const small = metaSignature(1024);

    for (const [target, action] of [
      ["claude", "drop_block"],
      ["gemini", "replace_with_gemini_bypass"],
      ["kimi", "drop_signature"],
      ["grok", "drop_block"],
    ] as const) {
      expect(decideSignatureCompatibility(target, small), target).toMatchObject({
        compatible: false,
        detectedProvider: "meta",
        action,
      });
    }
  });

  it("has no cache-prefix alias", () => {
    const signature = metaSignature(1024);

    for (const prefixed of [`meta#${signature}`, `muse#${signature}`]) {
      expect(detectSignatureProvider(prefixed)).toBe("unknown");
      expect(compatibleSignatureForProvider("meta", prefixed)).toBeUndefined();
    }
  });
});

describe("signature family by model name (Go 7a0b7563, 674dbe8f)", () => {
  it.each([
    "muse-wonder-full-1.0-contributor",
    "muse-spark-1.3",
    "Muse-Wonder-1.0",
    "meta/muse-spark-1.2",
    "meta/muse",
    "muse",
    "meta-muse-spark",
    "muse_spark_1_3",
  ])("%s is Meta", (model) => {
    expect(signatureProviderFromModelName(model)).toBe("meta");
  });

  it.each(["museum-1", "amuse-model", "meta-llama-4"])("%s names no family", (model) => {
    expect(signatureProviderFromModelName(model)).toBe("unknown");
  });

  it("lets the last path segment outrank a vendor or router prefix", () => {
    const cases = {
      "openai-compatible/muse-spark-1.3": "meta",
      "muse-proxy/gpt-5.4": "gpt",
      "openrouter/anthropic/claude-sonnet-4-6": "claude",
      "vendor:grok-4": "grok",
      // A tail without a family falls back to the whole string.
      "gemini-proxy/custom": "gemini",
    };

    for (const [model, family] of Object.entries(cases)) {
      expect(signatureProviderFromModelName(model), model).toBe(family);
    }
  });
});

describe("router-suffixed GPT and Grok signatures (Go be9fbd94)", () => {
  it("accepts a GPT router suffix and replays it verbatim", () => {
    const native = fernetReasoningSignature();
    const routed = routerSuffixed(native, 79);
    const suffix = routed.slice(native.length + 1);

    expect(inspectGptReasoningSignature(routed)).toEqual({ routerSuffix: suffix });
    expect(inspectGptReasoningSignature(native)).toEqual({ routerSuffix: "" });
    expect(detectSignatureProvider(routed)).toBe("gpt");
    expect(compatibleSignatureForProvider("gpt", routed)).toBe(routed);

    for (const bad of [`${native}.`, `${native}.bad_char`, `${native}.a.b`]) {
      expect(isValidGptReasoningSignature(bad), bad).toBe(false);
    }
  });

  it("accepts a Grok router suffix", () => {
    const native = grokCiphertext(3, 135);
    const routed = routerSuffixed(native, 62);
    const suffix = routed.slice(native.length + 1);

    expect(inspectGrokEncryptedContent(routed)).toEqual({
      rawLen: routed.length,
      decodedLen: 135,
      routerSuffix: suffix,
    });
    expect(isRecognizedReasoningSignature(routed)).toBe(true);

    for (const bad of [`${native}.`, `${native}.bad-dash`, `${native}.a.b`]) {
      expect(isValidGrokEncryptedContent(bad), bad).toBe(false);
    }
  });

  it("does not take a Meta envelope or a Gemini Codex carrier for Grok (Go 7a0b7563, a68c7d8e)", () => {
    expect(isValidGrokEncryptedContent(metaSignature(1024))).toBe(false);

    // High enough entropy to pass the ciphertext check, so only the carrier prefix rejects it.
    const carried = btoa(
      `cpa-codex-gemini-carrier-v1:${"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".slice(0, 36)}`,
    ).replace(/=+$/, "");

    expect(isValidGrokEncryptedContent(carried)).toBe(false);
  });
});
