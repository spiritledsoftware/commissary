import { describe, expect, it } from "vite-plus/test";
import { safeNextPath, signInProblem } from "../src/lib/sign-in.ts";

describe("the page to open after signing in", () => {
  it("keeps a path of this origin, with its query", () => {
    expect(safeNextPath("/o/acme/accounts")).toBe("/o/acme/accounts");
    expect(safeNextPath("/usage?range=7d")).toBe("/usage?range=7d");
  });

  it("falls back to the root for anything else", () => {
    for (const next of [
      null,
      undefined,
      "",
      "accounts",
      "//evil.example",
      "/\\evil.example",
      "https://evil.example/",
      "javascript:alert(1)",
      "/a\nb",
      "/sign-in",
      "/sign-in?next=/x",
    ])
      expect(safeNextPath(next)).toBe("/");
  });
});

describe("a failed sign-in", () => {
  it("says nothing without an error", () => {
    expect(signInProblem(null)).toBeUndefined();
    expect(signInProblem("")).toBeUndefined();
  });

  it("explains an unverified email and falls back for unknown codes", () => {
    expect(signInProblem("email_not_verified")).toContain("not verified");
    expect(signInProblem("whatever")).toContain("Sign-in failed");
  });
});
