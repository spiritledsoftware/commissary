// The Accounts page's filtering (src/lib/accounts.ts), selection and the folding of batch and quota-sweep outcomes
// (src/lib/batch.ts).
import { describe, expect, it } from "vite-plus/test";
import type { CredentialEntry } from "@commissary/contract/credentials";
import {
  accountActions,
  accountName,
  assess,
  isConfigAccount,
  keyHome,
  selectable,
  shownAccounts,
} from "../src/lib/accounts.ts";
import {
  actionSummary,
  afterAction,
  chunks,
  clearShown,
  failureReason,
  foldOutcomes,
  hiddenNote,
  keepExisting,
  planAction,
  rowFailure,
  selectShown,
  shownState,
  skippedNote,
  sweepSummary,
  toggle,
} from "../src/lib/batch.ts";

const entry = (
  overrides: Partial<CredentialEntry> & Pick<CredentialEntry, "name" | "provider">,
): CredentialEntry => ({
  id: overrides.name,
  auth_index: overrides.name,
  type: overrides.provider,
  label: "",
  status: "active",
  status_message: "",
  disabled: false,
  unavailable: false,
  runtime_only: false,
  source: "file",
  size: 0,
  success: 0,
  failed: 0,
  recent_requests: [],
  quota: { signals: {} },
  cooldowns: [],
  ...overrides,
});

const ACCOUNTS = [
  entry({ name: "a.json", provider: "claude", email: "ann@x.dev" }),
  entry({ name: "b.json", provider: "codex", email: "bob@x.dev", disabled: true }),
  entry({ name: "c.json", provider: "xai", email: "cat@x.dev", status: "error" }),
  entry({ name: "d.json", provider: "claude", email: "dan@y.dev", note: "team" }),
].map(assess);

const names = (list: ReadonlyArray<{ readonly entry: CredentialEntry }>) =>
  list.map((account) => account.entry.name);

describe("shownAccounts", () => {
  it("filters by tab and search, keeping the order", () => {
    expect(names(shownAccounts(ACCOUNTS, "all", ""))).toEqual([
      "a.json",
      "b.json",
      "c.json",
      "d.json",
    ]);
    expect(names(shownAccounts(ACCOUNTS, "disabled", ""))).toEqual(["b.json"]);
    expect(names(shownAccounts(ACCOUNTS, "attention", ""))).toEqual(["c.json"]);
    expect(names(shownAccounts(ACCOUNTS, "all", "claude"))).toEqual(["a.json", "d.json"]);
    expect(names(shownAccounts(ACCOUNTS, "all", "team"))).toEqual(["d.json"]);
    expect(names(shownAccounts(ACCOUNTS, "disabled", "claude"))).toEqual([]);
  });
});

describe("selection", () => {
  it("toggles one account at a time", () => {
    const one = toggle(new Set(), "a.json");

    expect([...one]).toEqual(["a.json"]);
    expect([...toggle(one, "a.json")]).toEqual([]);
  });

  it("selects and clears what is shown, keeping hidden selections", () => {
    const hidden = new Set(["b.json"]);
    const shown = ["a.json", "d.json"];
    const all = selectShown(hidden, shown);

    expect([...all].toSorted()).toEqual(["a.json", "b.json", "d.json"]);
    expect([...clearShown(all, shown)]).toEqual(["b.json"]);
  });

  it("tells the select-all checkbox whether none, some or all shown accounts are selected", () => {
    const shown = ["a.json", "d.json"];

    expect(shownState(new Set(), shown)).toBe("none");
    expect(shownState(new Set(["b.json"]), shown)).toBe("none");
    expect(shownState(new Set(["a.json"]), shown)).toBe("some");
    expect(shownState(new Set(["a.json", "d.json", "b.json"]), shown)).toBe("all");
  });

  it("a delete sends exactly the selected accounts shown, in list order, and counts the hidden ones", () => {
    // Search "claude" shows a and d; b was selected before and is hidden now.
    const shown = shownAccounts(ACCOUNTS, "all", "claude");

    expect(planAction("delete", new Set(["d.json", "b.json", "a.json"]), shown)).toEqual({
      acting: ["a.json", "d.json"],
      send: ["a.json", "d.json"],
      leftOut: [],
      hidden: 1,
    });
    expect(planAction("disable", new Set(), shown)).toEqual({
      acting: [],
      send: [],
      leftOut: [],
      hidden: 0,
    });
  });

  it("a token refresh leaves out the accounts whose provider has none", () => {
    const shown = [...ACCOUNTS, assess(entry({ name: "e.json", provider: "devin" }))];

    expect(planAction("refresh", new Set(["e.json", "a.json", "c.json"]), shown)).toEqual({
      acting: ["a.json", "c.json", "e.json"],
      send: ["a.json", "c.json"],
      leftOut: ["e.json"],
      hidden: 0,
    });
  });

  it("drops accounts that no longer exist, keeping identity when nothing changed", () => {
    const selected = new Set(["a.json", "gone.json"]);

    expect([...keepExisting(selected, ["a.json", "b.json"])]).toEqual(["a.json"]);

    const same = new Set(["a.json"]);

    expect(keepExisting(same, ["a.json"])).toBe(same);
  });
});

describe("chunks", () => {
  it("splits a selection into requests the server accepts", () => {
    const many = Array.from({ length: 205 }, (_, index) => `f${index}`);

    expect(chunks(many, 100).map((chunk) => chunk.length)).toEqual([100, 100, 5]);
    expect(chunks([], 100)).toEqual([]);
    expect(chunks(["a"], 0)).toEqual([["a"]]);
  });
});

describe("foldOutcomes", () => {
  it("separates successes from failures with their reasons, across requests", () => {
    const folded = foldOutcomes([
      {
        names: ["a.json", "b.json", "c.json"],
        results: [
          { name: "a.json", ok: true },
          { name: "b.json", ok: false, error: "not_found", message: "auth file not found" },
          {
            name: "c.json",
            ok: false,
            error: "refresh_failed",
            message: "token endpoint answered 400",
          },
        ],
      },
      { names: ["d.json", "e.json"], failure: "The server did not answer." },
      {
        names: ["f.json"],
        results: [
          {
            name: "f.json",
            ok: false,
            skipped: true,
            error: "not_refreshable",
            message: "the account has no refresh token",
          },
        ],
      },
    ]);

    expect(folded).toEqual({
      succeeded: ["a.json"],
      failed: [
        { name: "b.json", reason: "It is no longer connected." },
        { name: "c.json", reason: "Token endpoint answered 400." },
        { name: "d.json", reason: "The server did not answer." },
        { name: "e.json", reason: "The server did not answer." },
      ],
      skipped: ["f.json"],
    });
  });

  it("counts a name the server did not answer for as failed", () => {
    expect(foldOutcomes([{ names: ["a.json"], results: [] }]).failed).toEqual([
      { name: "a.json", reason: "The server did not answer for it." },
    ]);
  });

  it("keeps the failed, skipped, left-out and hidden accounts selected and lets the others go", () => {
    const selected = new Set(["a.json", "b.json", "c.json", "d.json", "left.json", "hidden.json"]);

    const folded = foldOutcomes([
      {
        names: ["a.json", "b.json", "c.json", "d.json"],
        results: [
          { name: "a.json", ok: true },
          {
            name: "b.json",
            ok: false,
            error: "refresh_failed",
            message: "the token refresh failed (HTTP 400)",
          },
          { name: "c.json", ok: true },
          { name: "d.json", ok: false, skipped: true, error: "not_refreshable" },
        ],
      },
    ]);

    // left.json was shown but not sent (no token refresh); hidden.json was not shown.
    expect(
      [...afterAction(selected, ["a.json", "b.json", "c.json", "d.json"], folded)].toSorted(),
    ).toEqual(["b.json", "d.json", "hidden.json", "left.json"]);
  });
});

describe("summaries", () => {
  const ok = (count: number) => Array.from({ length: count }, (_, index) => `ok${index}`);

  const failed = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ name: `bad${index}`, reason: "Nope." }));

  const folded = (succeeded: ReadonlyArray<string>, failures: ReturnType<typeof failed> = []) => ({
    succeeded,
    failed: failures,
    skipped: [],
  });

  it("says what an action did, in ink, and what failed, apart", () => {
    expect(actionSummary("disable", folded(ok(3)))).toEqual({
      done: "Disabled 3 accounts.",
      problem: "",
    });
    expect(actionSummary("enable", folded(ok(1)))).toEqual({
      done: "Enabled 1 account.",
      problem: "",
    });
    expect(actionSummary("delete", folded(ok(4), failed(2)))).toEqual({
      done: "Deleted 4 of 6 accounts.",
      problem: "2 failed and stay selected.",
    });
    expect(actionSummary("refresh", folded(ok(2), failed(1)), 1)).toEqual({
      done: "Refreshed the tokens of 2 of 3 accounts. 1 account has no token refresh. It was left out and stays selected.",
      problem: "1 failed and stays selected.",
    });
    expect(actionSummary("refresh", folded([], failed(1)))).toEqual({
      done: "",
      problem: "Could not refresh the account. It stays selected.",
    });
    expect(actionSummary("delete", folded([], failed(3)))).toEqual({
      done: "",
      problem: "Could not delete any of the 3 accounts. They stay selected.",
    });
    // Nothing sent: only the accounts left out.
    expect(actionSummary("refresh", folded([]), 2)).toEqual({
      done: "2 accounts have no token refresh. They were left out and stay selected.",
      problem: "",
    });
  });

  it("says how many accounts a token refresh left out, and how many the filter hides", () => {
    expect(skippedNote(0)).toBe("");
    expect(skippedNote(1)).toBe(
      "1 account has no token refresh. It was left out and stays selected.",
    );
    expect(hiddenNote(1)).toBe("1 more is selected but hidden by the filter. Actions skip it.");
    expect(hiddenNote(3)).toBe("3 more are selected but hidden by the filter. Actions skip them.");
  });

  it("words a failed row and the reasons the server sends", () => {
    expect(rowFailure("disable", "It is no longer connected.")).toBe(
      "Could not disable. It is no longer connected.",
    );
    expect(failureReason({ error: "unavailable" })).toBe(
      "Commissary could not reach its account store. Try again.",
    );
    expect(failureReason({ error: "check_failed", message: "usage request failed" })).toBe(
      "Usage request failed.",
    );
    expect(
      failureReason({ error: "check_failed", message: "usage answered 401", status: 401 }, "xAI"),
    ).toBe("xAI refused the saved sign-in. Refresh the tokens or reconnect.");
    expect(
      failureReason({ error: "check_failed", message: "usage answered 500", status: 500 }, "xAI"),
    ).toBe("Usage answered 500.");
  });

  it("says what a check of every quota did", () => {
    expect(sweepSummary(0, 0)).toEqual({
      done: "No enabled account reports quota, so there was nothing to check.",
      problem: "",
    });
    expect(sweepSummary(5, 0)).toEqual({ done: "Checked the quota of 5 accounts.", problem: "" });
    expect(sweepSummary(4, 1)).toEqual({
      done: "Checked the quota of 4 of 5 accounts.",
      problem: "1 failed.",
    });
    expect(sweepSummary(0, 1)).toEqual({
      done: "",
      problem: "The quota check failed for the account.",
    });
    expect(sweepSummary(0, 2)).toEqual({
      done: "",
      problem: "The quota check failed for all 2 accounts.",
    });
  });
});

describe("config accounts (OpenCode Go keys)", () => {
  const goKey = entry({
    name: "0123456789abcdef",
    provider: "opencode-go",
    source: "config",
    account: "[redacted]…0001",
    supports_quota: true,
    key_group: { family: "opencode-go", index: 2 },
  });

  it("offers the quota check only, and links the key's group", () => {
    expect(accountActions(goKey)).toEqual({
      checkQuota: true,
      refresh: false,
      toggle: false,
      routing: false,
      remove: false,
    });
    expect(keyHome(goKey)).toEqual({
      to: "/keys/$family/$index",
      params: { family: "opencode-go", index: "2" },
    });
    expect(
      keyHome(entry({ name: "fedcba9876543210", provider: "opencode-go", source: "config" })),
    ).toEqual({ to: "/keys" });
    expect(isConfigAccount(goKey)).toBe(true);
  });

  it("names a config key by its last characters", () => {
    expect(accountName(goKey)).toBe("Key …0001");
    expect(
      accountName(entry({ name: "fedcba9876543210", provider: "opencode-go", source: "config" })),
    ).toBe("fedcba9876543210");
  });

  it("leaves auth files as they were", () => {
    const [claude] = ACCOUNTS;

    expect(accountActions(claude!.entry)).toEqual({
      checkQuota: true,
      refresh: true,
      toggle: true,
      routing: true,
      remove: true,
    });
    expect(keyHome(claude!.entry)).toBeUndefined();
  });

  it("keeps config keys out of a selection and its actions", () => {
    const shown = [...ACCOUNTS, assess(goKey)];

    expect(names(selectable(shown))).toEqual(["a.json", "b.json", "c.json", "d.json"]);
    expect(planAction("disable", new Set(["0123456789abcdef"]), selectable(shown))).toMatchObject({
      send: [],
      hidden: 1,
    });
  });

  it("names the key, not a sign-in, when the provider refuses a check", () => {
    const refused = { error: "check_failed", message: "unauthorized", status: 401 } as const;

    expect(failureReason(refused, "OpenCode Go", true)).toBe(
      "OpenCode Go refused the provider key. Check it on the Provider keys page.",
    );
    expect(failureReason(refused, "Claude")).toBe(
      "Claude refused the saved sign-in. Refresh the tokens or reconnect.",
    );
  });
});
