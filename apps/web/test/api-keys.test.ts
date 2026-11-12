import { describe, expect, it } from "vite-plus/test";
import type { ApiKeyView } from "@commissary/contract/api-keys";
import {
  canRevoke,
  createdText,
  expiresText,
  expiryIso,
  expiryProblem,
  filterKeys,
  KEY_HEADERS,
  KEY_NAME_MAX,
  KEYS_PER_MEMBER,
  keyNameProblem,
  keyProblem,
  keyStatus,
  lastUsedText,
  memberName,
  notMemberNote,
  revokedText,
  showMemberColumn,
  sortKeys,
  statusLabel,
  todayInput,
} from "../src/lib/api-keys.ts";

const NOW = Date.parse("2026-10-13T12:00:00Z");

const view = (id: string, overrides: Partial<ApiKeyView> = {}): ApiKeyView => ({
  id,
  name: `key ${id}`,
  prefix: `cms_org_${id}_abcd`,
  member_id: "m1",
  mine: true,
  created_at: "2026-10-10T00:00:00Z",
  ...overrides,
});

describe("keyStatus", () => {
  it("is active until it expires or is revoked", () => {
    expect(keyStatus(view("a"), NOW)).toBe("active");
    expect(keyStatus(view("a", { expires_at: "2026-10-14T00:00:00Z" }), NOW)).toBe("active");
    expect(keyStatus(view("a", { expires_at: "2026-10-12T00:00:00Z" }), NOW)).toBe("expired");
    expect(keyStatus(view("a", { revoked_at: "2026-10-11T00:00:00Z" }), NOW)).toBe("revoked");
  });

  it("expires at its instant, as the server reads it", () => {
    const key = view("a", { expires_at: "2026-10-13T12:00:00Z" });

    expect(keyStatus(key, NOW - 1)).toBe("active");
    expect(keyStatus(key, NOW)).toBe("expired");
  });

  it("calls a key revoked even when it has also expired", () => {
    const key = view("a", {
      expires_at: "2026-10-12T00:00:00Z",
      revoked_at: "2026-10-11T00:00:00Z",
    });

    expect(keyStatus(key, NOW)).toBe("revoked");
  });

  it("reads an unparseable expiry as none rather than expiring the key", () => {
    expect(keyStatus(view("a", { expires_at: "soon" }), NOW)).toBe("active");
  });

  it("has a label for each status and revokes only keys that still work", () => {
    expect(statusLabel("active")).toBe("Active");
    expect(statusLabel("expired")).toBe("Expired");
    expect(statusLabel("revoked")).toBe("Revoked");
    expect(canRevoke(view("a"), NOW)).toBe(true);
    expect(canRevoke(view("a", { expires_at: "2026-10-12T00:00:00Z" }), NOW)).toBe(true);
    expect(canRevoke(view("a", { revoked_at: "2026-10-11T00:00:00Z" }), NOW)).toBe(false);
  });
});

describe("sortKeys and filterKeys", () => {
  const keys = [
    view("old", { created_at: "2026-10-01T00:00:00Z" }),
    view("revoked", { created_at: "2026-10-12T00:00:00Z", revoked_at: "2026-10-12T01:00:00Z" }),
    view("expired", { created_at: "2026-10-05T00:00:00Z", expires_at: "2026-10-06T00:00:00Z" }),
    view("new", { created_at: "2026-10-11T00:00:00Z" }),
  ];

  it("puts working keys first, then expired, then revoked, each newest first", () => {
    expect(sortKeys(keys, NOW).map((key) => key.id)).toEqual(["new", "old", "expired", "revoked"]);
  });

  it("breaks a tie by id and leaves its input alone", () => {
    const tied = [view("b"), view("a")];

    expect(sortKeys(tied, NOW).map((key) => key.id)).toEqual(["a", "b"]);
    expect(tied.map((key) => key.id)).toEqual(["b", "a"]);
  });

  it("filters to the keys that work, or keeps all", () => {
    expect(filterKeys(keys, "active", NOW).map((key) => key.id)).toEqual(["old", "new"]);
    expect(filterKeys(keys, "all", NOW)).toHaveLength(4);
  });
});

describe("columns", () => {
  it("shows the member column to org admins and whenever a key is someone else's", () => {
    expect(showMemberColumn([view("a")], false)).toBe(false);
    expect(showMemberColumn([view("a"), view("b", { mine: false })], false)).toBe(true);
    expect(showMemberColumn([], true)).toBe(true);
  });

  it("names the member by email, by id without one", () => {
    expect(memberName(view("a", { member_email: "ada@example.com" }))).toBe("ada@example.com");
    expect(memberName(view("a"))).toBe("m1");
  });

  it("says never for a key not used yet and how long ago otherwise", () => {
    expect(lastUsedText(view("a"), NOW)).toBe("Never");
    expect(lastUsedText(view("a", { last_used_at: "2026-10-13T11:59:30Z" }), NOW)).toBe("just now");
    expect(lastUsedText(view("a", { last_used_at: "2026-10-13T09:00:00Z" }), NOW)).toBe("3 h ago");
    expect(lastUsedText(view("a", { last_used_at: "2026-10-09T12:00:00Z" }), NOW)).toBe("4 d ago");
    // A clock a little behind the server's never prints a negative time.
    expect(lastUsedText(view("a", { last_used_at: "2026-10-13T12:00:05Z" }), NOW)).toBe("just now");
  });

  it("prints dates, no expiry, and the day a key was revoked", () => {
    expect(createdText(view("a", { created_at: "2026-10-10T12:00:00Z" }))).toBe("Oct 10, 2026");
    expect(expiresText(view("a"))).toBe("No expiry");
    expect(expiresText(view("a", { expires_at: "2026-12-31T12:00:00Z" }))).toBe("Dec 31, 2026");
    expect(revokedText(view("a"))).toBeUndefined();
    expect(revokedText(view("a", { revoked_at: "2026-10-11T12:00:00Z" }))).toBe("Oct 11, 2026");
  });
});

describe("keyNameProblem", () => {
  it("wants a name of 1 to 100 characters without control characters", () => {
    expect(keyNameProblem("laptop")).toBeUndefined();
    expect(keyNameProblem("  laptop  ")).toBeUndefined();
    expect(keyNameProblem("")).toMatch(/Name the key/);
    expect(keyNameProblem("   ")).toMatch(/Name the key/);
    expect(keyNameProblem("a".repeat(KEY_NAME_MAX))).toBeUndefined();
    expect(keyNameProblem("a".repeat(KEY_NAME_MAX + 1))).toMatch(/up to 100/);
    expect(keyNameProblem("bad\nname")).toMatch(/control/);
  });

  it("counts code points, as the server does", () => {
    expect(keyNameProblem("🦀".repeat(KEY_NAME_MAX))).toBeUndefined();
    expect(keyNameProblem("🦀".repeat(KEY_NAME_MAX + 1))).toMatch(/up to 100/);
  });
});

// The browser's own time zone: the expectations build their dates the way the page does.
const localEnd = (year: number, month: number, day: number) =>
  new Date(year, month - 1, day, 23, 59, 59, 999);

describe("expiry", () => {
  const now = new Date(2026, 9, 13, 12, 0, 0).getTime();

  it("treats an empty day as no expiry", () => {
    expect(expiryProblem("", now)).toBeUndefined();
    expect(expiryProblem("  ", now)).toBeUndefined();
    expect(expiryIso("", now)).toBeUndefined();
  });

  it("sends the end of the chosen day as ISO time", () => {
    expect(expiryProblem("2026-12-31", now)).toBeUndefined();
    expect(expiryIso("2026-12-31", now)).toBe(localEnd(2026, 12, 31).toISOString());
  });

  it("accepts today, whose day has not ended, and refuses a day that has passed", () => {
    expect(expiryProblem("2026-10-13", now)).toBeUndefined();
    expect(expiryIso("2026-10-13", now)).toBe(localEnd(2026, 10, 13).toISOString());
    expect(expiryProblem("2026-10-12", now)).toMatch(/has passed/);
    expect(expiryIso("2026-10-12", now)).toBeUndefined();
  });

  it("refuses what is not a day", () => {
    expect(expiryProblem("tomorrow", now)).toMatch(/Pick a date/);
    expect(expiryProblem("2026-02-31", now)).toMatch(/Pick a date/);
    expect(expiryProblem("2026-13-01", now)).toMatch(/Pick a date/);
    expect(expiryIso("2026-02-31", now)).toBeUndefined();
  });

  it("gives the date input today's day as its minimum", () => {
    expect(todayInput(now)).toBe("2026-10-13");
    expect(todayInput(new Date(2026, 0, 5, 0, 0, 1).getTime())).toBe("2026-01-05");
  });
});

describe("keyProblem", () => {
  it("explains the server's codes", () => {
    expect(keyProblem("member_required", "x")).toMatch(/not one/);
    expect(keyProblem("member_required", "x")).toMatch(/Members page/);
    expect(keyProblem("invalid_name", "x")).toMatch(/1 to 100 characters/);
    expect(keyProblem("invalid_expiry", "x")).toMatch(/future/);
    expect(keyProblem("too_many_keys", "x")).toContain(String(KEYS_PER_MEMBER));
    expect(keyProblem("api_key_not_found", "x")).toMatch(/no longer exists/);
  });

  it("falls back to the server's explanation, then to the message", () => {
    expect(keyProblem("something_new", "fallback")).toBe("fallback");
    expect(keyProblem(undefined, "fallback", "the reason")).toBe("The reason.");
  });

  it("closes the form to a caller with no role in the org, with the member_required advice", () => {
    expect(notMemberNote({ role: null })).toBe(keyProblem("member_required", ""));
    expect(notMemberNote({ role: "member" })).toBeUndefined();
    expect(notMemberNote({ role: "owner" })).toBeUndefined();
  });
});

describe("how a key is sent", () => {
  it("lists the bearer, Claude and Gemini ways", () => {
    const sends = KEY_HEADERS.map((row) => row.send).join("\n");

    expect(sends).toContain("Authorization: Bearer");
    expect(sends).toContain("x-api-key");
    expect(sends).toContain("x-goog-api-key");
    expect(sends).toContain("?key=");
  });
});
