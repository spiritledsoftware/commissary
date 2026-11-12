import { describe, expect, it } from "vite-plus/test";
import { getCodec } from "../src/tokenizer/index.ts";
import fixtures from "./fixtures/tokens.json";

describe("BPE counts match the Go tokenizer", () => {
  for (const name of ["o200k_base", "cl100k_base"] as const) {
    it(`${name}: fixture corpus`, () => {
      const codec = getCodec(name);
      const cases = fixtures.counts[name];
      expect(cases.length).toBeGreaterThan(100);

      const mismatches = cases
        .map((c) => ({ text: c.text.slice(0, 60), want: c.count, got: codec.count(c.text) }))
        .filter((c) => c.want !== c.got);

      expect(mismatches).toEqual([]);
    });
  }
});
