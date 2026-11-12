// Where the sign-in page and the sign-out send their requests on Commissary Cloud (src/lib/auth-origin.ts).
import { describe, expect, it } from "vite-plus/test";
import { authOriginOf } from "../src/lib/auth-origin.ts";

describe("authOriginOf", () => {
  it("takes an http(s) origin and nothing else", () => {
    expect(authOriginOf("https://auth.commissary.test")).toBe("https://auth.commissary.test");
    expect(authOriginOf(" http://localhost:1340 ")).toBe("http://localhost:1340");

    for (const content of [
      undefined,
      null,
      "",
      "auth.commissary.test",
      "https://auth.commissary.test/",
      "https://auth.commissary.test/api",
      "javascript:alert(1)",
      "ftp://auth.commissary.test",
    ])
      expect(authOriginOf(content), String(content)).toBe("");
  });
});
