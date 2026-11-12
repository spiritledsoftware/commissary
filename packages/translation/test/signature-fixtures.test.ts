// Golden signature decisions generated from the Go internal/signature package by
// `go run ./tools/fixturegen/signature`.
import { describe, expect, it } from "vite-plus/test";
import {
  compatibleAntigravityClaudeThinkingSignature,
  isValidClaudeThinkingSignature,
  normalizeClaudeProviderNativeThinkingSignature,
  normalizeClaudeThinkingSignature,
  stripInvalidClaudeThinkingBlocks,
  stripInvalidClaudeThinkingBlocksAndEmptyMessages,
} from "../src/signature/claude.ts";
import {
  sanitizeClaudeMessagesForClaudeUpstream,
  sanitizeClaudeMessagesSignaturesForModel,
  sanitizeClaudeMessagesSignaturesForTarget,
  type SignatureSanitizeReport,
} from "../src/signature/claude-messages.ts";
import {
  geminiReplaySignatureOrBypass,
  sanitizeGeminiRequestThoughtSignatures,
  validateGeminiFunctionCallPairing,
  validateGeminiThoughtSignatures,
} from "../src/signature/gemini.ts";
import { isValidGptReasoningSignature } from "../src/signature/gpt.ts";
import {
  isRecognizedReasoningSignature,
  isValidGrokEncryptedContent,
} from "../src/signature/grok.ts";
import {
  compatibleSignatureForProvider,
  decideSignatureCompatibility,
  detectSignatureProvider,
  type SignatureBlockKind,
  type SignatureProvider,
  signatureProviderFromModelName,
} from "../src/signature/provider.ts";
import fixture from "./fixtures/signature.json";

interface Decision {
  readonly compatible: boolean;
  readonly action: string;
  readonly detected: string;
  readonly normalized: string;
  readonly replacement: string;
  readonly reason: string;
}

interface Report {
  readonly targetProvider: string;
  readonly preserved: number;
  readonly droppedBlocks: number;
  readonly droppedSignatures: number;
  readonly replacedSignatures: number;
  readonly decisions: number;
  readonly reasons: ReadonlyArray<string>;
}

interface SanitizeCase {
  readonly name: string;
  readonly mode: string;
  readonly model: string;
  readonly output: unknown;
  readonly report: Report;
}

interface GeminiCase {
  readonly name: string;
  readonly input: unknown;
  readonly thought: string;
  readonly pairing: string;
  readonly sanitize: unknown;
}

/** The history `buildSanitizeCases` feeds to Go (keys in the sorted order `encoding/json` emits). */
const history = (sig: string) => ({
  messages: [
    { content: "hi", role: "user" },
    {
      content: [
        { signature: sig, thinking: "t", type: "thinking" },
        { text: "x", type: "text" },
        {
          extra_content: { google: { thought_signature: sig } },
          id: "1",
          input: {},
          model: "m",
          name: "n",
          signature: sig,
          thoughtSignature: sig,
          type: "tool_use",
        },
      ],
      role: "assistant",
    },
    { content: [{ signature: sig, thinking: "only", type: "thinking" }], role: "assistant" },
    { content: [{ signature: "", thinking: "", type: "thinking" }], role: "assistant" },
    { content: [{ signature: "", thinking: "words", type: "thinking" }], role: "assistant" },
    { content: "plain", role: "assistant" },
  ],
  model: "claude-sonnet-4-5",
});

const reportOf = (report: SignatureSanitizeReport): Report => ({
  targetProvider: report.targetProvider,
  preserved: report.preserved,
  droppedBlocks: report.droppedBlocks,
  droppedSignatures: report.droppedSignatures,
  replacedSignatures: report.replacedSignatures,
  decisions: report.decisions.length,
  reasons: report.decisions.map((decision) => decision.reason),
});

const runSanitize = (testCase: SanitizeCase, sig: string) => {
  const payload = history(sig);

  const empty: Report = {
    targetProvider: "",
    preserved: 0,
    droppedBlocks: 0,
    droppedSignatures: 0,
    replacedSignatures: 0,
    decisions: 0,
    reasons: [],
  };

  switch (testCase.mode) {
    case "forModel":
      return {
        payload,
        report: reportOf(sanitizeClaudeMessagesSignaturesForModel(payload, testCase.model)),
      };
    case "claudeUpstream":
      return {
        payload,
        report: reportOf(sanitizeClaudeMessagesForClaudeUpstream(payload, testCase.model)),
      };
    case "claudeUpstreamPreserve":
      return {
        payload,
        report: reportOf(sanitizeClaudeMessagesForClaudeUpstream(payload, testCase.model, true)),
      };
    case "targetKeepEmpty":
      return {
        payload,
        report: reportOf(
          sanitizeClaudeMessagesSignaturesForTarget(payload, { targetProvider: "claude" }),
        ),
      };
    case "targetModelOnly":
      return {
        payload,
        report: reportOf(
          sanitizeClaudeMessagesSignaturesForTarget(payload, {
            targetProvider: "unknown",
            targetModel: testCase.model,
            dropEmptyMessages: true,
          }),
        ),
      };
    case "stripEmpty":
      stripInvalidClaudeThinkingBlocksAndEmptyMessages(payload, {
        allowEmptySignatureWithEmptyText: true,
      });

      return { payload, report: { ...empty, targetProvider: testCase.report.targetProvider } };
    default:
      stripInvalidClaudeThinkingBlocks(payload, { strict: true });

      return { payload, report: { ...empty, targetProvider: testCase.report.targetProvider } };
  }
};

const sampleSignature = (name: string): string =>
  fixture.samples.find((sample) => sample.name === name)?.signature ?? "";

const OPTION_SETS = {
  default: {},
  strict: { strict: true },
  prefixOnly: { prefixOnly: true },
  base64Only: { base64Only: true },
} as const;

const tryNormalize = (fn: () => string): string | null => {
  try {
    return fn();
  } catch {
    return null;
  }
};

describe("signature fixtures (Go internal/signature)", () => {
  for (const sample of fixture.samples) {
    describe(sample.name, () => {
      it("detects the provider for every block kind", () => {
        for (const [kind, expected] of Object.entries(sample.detected)) {
          expect(detectSignatureProvider(sample.signature, kind as SignatureBlockKind), kind).toBe(
            expected,
          );
        }
      });

      it("decides compatibility for every target and block kind", () => {
        for (const [key, expected] of Object.entries(
          sample.decisions as Record<string, Decision>,
        )) {
          const [target, kind] = key.split("/") as [SignatureProvider, SignatureBlockKind];
          const decision = decideSignatureCompatibility(target, sample.signature, kind);
          expect(
            {
              compatible: decision.compatible,
              action: decision.action,
              detected: decision.detectedProvider,
              normalized: decision.normalizedSignature,
              replacement: decision.replacementSignature,
              reason: decision.reason,
            },
            key,
          ).toEqual(expected);
        }
      });

      it("validates and normalises Claude signatures under every option set", () => {
        for (const [name, options] of Object.entries(OPTION_SETS)) {
          expect(isValidClaudeThinkingSignature(sample.signature, options), name).toBe(
            (sample.claudeValid as Record<string, boolean>)[name],
          );
          const normalized = sample.normalized as Record<string, string | null>;
          expect(
            tryNormalize(() => normalizeClaudeThinkingSignature(sample.signature, options)),
            name,
          ).toBe(normalized[name]);
          expect(
            tryNormalize(() =>
              normalizeClaudeProviderNativeThinkingSignature(sample.signature, options),
            ),
            `${name}Native`,
          ).toBe(normalized[`${name}Native`]);
        }
      });

      it("matches CompatibleAntigravityClaudeThinkingSignature and CompatibleSignatureForProvider", () => {
        expect(compatibleAntigravityClaudeThinkingSignature(sample.signature) ?? null).toBe(
          sample.antigravityClaude ?? null,
        );

        for (const [provider, expected] of Object.entries(
          sample.compatible as Record<string, string | null>,
        )) {
          expect(
            compatibleSignatureForProvider(provider as SignatureProvider, sample.signature) ?? null,
            provider,
          ).toBe(expected);
        }
      });
    });
  }

  for (const sample of fixture.samples) {
    it(`validates Grok/GPT/recognised signatures and Gemini replay for ${sample.name}`, () => {
      expect(isValidGrokEncryptedContent(sample.signature), "grok").toBe(sample.grok);
      expect(isRecognizedReasoningSignature(sample.signature), "recognized").toBe(
        sample.recognized,
      );
      expect(isValidGptReasoningSignature(sample.signature), "gpt").toBe(sample.gpt);

      for (const [kind, expected] of Object.entries(
        sample.geminiReplay as Record<string, string>,
      )) {
        expect(geminiReplaySignatureOrBypass(sample.signature), kind).toBe(expected);
      }
    });
  }

  it("sanitises Claude messages history like SanitizeClaudeMessagesSignaturesForTarget", () => {
    expect(fixture.sanitize.length).toBeGreaterThan(400);

    for (const testCase of fixture.sanitize as SanitizeCase[]) {
      const label = `${testCase.name}/${testCase.mode}/${testCase.model}`;
      const { payload, report } = runSanitize(testCase, sampleSignature(testCase.name));
      expect(payload, label).toEqual(testCase.output);
      expect(JSON.stringify(payload), `${label} key order`).toBe(JSON.stringify(testCase.output));
      expect(report, label).toEqual(testCase.report);
    }
  });

  it("validates Gemini signatures, function-call pairing and sanitises requests like Go", () => {
    expect(fixture.gemini.length).toBeGreaterThan(80);

    for (const testCase of fixture.gemini as GeminiCase[]) {
      const input = JSON.stringify(testCase.input);

      const thought = validateGeminiThoughtSignatures(JSON.parse(input), {
        allowBypassSentinel: true,
        requireKnownEnvelope: true,
      });

      // Go appends the wrapped base64 decoder error to its own prefix; only the prefix is portable.
      const stable = (text: string) =>
        text.replace(/base64 decode failed.*$/, "base64 decode failed");

      expect(stable(thought ?? ""), `${testCase.name} thought`).toBe(stable(testCase.thought));
      expect(
        validateGeminiFunctionCallPairing(JSON.parse(input)) ?? "",
        `${testCase.name} pairing`,
      ).toBe(testCase.pairing);
      expect(
        sanitizeGeminiRequestThoughtSignatures(JSON.parse(input)),
        `${testCase.name} sanitize`,
      ).toEqual(testCase.sanitize);
    }
  });

  it("maps model names to signature providers", () => {
    for (const [model, expected] of Object.entries(fixture.modelProviders)) {
      expect(signatureProviderFromModelName(model), model).toBe(expected);
    }
  });
});
