// LCP affinity namespaces per provider (CLIProxyAPI 3b20ee22).
import { describe, expect, it } from "vite-plus/test";
import { lcpNamespace } from "../../src/session-routing/matcher.ts";

describe("LCP namespaces (CLIProxyAPI 3b20ee22)", () => {
  it("keeps gemini, vertex and aistudio apart", () => {
    const gemini = lcpNamespace("gemini", "m", "scope");

    expect(gemini).toBe("lcp:v1::gemini::m::scope");
    expect(lcpNamespace("google", "m", "scope")).toBe(gemini);
    expect(lcpNamespace("vertex", "m", "scope")).toBe("lcp:v1::vertex::m::scope");
    expect(lcpNamespace("aistudio", "m", "scope")).toBe("lcp:v1::aistudio::m::scope");
  });
});
