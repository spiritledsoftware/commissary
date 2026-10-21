// The Toolkits page's model (src/lib/toolkits.ts, #208, ADR 0036, ADR 0037): each row's kind, source, sign-in state, tool
// count and flags, the order of the rows, what an org admin sees of other members' private toolkits, and which controls
// each caller gets.
import { describe, expect, it } from "vitest";
import type {
  LimitedToolkitView,
  ToolkitCredentialView,
  ToolkitView,
} from "@commissary/contract/tools";
import {
  canAdd,
  connectPageOf,
  controlsFor,
  otherRows,
  principalName,
  sortRows,
  toolkitNameProblem,
  toolkitProblem,
  toolkitRow,
  toolsCallerOf,
} from "../src/lib/toolkits.ts";

const toolkit = (patch: Partial<ToolkitView> = {}): ToolkitView => ({
  id: "tk_1",
  kind: "mcp",
  name: "linear",
  source: "https://mcp.linear.app/mcp",
  private: false,
  accepts: "shared",
  revision: 1,
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
  updated_by: "user:admin@example.com",
  credentials: {},
  tool_list: { tools: 12, built_at: "2026-08-02T00:00:00.000Z" },
  ...patch,
});

const connected = (patch: Partial<ToolkitCredentialView> = {}): ToolkitCredentialView => ({
  kind: "bearer",
  connected_at: "2026-08-01T00:00:00.000Z",
  connected_by: "user:admin@example.com",
  active: true,
  ...patch,
});

const ADMIN = { admin: true, privateCredentials: true, privateToolkits: true };

const MEMBER = { admin: false, privateCredentials: true, privateToolkits: true };

const flags = (patch: Partial<ToolkitView>) =>
  toolkitRow(toolkit(patch)).flags.map((flag) => `${flag.severity}: ${flag.text}`);

describe("a toolkit's row", () => {
  it("shows its kind, source, sign-ins and tool count", () => {
    const row = toolkitRow(toolkit({ accepts: "both", credentials: { shared: connected() } }));

    expect(row).toMatchObject({
      kind: "MCP server",
      source: "mcp.linear.app/mcp",
      tools: "12",
      signIns: [
        { slot: "shared", text: "Shared: bearer token" },
        { slot: "private", text: "Yours: not connected" },
      ],
      flags: [],
    });
    expect(toolkitRow(toolkit({ kind: "openapi", source: "", uploaded: true })).source).toBe(
      "Uploaded document",
    );
    expect(toolkitRow(toolkit({ tool_list: { tools: 0 } })).tools).toBe("Not listed yet");
  });

  it("flags what is failing (a listing, a sign-in to do again) and what to tidy (a name to change)", () => {
    expect(flags({ tool_list: { tools: 3, error: "the server answered 500" } })).toEqual([
      "failing: Listing failed: the server answered 500",
    ]);
    expect(flags({ credentials: { shared: connected({ needs_sign_in: true }) } })).toEqual([
      "failing: The shared credential needs sign-in again",
    ]);
    expect(
      flags({ accepts: "both", credentials: { mine: connected({ needs_sign_in: true }) } }),
    ).toEqual(["failing: Your private credential needs sign-in again"]);
    expect(flags({ private: true, accepts: "private", rename_suggested: true })).toEqual([
      "note: An org toolkit took this name: rename yours",
    ]);
    expect(flags({ shadowed: true })).toEqual([
      "note: Your private toolkit of this name is served instead",
    ]);
    expect(
      flags({ accepts: "private", credentials: { shared: connected({ active: false }) } }),
    ).toEqual(["failing: The shared credential is not used: the toolkit does not accept it"]);
  });

  it("lists those failing first, then by name: a name to tidy does not jump the queue", () => {
    const rows = sortRows(
      [
        toolkit({ id: "a", name: "alpha", shadowed: true }),
        toolkit({ id: "z", name: "zulu", tool_list: { tools: 1, error: "503" } }),
        toolkit({ id: "b", name: "bravo" }),
      ].map(toolkitRow),
    );

    expect(rows.map((row) => row.toolkit.name)).toEqual(["zulu", "alpha", "bravo"]);
  });

  it("is a built-in toolkit's without a credential to sign in", () => {
    const browser = toolkitRow(
      toolkit({
        id: "browser",
        name: "browser",
        kind: "browser",
        built_in: true,
        source: "browser-run",
      }),
    );

    expect(browser).toMatchObject({
      kind: "Browser",
      source: "Provided by Commissary",
      signIns: [],
    });
  });
});

describe("other members' private toolkits", () => {
  it("show an org admin only that each exists: its owner and when it was added", () => {
    const limited: LimitedToolkitView = {
      id: "tk_9",
      private: true,
      limited: true,
      owner: { member_id: "m_2", email: "bob@example.com" },
      created_at: "2026-08-03T10:00:00.000Z",
      revision: 4,
    };

    expect(otherRows([limited])).toEqual([
      { id: "tk_9", owner: "bob@example.com", added: "Added Aug 3, 2026", revision: 4 },
    ]);
  });
});

describe("the controls a caller gets", () => {
  it("give a plain member nothing of an org toolkit but their own credential, where it takes one", () => {
    expect(
      controlsFor(toolkit({ accepts: "both", credentials: { shared: connected() } }), MEMBER),
    ).toEqual({
      manage: false,
      shared: false,
      private: true,
      refresh: false,
      remove: false,
      prices: false,
      approvals: false,
    });
    // Without a shared credential, a refresh builds the list with the member's own: theirs to ask for.
    expect(controlsFor(toolkit({ accepts: "both" }), MEMBER).refresh).toBe(true);
    expect(
      controlsFor(toolkit({ accepts: "both" }), { ...MEMBER, privateCredentials: false }),
    ).toMatchObject({ private: false });
    expect(controlsFor(toolkit({ accepts: "shared" }), MEMBER).private).toBe(false);
  });

  it("give an org admin an org toolkit's, and a member their own private toolkit's", () => {
    expect(controlsFor(toolkit({ accepts: "both" }), ADMIN)).toEqual({
      manage: true,
      shared: true,
      private: true,
      refresh: true,
      remove: true,
      prices: true,
      approvals: true,
    });
    // A member sets the approval rules of their own private toolkit, but may not price it (#209, ADR 0038).
    expect(controlsFor(toolkit({ private: true, accepts: "private" }), MEMBER)).toEqual({
      manage: true,
      shared: false,
      private: true,
      refresh: true,
      remove: true,
      prices: false,
      approvals: true,
    });
    // While the org has private toolkits off, its member keeps it but connects nothing to it.
    expect(
      controlsFor(toolkit({ private: true, accepts: "private" }), {
        ...MEMBER,
        privateToolkits: false,
      }).private,
    ).toBe(false);
  });

  it("give nobody a built-in toolkit's credentials, refresh or removal, and org admins its overrides", () => {
    const sandbox = toolkit({ id: "sandbox", kind: "sandbox", built_in: true });

    // The approval rules and the price per computer hour are an org admin's on a built-in toolkit (#201, #224).
    expect(controlsFor(sandbox, ADMIN)).toEqual({
      manage: true,
      shared: false,
      private: false,
      refresh: false,
      remove: false,
      prices: true,
      approvals: true,
    });
    expect(controlsFor(sandbox, MEMBER)).toMatchObject({
      manage: false,
      prices: false,
      approvals: false,
    });
  });
});

describe("the caller", () => {
  it("reads the org's settings from /me: off when they are absent", () => {
    expect(toolsCallerOf({ role: "member", platform_admin: false })).toEqual({
      admin: false,
      privateCredentials: false,
      privateToolkits: false,
    });
    expect(
      toolsCallerOf({
        role: null,
        platform_admin: true,
        private_credentials: true,
        private_toolkits: true,
      }),
    ).toEqual({ admin: true, privateCredentials: true, privateToolkits: true });
  });
});

describe("a refused change", () => {
  it("says what happened in the panel's words, else the server's", () => {
    expect(toolkitProblem("name_taken", "Name taken.", undefined)).toBe(
      "Another toolkit has that name: pick another.",
    );
    expect(toolkitProblem("private_toolkits_unavailable", "x", undefined)).toBe(
      "This org does not let members add private toolkits, or use the ones they have.",
    );
    expect(toolkitProblem("lookup_rate_limited", "x", "try again in 40 seconds")).toBe(
      "Too many lookups for now: try again in 40 seconds.",
    );
    expect(toolkitProblem("invalid", "Invalid.", "the URL is not https")).toBe(
      "The URL is not https.",
    );
    expect(toolkitProblem(undefined, "The server did not answer.", undefined)).toBe(
      "The server did not answer.",
    );
  });
});

describe("a toolkit's name", () => {
  it("is lowercase words of letters and digits joined by _, at most 32 characters, or the default", () => {
    expect(toolkitNameProblem("")).toBeUndefined();
    expect(toolkitNameProblem("github_rest")).toBeUndefined();
    expect(toolkitNameProblem("GitHub")).toBe(
      "A name is lowercase letters and digits, words joined by single _.",
    );
    expect(toolkitNameProblem("github__rest")).toBe(
      "A name is lowercase letters and digits, words joined by single _.",
    );
    expect(toolkitNameProblem("a".repeat(33))).toBe("A name is at most 32 characters.");
  });
});

describe("who connected a credential", () => {
  it("is an Access principal's email, else the principal as it is", () => {
    expect(principalName("user:ann@example.com")).toBe("ann@example.com");
    expect(principalName("service:ci-token")).toBe("service:ci-token");
  });
});

describe("adding a toolkit", () => {
  it("is an org admin's, and a member's where the org allows private toolkits", () => {
    expect(canAdd(ADMIN)).toBe(true);
    expect(canAdd(MEMBER)).toBe(true);
    expect(canAdd({ ...MEMBER, privateToolkits: false })).toBe(false);
    expect(canAdd({ ...ADMIN, privateToolkits: false })).toBe(true);
  });
});

describe("the connect page a call links to", () => {
  it("offers the caller's private credential where the toolkit and the org take one", () => {
    expect(connectPageOf(toolkit({ accepts: "both" }), MEMBER)).toEqual({ kind: "form" });
    expect(connectPageOf(toolkit({ private: true, accepts: "private" }), MEMBER)).toEqual({
      kind: "form",
    });
  });

  it("says why it cannot, and who can help", () => {
    expect(connectPageOf(toolkit({ accepts: "shared" }), MEMBER)).toEqual({
      kind: "refused",
      reason:
        "It signs in with the org's shared credential only, which an org admin connects; you use it under your tool grants.",
    });
    expect(
      connectPageOf(toolkit({ accepts: "private" }), { ...MEMBER, privateCredentials: false }),
    ).toEqual({
      kind: "refused",
      reason:
        "This org does not let members connect private credentials now: ask an org admin to connect the shared one, or to turn private credentials on.",
    });
    expect(
      connectPageOf(toolkit({ private: true, accepts: "private" }), {
        ...MEMBER,
        privateToolkits: false,
      }),
    ).toEqual({
      kind: "refused",
      reason:
        "This org does not let members use private toolkits now: an org admin can turn them back on.",
    });
    expect(
      connectPageOf(toolkit({ id: "browser", kind: "browser", built_in: true }), ADMIN),
    ).toEqual({
      kind: "refused",
      reason: "Commissary provides this toolkit itself: it takes no credential.",
    });
  });
});
