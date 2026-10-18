// Connecting an account in the panel (src/lib/connect.ts): the pasted address check and auth-file names.
import { describe, expect, it } from "vitest";
import { OAuthProvider } from "@commissary/contract/oauth";
import { authFileName, CONNECT_OPTIONS, linkHost, readPastedAddress } from "../src/lib/connect.ts";

describe("readPastedAddress", () => {
  it("accepts the whole localhost address with the provider's answer", () => {
    expect(readPastedAddress("  http://localhost:54545/callback?code=abc&state=xyz ")).toEqual({
      ok: true,
      url: "http://localhost:54545/callback?code=abc&state=xyz",
    });
    expect(readPastedAddress("http://localhost:1455/auth/callback?error=access_denied").ok).toBe(
      true,
    );
  });

  it("explains what is wrong before anything is sent", () => {
    expect(readPastedAddress("")).toMatchObject({ ok: false });
    expect(readPastedAddress("abc123")).toMatchObject({
      ok: false,
      problem: expect.stringContaining("whole address"),
    });
    expect(readPastedAddress("http://localhost:54545/callback")).toMatchObject({
      ok: false,
      problem: expect.stringContaining("no sign-in answer"),
    });
  });
});

describe("connect options", () => {
  it("offers only providers the server can start", () => {
    for (const option of CONNECT_OPTIONS) {
      if (option.method.kind === "sign-in") {
        expect(OAuthProvider.literals).toContain(option.method.provider);
      }
    }

    expect(new Set(CONNECT_OPTIONS.map((option) => option.id)).size).toBe(CONNECT_OPTIONS.length);
  });

  it("says who a Claude subscription is for before signing in", () => {
    const notice = CONNECT_OPTIONS.find((option) => option.id === "claude")?.notice ?? "";
    expect(notice).toContain("private account");
    expect(notice).toContain("provider key");
    expect(notice).toContain("Usage Policy");
    expect(notice).toContain("own risk");
  });

  it("names the host a link goes to", () => {
    expect(linkHost("https://claude.ai/oauth/authorize?x=1")).toBe("claude.ai");
    expect(linkHost("not a url")).toBe("not a url");
  });
});

describe("authFileName", () => {
  it("keeps the base name of a .json file", () => {
    expect(authFileName("claude-me.json")).toBe("claude-me.json");
    expect(authFileName("C:\\fakepath\\codex.JSON")).toBe("codex.JSON");
    expect(authFileName("notes.txt")).toBeUndefined();
    expect(authFileName(".json")).toBeUndefined();
  });
});
