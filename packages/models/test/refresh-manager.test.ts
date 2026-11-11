// RefreshManager: alarm multiplexing, dedupe, rotation persistence, 401 recovery, back-off, merge semantics,
// request-time preparation (Meta, Vertex, Antigravity) — against a real CredentialPool and a recording HttpClient.
import { beforeAll, describe, expect, it } from "vitest";
import type { JsonObject } from "@commissary/json";
import type { RefreshResult } from "../src/credentials/refresh/index.ts";
import type { PickResult } from "../src/credentials/selection/types.ts";
import {
  makeFixture,
  T0,
  type Fixture,
  type MockHandler,
  type MockReply,
} from "./support/refresh.ts";
import { makeServiceAccount, type TestServiceAccount } from "./support/vertex.ts";

const MIN = 60_000;

const HOUR = 60 * MIN;

const iso = (ms: number) => new Date(ms).toISOString();

const CLAUDE_TOKEN = "https://platform.claude.com/v1/oauth/token";

const CLAUDE_PROFILE = "https://api.anthropic.com/api/oauth/profile";

const claudeFile = (extra: JsonObject = {}): JsonObject => ({
  type: "claude",
  email: "me@x.com",
  access_token: "at-1",
  refresh_token: "rt-1",
  expired: iso(T0 + HOUR),
  ...extra,
});

/** Claude token endpoint that rotates `rt-N` -> `rt-(N+1)` and answers the profile with 403 (identity kept). */
const claudeServer = (log: string[] = []): MockHandler => {
  let issued = 1;

  return (request) => {
    if (request.url === CLAUDE_PROFILE) return { status: 403, body: "no" };
    expect(request.url).toBe(CLAUDE_TOKEN);
    const refreshToken = String(request.json().refresh_token);
    log.push(refreshToken);
    issued += 1;

    return {
      body: { access_token: `at-${issued}`, refresh_token: `rt-${issued}`, expires_in: 8 * 3600 },
    };
  };
};

const ok = (result: RefreshResult) => {
  if (!result.ok)
    throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`);

  return result;
};

const bad = (result: RefreshResult) => {
  if (result.ok) throw new Error("expected failure");

  return result;
};

const stored = (fixture: Fixture, id: string) => fixture.store.get(id)?.metadata ?? {};

const tokenCalls = (fixture: Fixture) =>
  fixture.http.requests.filter((request) => request.url === CLAUDE_TOKEN);

/** A promise that can be resolved from outside: lets a test hold an upstream call open. */
const gate = () => {
  let open!: () => void;

  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });

  return { promise, open };
};

describe("alarm multiplexing", () => {
  it("arms one alarm at the earliest due time across credentials and ignores non-refreshable ones", async () => {
    const fixture = makeFixture(claudeServer());
    fixture.add("claude-a.json", claudeFile({ expired: iso(T0 + 10 * HOUR) })); // due T0+6h
    fixture.add("claude-b.json", claudeFile({ expired: iso(T0 + 6 * HOUR) })); // due T0+2h
    fixture.add("codex-a.json", {
      type: "codex",
      access_token: "a",
      refresh_token: "r",
      expired: iso(T0 + 96 * HOUR + 6 * HOUR), // due T0+6h (96 h lead)
    });
    fixture.add("vertex-a.json", { type: "vertex", service_account: {}, project_id: "p" }); // no lead
    fixture.add("claude-noreftoken.json", {
      type: "claude",
      access_token: "x",
      expired: iso(T0 - HOUR),
    });

    expect(await fixture.manager.rearm()).toBe(T0 + 2 * HOUR);
    expect(fixture.alarm.at).toBe(T0 + 2 * HOUR);

    fixture.add("antigravity-a.json", {
      type: "antigravity",
      access_token: "a",
      refresh_token: "r",
      expired: iso(T0 + 45 * MIN), // due T0+15min
    });
    expect(await fixture.manager.rearm()).toBe(T0 + 15 * MIN);
  });

  it("clears the alarm when nothing needs refreshing and arms immediately for overdue credentials", async () => {
    const fixture = makeFixture(claudeServer());
    fixture.add("vertex-a.json", { type: "vertex", service_account: {} });
    fixture.alarm.at = 123;
    expect(await fixture.manager.rearm()).toBeUndefined();
    expect(fixture.alarm.at).toBeUndefined();

    fixture.add("claude-a.json", claudeFile({ expired: iso(T0 - MIN) }));
    expect(await fixture.manager.rearm()).toBe(T0);
    expect(await fixture.manager.rearm(30_000)).toBe(T0 + 30_000);
  });

  it("an alarm run refreshes only the due credentials and re-arms for the next deadline", async () => {
    const log: string[] = [];
    const fixture = makeFixture(claudeServer(log));
    fixture.add(
      "claude-due.json",
      claudeFile({ refresh_token: "rt-due", expired: iso(T0 + 3 * HOUR) }),
    ); // due since T0-1h
    fixture.add(
      "claude-later.json",
      claudeFile({ refresh_token: "rt-later", expired: iso(T0 + 9 * HOUR) }),
    );

    const summary = await fixture.manager.onAlarm();
    expect(summary).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    expect(log).toEqual(["rt-due"]);
    expect(stored(fixture, "claude-due.json")).toMatchObject({
      access_token: "at-2",
      refresh_token: "rt-2",
      expired: iso(T0 + 8 * HOUR).replace(".000Z", "Z"),
    });
    // due: min(refreshed: T0+8h-4h, later: T0+9h-4h) = T0+4h
    expect(fixture.alarm.at).toBe(T0 + 4 * HOUR);

    fixture.clock.now = T0 + 5 * HOUR;
    expect(await fixture.manager.onAlarm()).toEqual({ attempted: 2, succeeded: 2, failed: 0 });
    expect(log).toEqual(["rt-due", "rt-2", "rt-later"]);
  });

  it("bounds concurrency by the configured worker count", async () => {
    let running = 0;
    let peak = 0;
    const release = gate();

    const fixture = makeFixture(
      async (request) => {
        if (request.url === CLAUDE_PROFILE) return { status: 403 };
        running += 1;
        peak = Math.max(peak, running);
        await release.promise;
        running -= 1;

        return { body: { access_token: "n", refresh_token: "r2", expires_in: 8 * 3600 } };
      },
      { workers: () => 2 },
    );

    for (let i = 0; i < 5; i++)
      fixture.add(`claude-${i}.json`, claudeFile({ expired: iso(T0 + HOUR) }));
    const run = fixture.manager.runDue();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(peak).toBe(2);
    release.open();
    expect(await run).toEqual({ attempted: 5, succeeded: 5, failed: 0 });
    expect(peak).toBe(2);
  });
});

describe("concurrent refresh dedupe", () => {
  it("shares one upstream refresh between the alarm, request-time 401s and management", async () => {
    const release = gate();
    const log: string[] = [];
    const inner = claudeServer(log);

    const fixture = makeFixture(async (request) => {
      if (request.url === CLAUDE_TOKEN) await release.promise;

      return inner(request);
    });

    fixture.add("claude-a.json", claudeFile({ expired: iso(T0 + HOUR) }));

    const callers = [
      fixture.manager.runDue(),
      ...Array.from({ length: 8 }, () =>
        fixture.manager.refreshNow("claude-a.json", { rejectedAccessToken: "at-1" }),
      ),
      fixture.manager.refreshNow("claude-a.json"),
    ];

    await new Promise((resolve) => setTimeout(resolve, 10));
    release.open();
    const results = await Promise.all(callers);

    expect(log).toEqual(["rt-1"]);
    expect(tokenCalls(fixture)).toHaveLength(1);
    const refreshes = results.slice(1) as RefreshResult[];

    for (const result of refreshes) {
      expect(ok(result).credential.metadata).toMatchObject({
        access_token: "at-2",
        refresh_token: "rt-2",
      });
    }

    expect(fixture.store.get("claude-a.json")?.credentialVersion).toBe(2);
  });

  it("does not refresh again for a 401 on a token that was already replaced", async () => {
    const fixture = makeFixture(claudeServer());
    fixture.add("claude-a.json", claudeFile());
    ok(await fixture.manager.refreshNow("claude-a.json", { rejectedAccessToken: "at-1" }));
    expect(tokenCalls(fixture)).toHaveLength(1);

    const late = ok(
      await fixture.manager.refreshNow("claude-a.json", { rejectedAccessToken: "at-1" }),
    );

    expect(late.refreshed).toBe(false);
    expect(late.credential.metadata).toMatchObject({ access_token: "at-2" });
    expect(tokenCalls(fixture)).toHaveLength(1);

    // a 401 on the NEW token refreshes again with the rotated refresh token
    ok(await fixture.manager.refreshNow("claude-a.json", { rejectedAccessToken: "at-2" }));
    expect(tokenCalls(fixture).map((request) => request.json().refresh_token)).toEqual([
      "rt-1",
      "rt-2",
    ]);
  });
});

describe("persistence and merge", () => {
  it("persists the rotated refresh token before the result is visible and uses it next time", async () => {
    const fixture = makeFixture(claudeServer());
    fixture.add("claude-a.json", claudeFile());
    const result = ok(await fixture.manager.refreshNow("claude-a.json"));
    expect(result.refreshed).toBe(true);
    expect(stored(fixture, "claude-a.json")).toMatchObject({
      access_token: "at-2",
      refresh_token: "rt-2",
    });
    expect(result.credential.credentialVersion).toBe(2);
    expect(JSON.stringify(result)).toContain("rt-2"); // executors need the token; management redacts elsewhere
    ok(await fixture.manager.refreshNow("claude-a.json"));
    expect(tokenCalls(fixture).map((request) => request.json().refresh_token)).toEqual([
      "rt-1",
      "rt-2",
    ]);
  });

  it("keeps user edits made while the refresh was in flight (three-way merge)", async () => {
    const release = gate();
    const inner = claudeServer();

    const fixture = makeFixture(async (request) => {
      if (request.url === CLAUDE_TOKEN) await release.promise;

      return inner(request);
    });

    fixture.add("claude-a.json", claudeFile({ prefix: "old" }));
    const pending = fixture.manager.refreshNow("claude-a.json");
    await new Promise((resolve) => setTimeout(resolve, 10));
    // user edits priority/prefix and disables the credential meanwhile
    const meta = stored(fixture, "claude-a.json");
    fixture.pool.commitRefresh("claude-a.json", {
      metadata: { ...meta, prefix: "team", priority: 7, disabled: true },
    });
    release.open();
    ok(await pending);
    expect(stored(fixture, "claude-a.json")).toMatchObject({
      access_token: "at-2",
      refresh_token: "rt-2",
      prefix: "team",
      priority: 7,
      disabled: true,
    });
  });

  it("discards a refresh result when the credential was replaced by a re-login meanwhile", async () => {
    const release = gate();
    const inner = claudeServer();

    const fixture = makeFixture(async (request) => {
      if (request.url === CLAUDE_TOKEN) await release.promise;

      return inner(request);
    });

    fixture.add("claude-a.json", claudeFile());
    const pending = fixture.manager.refreshNow("claude-a.json");
    await new Promise((resolve) => setTimeout(resolve, 10));
    fixture.pool.upsert(
      "claude-a.json",
      claudeFile({ access_token: "fresh-login", refresh_token: "rt-login" }),
      {
        mergeExisting: true,
      },
    );
    release.open();
    const result = ok(await pending);
    expect(result.refreshed).toBe(false);
    expect(stored(fixture, "claude-a.json")).toMatchObject({
      access_token: "fresh-login",
      refresh_token: "rt-login",
    });
  });

  it("reports a credential removed during the refresh", async () => {
    const release = gate();
    const inner = claudeServer();

    const fixture = makeFixture(async (request) => {
      if (request.url === CLAUDE_TOKEN) await release.promise;

      return inner(request);
    });

    fixture.add("claude-a.json", claudeFile());
    const pending = fixture.manager.refreshNow("claude-a.json");
    await new Promise((resolve) => setTimeout(resolve, 10));
    fixture.pool.remove("claude-a.json");
    release.open();
    expect(bad(await pending).error.code).toBe("not_found");
    expect(bad(await fixture.manager.refreshNow("missing.json")).error.code).toBe("not_found");
  });
});

const failing =
  (reply: MockReply): MockHandler =>
  (request) =>
    request.url === CLAUDE_PROFILE ? { status: 403 } : reply;

describe("failure back-off", () => {
  it("an expired token with a transient failure becomes unavailable and is retried after 5 minutes", async () => {
    const fixture = makeFixture(failing({ status: 500, body: "boom" }));
    fixture.add("claude-a.json", claudeFile({ expired: iso(T0 - MIN) }));
    const result = bad(await fixture.manager.refreshNow("claude-a.json"));
    expect(result.error).toMatchObject({ code: "refresh_failed", httpStatus: 500 });
    expect(result.terminal).toBe(false);
    const target = fixture.pool.refreshTarget("claude-a.json");
    expect(target?.state).toMatchObject({
      status: "error",
      unavailable: true,
      nextRefreshAfter: T0 + 5 * MIN,
    });
    expect(fixture.alarm.at).toBe(T0 + 5 * MIN);
    // persisted: survives a restart
    expect(fixture.store.states.get("claude-a.json")?.nextRefreshAfter).toBe(T0 + 5 * MIN);

    // nothing is due before the back-off ends; afterwards the alarm retries
    fixture.clock.now = T0 + 4 * MIN;
    expect((await fixture.manager.runDue()).attempted).toBe(0);
    fixture.clock.now = T0 + 5 * MIN;
    expect((await fixture.manager.runDue()).attempted).toBe(1);
  });

  it("invalid_grant backs off exponentially and a success clears the state", async () => {
    let grant = true;
    const inner = claudeServer();

    const fixture = makeFixture((request) =>
      grant && request.url === CLAUDE_TOKEN
        ? { status: 400, body: '{"error":"invalid_grant"}' }
        : inner(request),
    );

    fixture.add("claude-a.json", claudeFile({ expired: iso(T0 - MIN) }));
    const delays: number[] = [];

    for (let i = 0; i < 3; i++) {
      await fixture.manager.refreshNow("claude-a.json");
      const next = fixture.pool.refreshTarget("claude-a.json")?.state.nextRefreshAfter ?? 0;
      delays.push((next - fixture.clock.now) / MIN);
      fixture.clock.now = next;
    }

    expect(delays).toEqual([1, 2, 4]);
    expect(fixture.pool.refreshTarget("claude-a.json")?.state).toMatchObject({
      refreshFailures: 3,
      statusMessage: "invalid grant (retrying)",
    });

    grant = false;
    ok(await fixture.manager.refreshNow("claude-a.json"));
    expect(fixture.pool.refreshTarget("claude-a.json")?.state).toMatchObject({
      status: "active",
      unavailable: false,
      refreshFailures: 0,
      nextRefreshAfter: 0,
    });
  });

  it("a rejected token whose refresh token is invalid is terminal until a new login", async () => {
    const fixture = makeFixture(failing({ status: 400, body: '{"error":"invalid_grant"}' }));
    fixture.add("claude-a.json", claudeFile()); // token still valid per `expired`

    const result = bad(
      await fixture.manager.refreshNow("claude-a.json", { rejectedAccessToken: "at-1" }),
    );

    expect(result.terminal).toBe(true);
    expect(result.error.code).toBe("unauthorized");
    expect(fixture.pool.refreshTarget("claude-a.json")?.state).toMatchObject({
      unavailable: true,
      nextRefreshAfter: 0,
      statusMessage: "unauthorized (refresh token invalid)",
    });
    expect(fixture.alarm.at).toBeUndefined();
    // no more upstream calls while terminal, unless forced
    const calls = fixture.http.requests.length;
    expect(bad(await fixture.manager.refreshNow("claude-a.json")).error.code).toBe("unauthorized");
    expect(fixture.http.requests.length).toBe(calls);
    expect(bad(await fixture.manager.refreshNow("claude-a.json", { force: true })).terminal).toBe(
      true,
    );
    // a re-login replaces the material and the state
    fixture.pool.upsert(
      "claude-a.json",
      claudeFile({ access_token: "new", refresh_token: "new-rt" }),
      {
        mergeExisting: true,
      },
    );
    expect(fixture.pool.refreshTarget("claude-a.json")?.state.unavailable).toBe(false);
  });

  it("remembers a rejected token that has no expiry of its own until a refresh replaces it", async () => {
    let failNow = true;
    const inner = claudeServer();

    const fixture = makeFixture((request) =>
      failNow && request.url === CLAUDE_TOKEN ? { status: 500, body: "boom" } : inner(request),
    );

    fixture.add("claude-a.json", {
      type: "claude",
      access_token: "no-expiry",
      refresh_token: "rt-1",
    });
    bad(await fixture.manager.refreshNow("claude-a.json", { rejectedAccessToken: "no-expiry" }));
    expect(fixture.pool.refreshTarget("claude-a.json")?.state).toMatchObject({
      rejectedAccessToken: "no-expiry",
      unavailable: true,
      nextRefreshAfter: T0 + 5 * MIN,
    });
    expect(fixture.store.states.get("claude-a.json")?.rejectedAccessToken).toBe("no-expiry");

    failNow = false;
    fixture.clock.now = T0 + 5 * MIN;
    expect((await fixture.manager.runDue()).succeeded).toBe(1);
    expect(fixture.pool.refreshTarget("claude-a.json")?.state.rejectedAccessToken).toBeUndefined();
  });

  it("a valid token keeps serving after a failed proactive refresh", async () => {
    const fixture = makeFixture(failing({ status: 502, body: "bad gateway" }));
    fixture.add("claude-a.json", claudeFile({ expired: iso(T0 + 3 * HOUR) })); // inside the 4 h lead, still valid
    bad(await fixture.manager.refreshNow("claude-a.json"));
    expect(fixture.pool.refreshTarget("claude-a.json")?.state).toMatchObject({
      unavailable: false,
      status: "active",
      nextRefreshAfter: T0 + 5 * MIN,
    });
  });

  it("Claude 429 blocks the refresh token for Retry-After without calling upstream", async () => {
    const inner = claudeServer();
    let throttled = true;

    const fixture = makeFixture((request) =>
      throttled && request.url === CLAUDE_TOKEN
        ? { status: 429, body: "slow", headers: { "retry-after": "30" } }
        : inner(request),
    );

    fixture.add("claude-a.json", claudeFile({ expired: iso(T0 - MIN) }));
    bad(await fixture.manager.refreshNow("claude-a.json"));
    expect(tokenCalls(fixture)).toHaveLength(1);
    fixture.clock.now = T0 + 10_000;
    expect(bad(await fixture.manager.refreshNow("claude-a.json")).error.httpStatus).toBe(429);
    expect(tokenCalls(fixture)).toHaveLength(1);
    throttled = false;
    fixture.clock.now = T0 + 31_000;
    ok(await fixture.manager.refreshNow("claude-a.json"));
    expect(tokenCalls(fixture)).toHaveLength(2);
  });

  it("never refreshes again within 30 s when a refresh leaves the credential due (ineffective refresh)", async () => {
    const fixture = makeFixture((request) =>
      request.url.includes("auth.openai.com")
        ? { body: { access_token: "n", refresh_token: "r2", expires_in: 60 } }
        : {},
    );

    fixture.add("codex-a.json", {
      type: "codex",
      access_token: "a",
      refresh_token: "r",
      expired: iso(T0 + HOUR),
    });
    ok(await fixture.manager.refreshNow("codex-a.json"));
    expect(fixture.pool.refreshTarget("codex-a.json")?.state.nextRefreshAfter).toBe(T0 + 30_000);
    expect(fixture.alarm.at).toBe(T0 + 30_000);
  });

  it("rejects credentials that cannot be refreshed", async () => {
    const fixture = makeFixture(claudeServer());
    fixture.add("claude-a.json", { type: "claude", access_token: "x" });
    fixture.add("vertex-a.json", { type: "vertex", refresh_token: "r" });
    expect(bad(await fixture.manager.refreshNow("claude-a.json")).error.code).toBe(
      "not_refreshable",
    );
    expect(bad(await fixture.manager.refreshNow("vertex-a.json")).error.code).toBe(
      "not_refreshable",
    );
    expect(fixture.http.requests).toHaveLength(0);
  });
});

describe("ensureFresh (request-time preparation)", () => {
  it("returns a still valid credential untouched and refreshes expired or missing tokens", async () => {
    const fixture = makeFixture(claudeServer());
    fixture.add("claude-a.json", claudeFile({ expired: iso(T0 + HOUR) }));
    fixture.add("claude-b.json", claudeFile({ expired: iso(T0 - MIN), refresh_token: "rt-b" }));
    fixture.add("claude-c.json", { type: "claude", refresh_token: "rt-c" });
    expect(ok(await fixture.manager.ensureFresh("claude-a.json")).refreshed).toBe(false);
    expect(fixture.http.requests).toHaveLength(0);
    expect(
      ok(await fixture.manager.ensureFresh("claude-b.json")).credential.metadata.access_token,
    ).toBe("at-2");
    expect(ok(await fixture.manager.ensureFresh("claude-c.json")).refreshed).toBe(true);
  });

  it("refreshes Antigravity tokens within its 5 minute request safety window", async () => {
    const fixture = makeFixture(() => ({ body: { access_token: "ag-2", expires_in: 3600 } }));
    fixture.add("antigravity-a.json", {
      type: "antigravity",
      access_token: "ag-1",
      refresh_token: "r",
      expired: iso(T0 + 4 * MIN),
    });
    fixture.add("antigravity-b.json", {
      type: "antigravity",
      access_token: "ag-1",
      refresh_token: "r",
      expired: iso(T0 + 10 * MIN),
    });
    expect(
      ok(await fixture.manager.ensureFresh("antigravity-a.json")).credential.metadata.access_token,
    ).toBe("ag-2");
    expect(ok(await fixture.manager.ensureFresh("antigravity-b.json")).refreshed).toBe(false);
  });

  it("mints a Meta provider key from the DCA token, persisted before use, and re-mints after a 401", async () => {
    let minted = 0;

    const fixture = makeFixture(() => {
      minted += 1;

      return { body: { api_key: `meta-key-${minted}`, user_email: "me@meta.com" } };
    });

    fixture.add("meta-a.json", {
      type: "meta",
      auth_kind: "oauth",
      dca_token: "dca:abc",
      access_token: "dca:abc",
    });
    expect(fixture.manager.nextDueAt()).toBeUndefined(); // never scheduled
    const first = ok(await fixture.manager.ensureFresh("meta-a.json"));
    expect(first.credential.metadata).toMatchObject({
      api_key: "meta-key-1",
      access_token: "meta-key-1",
    });
    expect(stored(fixture, "meta-a.json")).toMatchObject({
      api_key: "meta-key-1",
      dca_token: "dca:abc",
    });
    expect(ok(await fixture.manager.ensureFresh("meta-a.json")).refreshed).toBe(false);
    expect(minted).toBe(1);

    const again = ok(
      await fixture.manager.refreshNow("meta-a.json", { rejectedAccessToken: "meta-key-1" }),
    );

    expect(again.credential.metadata).toMatchObject({ api_key: "meta-key-2" });
  });
});

describe("vertex access tokens", () => {
  let sa: TestServiceAccount;
  beforeAll(async () => {
    sa = await makeServiceAccount();
  });
  const TOKEN_URI = "https://oauth2.googleapis.com/token";

  const vertexFixture = (counter: { n: number }) => {
    const fixture = makeFixture(async (request) => {
      expect(request.url).toBe(TOKEN_URI);
      counter.n += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));

      return { body: { access_token: `ya29.${counter.n}`, expires_in: 3600 } };
    });

    fixture.add("vertex-a.json", {
      type: "vertex",
      project_id: "proj-1",
      email: "sa@proj-1.iam.gserviceaccount.com",
      service_account: sa.account(sa.pem.pkcs1),
    });

    return fixture;
  };

  it("mints once for concurrent callers, caches until exp - 60 s, then mints again", async () => {
    const counter = { n: 0 };
    const fixture = vertexFixture(counter);

    const results = await Promise.all(
      Array.from({ length: 6 }, () => fixture.manager.ensureFresh("vertex-a.json")),
    );

    expect(counter.n).toBe(1);

    for (const result of results) {
      expect(ok(result).credential.metadata).toMatchObject({ access_token: "ya29.1" });
    }

    // not persisted in the auth file
    expect(stored(fixture, "vertex-a.json")).not.toHaveProperty("access_token");

    fixture.clock.now = T0 + HOUR - 61_000;
    expect(
      ok(await fixture.manager.ensureFresh("vertex-a.json")).credential.metadata.access_token,
    ).toBe("ya29.1");
    expect(counter.n).toBe(1);
    fixture.clock.now = T0 + HOUR - 60_000;
    expect(
      ok(await fixture.manager.ensureFresh("vertex-a.json")).credential.metadata.access_token,
    ).toBe("ya29.2");
    expect(counter.n).toBe(2);
  });

  it("exposes a valid cached token through the pick snapshot and re-mints when the credential changes", async () => {
    const counter = { n: 0 };
    const fixture = vertexFixture(counter);

    const pickToken = () => {
      const result: PickResult = fixture.pool.pick({
        providers: ["vertex"],
        model: "gemini-2.5-pro",
      });

      if (!result.ok) throw new Error(result.failure.code);

      return result.credential.metadata;
    };

    expect(pickToken()).not.toHaveProperty("access_token"); // nothing minted yet: executor calls ensureFresh
    ok(await fixture.manager.ensureFresh("vertex-a.json"));
    expect(pickToken()).toMatchObject({ access_token: "ya29.1" });

    fixture.clock.now += 5;
    fixture.pool.commitRefresh("vertex-a.json", {
      metadata: { ...stored(fixture, "vertex-a.json"), location: "europe-west4" },
    });
    expect(pickToken()).not.toHaveProperty("access_token");
    expect(
      ok(await fixture.manager.ensureFresh("vertex-a.json")).credential.metadata.access_token,
    ).toBe("ya29.2");
  });

  it("reports mint failures without touching credential state", async () => {
    const fixture = makeFixture(() => ({ status: 400, body: '{"error":"invalid_grant"}' }));
    fixture.add("vertex-a.json", { type: "vertex", service_account: sa.account(sa.pem.pkcs8) });
    const result = bad(await fixture.manager.ensureFresh("vertex-a.json"));
    expect(result.error).toMatchObject({ code: "refresh_failed", httpStatus: 400 });
    expect(fixture.pool.refreshTarget("vertex-a.json")?.state.unavailable).toBe(false);
  });
});
