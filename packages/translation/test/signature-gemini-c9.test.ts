// C9 PR A (Go e5434f65, 7517549a, 58a4d04f, 1398f273, a8582fba): the first Gemini functionCall after a text part is
// signed, Antigravity CAQS signatures are accepted on any channel id, and Vertex "bare-Tink" thought signatures are
// recognised (key id pinned) and rejected by the non-Vertex sanitiser. Expected values come from the Go tests of those
// commits; the signatures are synthetic, like Go's `testGeminiBareTinkSignature` and `signaturetest.AntigravityCAQS`.
import { get, type Json } from "@commissary/json";
import { describe, expect, it } from "vitest";
import {
  compatibleAntigravityClaudeThinkingSignature,
  isValidClaudeThinkingSignature,
} from "../src/signature/claude.ts";
import {
  decideGeminiSignature,
  geminiReplaySignatureOrBypass,
  inspectGeminiThoughtSignature,
  isGeminiVertexBareTinkSignature,
  isKnownGeminiEnvelope,
  sanitizeGeminiRequestThoughtSignatures,
  sanitizeNonVertexGeminiRequestThoughtSignatures,
  validateGeminiThoughtSignatures,
} from "../src/signature/gemini.ts";
import { isValidGrokEncryptedContent } from "../src/signature/grok.ts";
import {
  decideSignatureCompatibility,
  detectSignatureProvider,
  isValidKimiThinkingSignature,
} from "../src/signature/provider.ts";
import { sig } from "./support/gemini-signatures.ts";

const SENTINEL = "skip_thought_signature_validator";

const base64 = (bytes: ReadonlyArray<number>): string => btoa(String.fromCharCode(...bytes));

/** Go `testGeminiBareTinkSignature`: prefix byte, key id, then filler ciphertext up to `length` bytes. */
const bareTink = (length: number, keyId: ReadonlyArray<number> = [0x8f, 0x3d, 0x6b, 0x5f]) => {
  const payload = [0x01, ...keyId];

  while (payload.length < length) payload.push(0xa0 + (payload.length % 0x20));

  return base64(payload);
};

/** A native Gemini 3 (protobuf field 2) signature. */
const NATIVE = sig();

const modelTurn = (...parts: ReadonlyArray<Json>): Json => ({
  contents: [{ role: "model", parts: [...parts] }],
});

const call = (name: string, signature?: string): Json =>
  signature === undefined
    ? { functionCall: { name, args: {} } }
    : { functionCall: { name, args: {} }, thoughtSignature: signature };

const signatureOf = (payload: Json, part: number, root = "contents"): Json | undefined =>
  get(payload, `${root}.0.parts.${part}.thoughtSignature`);

describe("a functionCall after a text part starts a new parallel group (Go e5434f65)", () => {
  it("signs unsigned calls separated by text, leaving the parallel sibling unsigned", () => {
    const out = sanitizeGeminiRequestThoughtSignatures(
      modelTurn(call("first"), call("second"), { text: "more" }, call("third")),
    );

    expect(signatureOf(out, 0)).toBe(SENTINEL);
    expect(signatureOf(out, 1)).toBeUndefined();
    expect(signatureOf(out, 3)).toBe(SENTINEL);
  });

  it("keeps the sentinel on the call after text and strips it from the sibling", () => {
    const out = sanitizeGeminiRequestThoughtSignatures(
      modelTurn(
        call("first", SENTINEL),
        call("second", SENTINEL),
        { text: "more" },
        call("third", SENTINEL),
      ),
    );

    expect(signatureOf(out, 0)).toBe(SENTINEL);
    expect(signatureOf(out, 1)).toBeUndefined();
    expect(signatureOf(out, 3)).toBe(SENTINEL);
  });

  it("does not end the group at a thought part", () => {
    const out = sanitizeGeminiRequestThoughtSignatures(
      modelTurn(
        call("first", SENTINEL),
        { text: "hidden", thought: true },
        call("second", SENTINEL),
      ),
    );

    expect(signatureOf(out, 0)).toBe(SENTINEL);
    expect(signatureOf(out, 2)).toBeUndefined();
  });

  it("treats an empty signature carrier as a text part", () => {
    const out = sanitizeGeminiRequestThoughtSignatures(
      modelTurn(call("first", NATIVE), { text: "", thoughtSignature: NATIVE }, call("second")),
    );

    expect(signatureOf(out, 0)).toBe(NATIVE);
    expect(signatureOf(out, 2)).toBe(SENTINEL);
  });

  it("validates the call after text as the first of a new group", () => {
    const options = { allowBypassSentinel: true };

    expect(
      validateGeminiThoughtSignatures(
        modelTurn(call("a", SENTINEL), { text: "more" }, call("b")),
        options,
      ),
    ).toContain("missing thoughtSignature on first functionCall");

    expect(
      validateGeminiThoughtSignatures(
        modelTurn(call("a", SENTINEL), { text: "more" }, call("b", SENTINEL)),
        options,
      ),
    ).toBeUndefined();

    // A thought part does not start a group: the second call may stay unsigned.
    expect(
      validateGeminiThoughtSignatures(
        modelTurn(call("a", SENTINEL), { text: "hidden", thought: true }, call("b")),
        options,
      ),
    ).toBeUndefined();
  });
});

/** Go `signaturetest.AntigravityCAQSWithChannel`: a double-base64 Google Claude thinking envelope. */
const caqs = (channelId: number): string => {
  const varint = (field: number, value: number): number[] => [(field << 3) | 0, value];

  const bytes = (field: number, value: ReadonlyArray<number>): number[] => {
    const length: number[] = [];
    let rest = value.length;

    while (rest >= 0x80) {
      length.push((rest & 0x7f) | 0x80);
      rest >>= 7;
    }

    length.push(rest);

    return [(field << 3) | 2, ...length, ...value];
  };

  const zeros = (n: number): number[] => Array.from({ length: n }, () => 0);

  const channel = [
    ...varint(1, channelId),
    ...varint(2, 2),
    ...varint(3, 2),
    ...varint(7, 1),
    ...bytes(8, [...new TextEncoder().encode("thinking")]),
  ];

  const container = [
    ...bytes(1, channel),
    ...bytes(2, zeros(12)),
    ...bytes(3, zeros(12)),
    ...bytes(4, zeros(48)),
    ...bytes(5, zeros(1020)),
  ];

  const payload = [...varint(1, 4), ...bytes(2, container), ...varint(3, 1)];

  return btoa(btoa(String.fromCharCode(...payload)));
};

describe("Antigravity CAQS signatures are not rejected by channel id (Go 7517549a)", () => {
  it.each([16, 17, 18, 19, 20])("accepts and replays channel %i", (channelId) => {
    const signature = caqs(channelId);

    expect(detectSignatureProvider(signature)).toBe("claude");

    for (const options of [{}, { strict: true }, { prefixOnly: true }, { base64Only: true }]) {
      expect(isValidClaudeThinkingSignature(signature, options), JSON.stringify(options)).toBe(
        true,
      );
    }

    expect(compatibleAntigravityClaudeThinkingSignature(signature)).toBe(signature);

    // The Google wrapper is never replayed directly to another target.
    for (const target of ["claude", "gemini", "gpt", "kimi", "grok"] as const) {
      expect(
        decideSignatureCompatibility(target, signature, "claude_thinking").compatible,
        target,
      ).toBe(false);
    }
  });
});

/** Deterministic high-entropy bytes after a fixed head: xAI and Kimi payloads are indistinguishable from random. */
const randomLike = (head: ReadonlyArray<number>, length: number): number[] => {
  const bytes = [...head];
  let state = 0x2545f491;

  while (bytes.length < length) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes.push(state >>> 24);
  }

  return bytes;
};

const unpadded = (bytes: ReadonlyArray<number>): string => base64(bytes).replace(/=+$/, "");

describe("Vertex bare-Tink thought signatures (Go 58a4d04f, a8582fba)", () => {
  it("is a known Gemini envelope that every Gemini block replays verbatim", () => {
    const signature = bareTink(606);

    expect(isKnownGeminiEnvelope(signature)).toBe(true);
    expect(
      inspectGeminiThoughtSignature(signature, { requireKnownEnvelope: true }),
    ).toBeUndefined();
    expect(detectSignatureProvider(signature, "gemini_model_part")).toBe("gemini");
    expect(detectSignatureProvider(signature, "gemini_function_call")).toBe("gemini");
    expect(decideGeminiSignature(signature)).toEqual({
      action: "preserve",
      normalized: signature,
    });
    expect(geminiReplaySignatureOrBypass(signature)).toBe(signature);
    expect(geminiReplaySignatureOrBypass(`gemini#${signature}`)).toBe(signature);
  });

  it("stays Gemini-shaped on Claude blocks without satisfying a Claude validator", () => {
    const signature = bareTink(405);

    expect(detectSignatureProvider(signature, "claude_thinking")).toBe("gemini");
    expect(isValidClaudeThinkingSignature(signature, { strict: true })).toBe(false);
  });

  it("rejects a payload below the prefix, key id and auth-tag floor", () => {
    const signature = base64([0x01, 0x8f, 0x3d, ...Array.from({ length: 10 }, () => 0)]);

    expect(inspectGeminiThoughtSignature(signature, { requireKnownEnvelope: true })).toContain(
      "unknown envelope",
    );
    expect(geminiReplaySignatureOrBypass(signature)).toBe(SENTINEL);
  });

  it("requires the pinned Vertex key id: another key id is unknown and replaced by the sentinel", () => {
    const signature = bareTink(405, [0x69, 0x14, 0x7d, 0x13]);

    expect(isGeminiVertexBareTinkSignature(signature)).toBe(false);
    expect(isKnownGeminiEnvelope(signature)).toBe(false);
    expect(detectSignatureProvider(signature)).not.toBe("gemini");
    expect(geminiReplaySignatureOrBypass(signature)).toBe(SENTINEL);
    expect(isGeminiVertexBareTinkSignature(bareTink(405))).toBe(true);
    expect(isGeminiVertexBareTinkSignature(`gemini#${bareTink(405)}`)).toBe(true);
    // A protobuf-wrapped native signature is not bare-Tink.
    expect(isGeminiVertexBareTinkSignature(NATIVE)).toBe(false);
  });

  it("does not claim a 0x01-leading Grok payload as Gemini", () => {
    // Without the key id pin, about 1/256 of xAI payloads would match.
    const signature = unpadded(randomLike([0x01, 0x69, 0x14, 0x7d, 0x13], 300));

    expect(signature.startsWith("A")).toBe(true);
    expect(isKnownGeminiEnvelope(signature)).toBe(false);
    expect(isValidGrokEncryptedContent(signature)).toBe(true);
  });

  it("does not claim a 0x01-leading Kimi signature as Gemini", () => {
    const signature = unpadded(randomLike([0x01, 0x69, 0x14, 0x7d, 0x13], 3255));

    expect(signature).toHaveLength(4340);
    expect(isValidKimiThinkingSignature(signature)).toBe(true);
    expect(detectSignatureProvider(signature)).toBe("kimi");
  });
});

describe("the non-Vertex sanitiser rejects bare-Tink (Go 1398f273)", () => {
  const VERTEX = bareTink(405);

  it("keeps a bare-Tink first call and signed text part in the preserving sanitiser", () => {
    const out = sanitizeGeminiRequestThoughtSignatures(
      modelTurn(call("first", VERTEX), { text: "t", thoughtSignature: VERTEX }),
    );

    expect(signatureOf(out, 0)).toBe(VERTEX);
    expect(signatureOf(out, 1)).toBe(VERTEX);
  });

  it("replaces a bare-Tink first call with the sentinel and drops the other parts' signatures", () => {
    const out = sanitizeNonVertexGeminiRequestThoughtSignatures(
      modelTurn(
        call("first", VERTEX),
        call("second", VERTEX),
        { text: "t", thoughtSignature: VERTEX },
        call("third", VERTEX),
      ),
    );

    expect(signatureOf(out, 0)).toBe(SENTINEL);
    expect(signatureOf(out, 1)).toBeUndefined();
    expect(signatureOf(out, 2)).toBeUndefined();
    // The call after the text part is the first of a new group.
    expect(signatureOf(out, 3)).toBe(SENTINEL);
  });

  it("keeps native Gemini signatures and replaces a missing one", () => {
    const out = sanitizeNonVertexGeminiRequestThoughtSignatures(
      modelTurn(call("first", NATIVE), { text: "t", thoughtSignature: NATIVE }, call("second")),
    );

    expect(signatureOf(out, 0)).toBe(NATIVE);
    expect(signatureOf(out, 1)).toBe(NATIVE);
    expect(signatureOf(out, 2)).toBe(SENTINEL);
  });

  it("works on request.contents", () => {
    const payload: Json = {
      request: { contents: [{ role: "model", parts: [call("first", VERTEX)] }] },
    };

    sanitizeNonVertexGeminiRequestThoughtSignatures(payload, "request.contents");

    expect(signatureOf(payload, 0, "request.contents")).toBe(SENTINEL);
  });
});
