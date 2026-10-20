// The consent page of an MCP client's sign-in on Commissary Cloud (src/lib/consent.ts, #200): what it says of the
// client, whose name is its own claim unless it is identified by its domain, and where the member goes next.
import { describe, expect, it } from "vitest";
import {
  authorizeQuery,
  CLIENT_NAME_SHOWN,
  clientName,
  consentPageOf,
  consentProblem,
  identityNote,
  isAuthorizeRequest,
  redirectNote,
} from "../src/lib/consent.ts";

describe("the request", () => {
  it("is the query the client sent, passed on as is", () => {
    expect(authorizeQuery("?client_id=a&state=b")).toBe("?client_id=a&state=b");
    expect(authorizeQuery("client_id=a")).toBe("?client_id=a");
    expect(authorizeQuery("")).toBe("");
    expect(authorizeQuery("?")).toBe("");
  });

  it("is one only when it names a client", () => {
    expect(isAuthorizeRequest("?client_id=a")).toBe(true);
    expect(isAuthorizeRequest("?state=b")).toBe(false);
    expect(isAuthorizeRequest("")).toBe(false);
  });

  it("goes to the consent page of the org the member chooses, query kept", () => {
    expect(consentPageOf("acme", "?client_id=a")).toBe("/o/acme/authorize?client_id=a");
    expect(consentPageOf("a b", "")).toBe("/o/a%20b/authorize");
  });
});

describe("the client", () => {
  it("is shown by its name, without control characters, cut when long", () => {
    expect(clientName({ client_name: "  Claude Code " })).toBe("Claude Code");
    expect(clientName({ client_name: "Evil\u0000App\u001b" })).toBe("Evil App");
    expect(clientName({ client_name: " \u0007 " })).toBe("An unnamed app");

    const long = clientName({ client_name: "x".repeat(CLIENT_NAME_SHOWN + 5) });

    expect(Array.from(long)).toHaveLength(CLIENT_NAME_SHOWN + 1);
    expect(long.endsWith("…")).toBe(true);
  });

  it("names itself, unless its domain identifies it", () => {
    expect(identityNote({})).toContain("cannot check it");
    expect(identityNote({ client_domain: "claude.ai" })).toBe(
      "The app is identified by claude.ai, which publishes its details.",
    );
  });

  it("says where its access goes", () => {
    expect(redirectNote({ redirect_host: "127.0.0.1", redirect_is_loopback: true })).toBe(
      "Its access goes to an app on this computer.",
    );
    expect(redirectNote({ redirect_host: "claude.ai", redirect_is_loopback: false })).toBe(
      "Its access goes to claude.ai.",
    );
  });
});

describe("a refused sign-in", () => {
  it("shows the server's reason, or what the member can do", () => {
    expect(consentProblem("sign_in_refused", "422", "this sign-in has expired")).toBe(
      "This sign-in has expired.",
    );
    expect(consentProblem("member_required", "403")).toContain("not one here");
    expect(consentProblem("too_many_keys", "409")).toContain("Revoke keys");
    expect(consentProblem(undefined, "Network error")).toBe("Network error");
  });
});
