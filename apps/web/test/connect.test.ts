// Connecting an account in the panel (src/lib/connect.ts): the pasted address check and auth-file names.
import { describe, expect, it } from "vitest";
import { OAuthProvider } from "@commissary/contract/oauth";
import {
  authFileName,
  CONNECT_OPTIONS,
  connectNotices,
  linkHost,
  readPastedAddress,
} from "../src/lib/connect.ts";

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

const connectOption = (id: string) => {
  const option = CONNECT_OPTIONS.find((candidate) => candidate.id === id);

  if (option === undefined) throw new Error(`no connect option ${id}`);

  return option;
};

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

  // Each notice quotes or names what the provider's terms say (docs/research/provider-terms.md, cloud-credentials.md).
  it.each([
    ["claude", "resell, proxy, or otherwise provide access to Claude through unauthorized means"],
    ["codex", "join the waitlist to request access before offering it to users"],
    ["xai", "unauthorized automated or non-human means"],
    ["antigravity", "Using third party software, tools, or services to access the Service"],
    ["devin", "users must not provide other users with access to their account"],
    ["meta", "through any model aggregator, API gateway, proxy, or similar offering"],
    ["kimi", "Kimi Code subscriptions are for interactive use only"],
    ["kimi-ai", "Kimi Code subscriptions are for interactive use only"],
    ["file", "terms bar or don't address use through a gateway"],
  ])("warns about %s's terms before connecting, at the org's own risk", (id, quote) => {
    const notices = connectNotices(connectOption(id), false);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(quote);
    expect(notices[0]).toContain("own risk");
  });

  it("gives Vertex no notice, private or shared", () => {
    expect(connectOption("vertex").notice).toBeUndefined();
    expect(connectNotices(connectOption("vertex"), false)).toEqual([]);
    expect(connectNotices(connectOption("vertex"), true)).toEqual([]);
  });

  it("adds the sharing notice to every account connected as a shared credential, and to none connected privately", () => {
    for (const option of CONNECT_OPTIONS) {
      const shared = connectNotices(option, true);
      const privately = connectNotices(option, false);

      if (option.method.kind === "vertex") {
        expect(shared, option.id).toEqual([]);
        continue;
      }

      expect(shared, option.id).toHaveLength(privately.length + 1);
      expect(shared.at(-1), option.id).toContain("Providers' terms forbid sharing a subscription");
      expect(shared.at(-1), option.id).toContain("own risk");
      expect(privately.join(" "), option.id).not.toContain("forbids sharing");
    }
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
