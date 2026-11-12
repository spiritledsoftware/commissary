import { describe, expect, it } from "vite-plus/test";
import { HEAP_MERGE_THRESHOLD } from "../src/tokenizer/bpe.ts";
import {
  encodingForCodexModel,
  encodingForModel,
  getCodec,
  goTrimSpace,
} from "../src/tokenizer/index.ts";
import fixtures from "./fixtures/tokens.json";

/** Deterministic xorshift so the "random" pieces are stable. */
const rng = (seed: number) => () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;

  return (seed >>> 0) / 0x1_0000_0000;
};

describe("tokenizer units", () => {
  it("maps models to encodings like helps.TokenizerForModel", () => {
    for (const { model, encoding } of fixtures.models)
      expect(encodingForModel(model), model).toBe(encoding);
  });

  it("maps Codex models like tokenizerForCodexModel", () => {
    expect(encodingForCodexModel("gpt-5.4")).toBe("o200k_base");
    expect(encodingForCodexModel("GPT-4.1-mini")).toBe("o200k_base");
    expect(encodingForCodexModel("gpt-4o")).toBe("o200k_base");
    expect(encodingForCodexModel("gpt-4")).toBe("cl100k_base");
    expect(encodingForCodexModel("gpt-3.5-turbo")).toBe("cl100k_base");
    expect(encodingForCodexModel("o3")).toBe("cl100k_base");
    expect(encodingForCodexModel("")).toBe("cl100k_base");
  });

  it("trims like Go strings.TrimSpace", () => {
    expect(goTrimSpace("\u0085 x \u00a0\u3000")).toBe("x");
    expect(goTrimSpace("\ufeffx")).toBe("\ufeffx");
    expect(goTrimSpace(" \t\n")).toBe("");
  });

  it("loads vocabularies lazily on the first count", () => {
    const codec = getCodec("cl100k_base");
    expect(codec.loaded).toBe(false);
    expect(codec.count("")).toBe(0);
    expect(codec.loaded).toBe(false);
    expect(codec.count("hello world")).toBe(2);
    expect(codec.loaded).toBe(true);
  });

  it("the heap merge equals the Go merge loop", () => {
    const next = rng(25);
    const codec = getCodec("o200k_base");
    const alphabets = ["ab", "abcdefgh ", "etaoin shrdlu", "é中文😀ab", "0123456789"];

    for (let round = 0; round < 300; round++) {
      const alphabet = Array.from(alphabets[round % alphabets.length] as string);
      const length = 1 + Math.floor(next() * (round % 5 === 0 ? 600 : 60));
      let piece = "";

      for (let i = 0; i < length; i++) piece += alphabet[Math.floor(next() * alphabet.length)];
      const { naive, heap } = codec.mergeCounts(piece);
      expect(heap, JSON.stringify(piece)).toBe(naive);
    }
  });

  it("counts very long single pieces without quadratic blow-up", () => {
    const codec = getCodec("o200k_base");
    const long = "a".repeat(200_000);
    // Go's loop is O(n^2) here; the heap merge finishes well inside the test timeout.
    expect(codec.count(long)).toBeGreaterThan(HEAP_MERGE_THRESHOLD);
  });
});
