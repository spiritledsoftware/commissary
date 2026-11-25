// The shared sensitive-word matcher of the Claude, Antigravity and Devin executors. The cases copy Go's
// internal/runtime/executor/helps/cloak_obfuscate_test.go (CLIProxyAPI 9a7e1e6b, 905e70c4).
import { describe, expect, it } from "vite-plus/test";
import type { JsonObject } from "@commissary/json";
import {
  buildAntigravitySensitiveWordMatcher,
  buildSensitiveWordMatcher,
  obfuscateSensitiveWords,
  obfuscateSystemInstruction,
  type SensitiveWordMatcher,
} from "../../src/executor/helps/cloak-obfuscate.ts";

const defined = (matcher: SensitiveWordMatcher | undefined): SensitiveWordMatcher => {
  expect(matcher).toBeDefined();

  // SAFETY: asserted just above.
  return matcher as SensitiveWordMatcher;
};

describe("sensitive words", () => {
  it("is undefined when nothing usable is configured", () => {
    expect(buildSensitiveWordMatcher({ words: [] })).toBeUndefined();
    expect(buildSensitiveWordMatcher({ words: ["a", " "], replacements: { " ": "x" } })).toBe(
      undefined,
    );
    expect(buildSensitiveWordMatcher({ words: [], patterns: [{ pattern: "[invalid" }] })).toBe(
      undefined,
    );
  });

  it("obfuscates with a zero-width space after the first character, longest first", () => {
    const matcher = defined(buildSensitiveWordMatcher({ words: ["proxy", "Claude Code"] }));

    expect(matcher.obfuscate("Use proxy with Claude Code.")).toBe(
      "Use p\u200Broxy with C\u200Blaude Code.",
    );
    expect(matcher.obfuscate("Use PROXY")).toBe("Use P\u200BROXY");
  });

  it("obfuscates each letter-and-digit run of an Antigravity word with U+034F, idempotently", () => {
    const matcher = defined(
      buildAntigravitySensitiveWordMatcher({
        words: ["Codex", "GPT-5", "Claude Code", "<system-conventions>", "claude-code", "Agent X"],
      }),
    );

    const input =
      "You are Codex, an agent based on GPT-5. Follow <system-conventions> in Claude Code / claude-code with Agent X.";

    const got = matcher.obfuscate(input);

    expect(got).toBe(
      "You are C\u034Fodex, an agent based on G\u034FPT-5. Follow <s\u034Fystem-c\u034Fonventions> in C\u034Flaude C\u034Fode / c\u034Flaude-c\u034Fode with A\u034Fgent X.",
    );
    expect(got).not.toContain("\u200B");
    expect(matcher.obfuscate(got)).toBe(got);
  });
});

describe("sensitive-words-replace", () => {
  it("replaces case-insensitively, longest first, before obfuscating; an empty replacement deletes", () => {
    const matcher = defined(
      buildAntigravitySensitiveWordMatcher({
        words: ["Claude", "Codex", "GPT-5"],
        replacements: {
          "You are Codex, an agent based on GPT-5.": "You are a helpful coding assistant.",
          "Claude Code": "Claude",
          Codex: "Assistant",
          "RemoveMe ": "",
        },
      }),
    );

    expect(
      matcher.obfuscate(
        "you are codex, an agent based on gpt-5. Built for Claude Code, standalone Claude, Codex, and RemoveMe .",
      ),
    ).toBe(
      "You are a helpful coding assistant. Built for Claude, standalone C\u034Flaude, Assistant, and  .",
    );
  });

  it("works alone in a Claude body and skips the billing header", () => {
    const matcher = defined(
      buildSensitiveWordMatcher({ words: [], replacements: { anthropic: "provider", secret: "" } }),
    );

    const body: JsonObject = {
      system: [
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=2.1.321; cc_entrypoint=cli;",
        },
        { type: "text", text: "Keep anthropic rules and drop secret" },
      ],
      messages: [{ role: "user", content: "Ask anthropic about secret" }],
    };

    obfuscateSensitiveWords(body, matcher);

    expect(body).toEqual({
      system: [
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=2.1.321; cc_entrypoint=cli;",
        },
        { type: "text", text: "Keep provider rules and drop " },
      ],
      messages: [{ role: "user", content: "Ask provider about " }],
    });
  });
});

describe("sensitive-patterns-replace", () => {
  it("applies the rules in order without cascading, skipping an invalid one", () => {
    const matcher = defined(
      buildAntigravitySensitiveWordMatcher({
        words: ["Claude", "omp"],
        replacements: { Codex: "Assistant" },
        patterns: [
          { pattern: "[invalid", replacement: "skip" },
          { pattern: "(?m)^You are (omp|Codex)[^\\n]*\\n?", replacement: "You are Claude ($1).\n" },
          {
            pattern:
              "(?s)<system[-_](conventions|directive)>.*?</system[-_](conventions|directive)>\\n?",
            replacement: "",
          },
        ],
      }),
    );

    expect(matcher.obfuscate("<system-directive>hello</system-directive>")).toBe("");
    expect(
      matcher.obfuscate(
        "You are omp's assistant.\n<system-directive>\nRFC 2119\n</system-directive>\nKeep Codex and omp.",
      ),
    ).toBe("You are Claude (omp).\nKeep Assistant and o\u034Fmp.");
  });

  it("works alone in a Claude body", () => {
    const matcher = defined(
      buildSensitiveWordMatcher({
        words: [],
        patterns: [
          { pattern: "(?m)^RFC 2119[^\\n]*\\n?", replacement: "" },
          { pattern: "secret-\\d+", replacement: "[redacted]" },
        ],
      }),
    );

    const body: JsonObject = {
      system: [
        { type: "text", text: "x-anthropic-billing-header: secret-123" },
        { type: "text", text: "RFC 2119 applies.\nKeep secret-42." },
      ],
      messages: [{ role: "user", content: [{ type: "text", text: "Check secret-99" }] }],
    };

    obfuscateSensitiveWords(body, matcher);

    expect(body).toEqual({
      system: [
        { type: "text", text: "x-anthropic-billing-header: secret-123" },
        { type: "text", text: "Keep [redacted]." },
      ],
      messages: [{ role: "user", content: [{ type: "text", text: "Check [redacted]" }] }],
    });
  });

  it("matches against the original text: anchors are not synthesised and deletions do not cascade", () => {
    const prefix = defined(
      buildSensitiveWordMatcher({
        words: [],
        patterns: [
          { pattern: "prefix", replacement: "safe" },
          { pattern: "(?m)^KEEP", replacement: "" },
        ],
      }),
    );

    expect(prefix.obfuscate("prefixKEEP")).toBe("safeKEEP");

    const suffix = defined(
      buildSensitiveWordMatcher({
        words: [],
        patterns: [
          { pattern: "suffix", replacement: "safe" },
          { pattern: "(?m)KEEP$", replacement: "" },
        ],
      }),
    );

    expect(suffix.obfuscate("KEEPsuffix")).toBe("KEEPsafe");

    const nonCascade = defined(
      buildSensitiveWordMatcher({
        words: ["foobar"],
        replacements: { foobar: "LITERAL_CHANGED" },
        patterns: [
          { pattern: "DELETE", replacement: "" },
          { pattern: "foobar", replacement: "REGEX_CHANGED" },
        ],
      }),
    );

    expect(nonCascade.obfuscate("fooDELETEbar")).toBe("foobar");
    expect(nonCascade.sanitizeDevinText("fooDELETEbar\nkeep")).toBe("foobar\nkeep");
  });

  it("lets a deletion that covers earlier deletions replace them", () => {
    const matcher = defined(
      buildAntigravitySensitiveWordMatcher({
        words: ["RFC 2119"],
        patterns: [
          { pattern: "(?m)^RFC 2119[^\\n]*\\n?", replacement: "" },
          {
            pattern: "(?s)<system[-_]conventions>.*?</system[-_]conventions>\\n?",
            replacement: "",
          },
        ],
      }),
    );

    expect(
      matcher.obfuscate("<system-conventions>\nRFC 2119 applies.\n</system-conventions>\nKeep me."),
    ).toBe("Keep me.");
  });

  it("expands named groups and skips empty matches that insert nothing", () => {
    const matcher = defined(
      buildSensitiveWordMatcher({
        words: [],
        patterns: [
          { pattern: "(?P<who>Codex|omp) agent", replacement: "${who}-assistant" },
          { pattern: "x*", replacement: "" },
        ],
      }),
    );

    expect(matcher.obfuscate("an omp agent")).toBe("an omp-assistant");
  });

  it("replaces the system instruction of an Antigravity request, as text and as parts", () => {
    const matcher = defined(
      buildAntigravitySensitiveWordMatcher({
        words: ["secret"],
        replacements: { Codex: "Assistant" },
        patterns: [{ pattern: "(?m)^RFC 2119[^\\n]*\\n?", replacement: "" }],
      }),
    );

    expect(
      obfuscateSystemInstruction(
        {
          request: {
            systemInstruction: { parts: [{ text: "RFC 2119 applies.\nCodex keeps the secret" }] },
            system_instruction: "Codex",
            contents: [{ role: "user", parts: [{ text: "Codex secret" }] }],
          },
        },
        matcher,
      ),
    ).toEqual({
      request: {
        systemInstruction: { parts: [{ text: "Assistant keeps the s\u034Fecret" }] },
        system_instruction: "Assistant",
        contents: [{ role: "user", parts: [{ text: "Codex secret" }] }],
      },
    });
  });
});

describe("Devin system prompt", () => {
  it("emits a pattern replacement verbatim and drops the original lines holding a sensitive word", () => {
    const matcher = defined(
      buildSensitiveWordMatcher({
        words: ["Claude", "DropMe"],
        patterns: [{ pattern: "You are omp\\.", replacement: "You are Claude." }],
      }),
    );

    expect(matcher.sanitizeDevinText("You are omp.\nRemove DropMe line.\nKeep final line.")).toBe(
      "You are Claude.\nKeep final line.",
    );
  });

  it("drops a multi-line replacement with the line it came from", () => {
    const literal = defined(
      buildSensitiveWordMatcher({ words: ["DROP_ME"], replacements: { alias: "safe\ncontinued" } }),
    );

    expect(literal.sanitizeDevinText("DROP_ME alias\nKeep")).toBe("Keep");
    expect(literal.sanitizeDevinText("alias DROP_ME\nKeep")).toBe("Keep");
    expect(literal.sanitizeDevinText("alias\nKeep")).toBe("safe\ncontinued\nKeep");

    const pattern = defined(
      buildSensitiveWordMatcher({
        words: ["DROP_ME"],
        patterns: [{ pattern: "alias-\\d+", replacement: "safe\ncontinued" }],
      }),
    );

    expect(pattern.sanitizeDevinText("DROP_ME alias-1\nKeep")).toBe("Keep");
    expect(pattern.sanitizeDevinText("alias-1 DROP_ME\nKeep")).toBe("Keep");
  });

  it("follows the original lines when a match consumes a newline", () => {
    const consuming = defined(
      buildSensitiveWordMatcher({
        words: ["DROP_ME"],
        patterns: [
          { pattern: "alias-\\d+\\n", replacement: "" },
          { pattern: "(?s)<system-conventions>.*?</system-conventions>\\n?", replacement: "" },
        ],
      }),
    );

    expect(consuming.sanitizeDevinText("DROP_ME alias-1\nKeep")).toBe("Keep");
    expect(
      consuming.sanitizeDevinText("DROP_ME <system-conventions>\nRFC\n</system-conventions>\nKeep"),
    ).toBe("Keep");
    expect(consuming.sanitizeDevinText("KeepPrefix alias-1\nDROP_ME\nKeepAfter")).toBe(
      "KeepPrefix KeepAfter",
    );

    const replacing = defined(
      buildSensitiveWordMatcher({
        words: ["DROP_ME"],
        replacements: { "L1\nL2": "M" },
        patterns: [
          { pattern: "A\\nB", replacement: "X" },
          { pattern: "alias\\n", replacement: "safe\n" },
          { pattern: "lead\\n", replacement: "safe" },
        ],
      }),
    );

    expect(replacing.sanitizeDevinText("prefix A\nB suffix")).toBe("prefix X suffix");
    expect(replacing.sanitizeDevinText("prefix L1\nL2 suffix")).toBe("prefix M suffix");
    expect(replacing.sanitizeDevinText("DROP_ME alias\nKeep")).toBe("Keep");
    expect(replacing.sanitizeDevinText("lead\nDROP_ME\nKeep")).toBe("safeKeep");
  });
});
