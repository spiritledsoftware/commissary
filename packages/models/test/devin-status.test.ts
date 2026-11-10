// Devin GetUserStatus quota/profile refresh against the real Go DevinExecutor.Refresh
// (`go run ./tools/fixturegen/devinstatus`), the cron wiring and the catalog/EOF guards of the executor.
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { applyDevinStatus, refreshDevinStatuses } from "../src/credentials/devin-status.ts";
import type { Credential, CredentialState } from "../src/credentials/model.ts";
import { emptyState } from "../src/credentials/model.ts";
import type { JsonObject } from "@commissary/json";
import { parseUserStatus } from "../src/oauth/flows/devin-status.ts";
import { scheduledTasks } from "../src/scheduled-tasks.ts";
import { recordingClient, type RecordedCall } from "./support/executor-run.ts";
import { makePool, MemoryPoolStore } from "./support/pool.ts";
import fixtures from "./fixtures/devin-status.json";

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));

const toHex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const credential = (seed: string, extra: Partial<Credential> = {}): Credential =>
  ({
    id: "devin-1",
    provider: "devin",
    source: "file",
    disabled: false,
    attributes: {
      api_key: "devin-session-token$abc",
      base_url: "https://stub.test",
      device_seed: seed,
    },
    metadata: { api_key: "devin-session-token$abc", old: "kept" },
    ...extra,
  }) as unknown as Credential;

interface Commit {
  readonly id: string;
  readonly metadata?: JsonObject;
  readonly state?: CredentialState;
}

const refresh = async (entries: Credential[], status: number, body: Uint8Array) => {
  const calls: RecordedCall[] = [];
  const commits: Commit[] = [];

  const pool = {
    entries: () => entries.map((c) => ({ credential: c, state: emptyState() })),
    commitRefresh: (id: string, change: Omit<Commit, "id">) => {
      commits.push({ id, ...change });

      return undefined;
    },
  };

  const summary = await Effect.runPromise(
    refreshDevinStatuses(pool as never, () => 1_700_000_000_000).pipe(
      Effect.provide(recordingClient(calls, () => new Response(body as BodyInit, { status }))),
    ),
  );

  return { summary, calls, commits };
};

describe("Devin GetUserStatus refresh (Go parity)", () => {
  for (const scenario of fixtures.scenarios) {
    it(scenario.name, async () => {
      const { summary, calls, commits } = await refresh(
        [credential(scenario.seed)],
        scenario.httpStatus,
        fromHex(scenario.response),
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(
        "https://stub.test/exa.seat_management_pb.SeatManagementService/GetUserStatus",
      );
      expect(calls[0]?.headers["authorization"]).toBe(
        "Basic devin-session-token$abc-devin-session-token$abc",
      );
      expect(calls[0]?.headers["connect-protocol-version"]).toBe("1");
      expect(calls[0]?.headers["content-type"]).toContain("application/proto");

      if (scenario.error) {
        expect(summary).toEqual({ refreshed: 0, failed: 1, skipped: 0 });
        expect(commits).toEqual([]);

        return;
      }

      expect(summary).toEqual({ refreshed: 1, failed: 0, skipped: 0 });
      const [commit] = commits;
      const { last_refresh: stamped, ...metadata } = commit?.metadata ?? {};
      expect(stamped).toBe("2023-11-14T22:13:20Z");
      expect(metadata).toEqual(scenario.metadata);
      expect(commit?.state?.quota.signals).toEqual(scenario.signals);
      expect(commit?.state?.quota.observedAt).toBe(1_700_000_000_000);
    });
  }

  it("builds the same request body as Go for a seeded device fingerprint", async () => {
    const { calls } = await refresh(
      [credential("seed-1")],
      200,
      fromHex(fixtures.scenarios[0]?.response ?? ""),
    );

    expect(toHex(calls[0]?.bytes ?? new Uint8Array())).toBe(fixtures.deterministicRequest);
  });

  it("parses every field Go reads and ignores malformed tails", () => {
    const status = parseUserStatus(fromHex(fixtures.scenarios[0]?.response ?? ""));
    expect(status).toMatchObject({
      email: "ada@example.com",
      teamId: "team_9",
      orgName: "Acme Inc",
      dailyQuotaRemainingPercent: 87,
      weeklyQuotaResetAt: 1700604800,
      planEnd: 1702592000,
    });
  });

  it("skips disabled, config and non-Devin credentials and ones without a token", async () => {
    const { summary, calls } = await refresh(
      [
        credential("", { disabled: true }),
        credential("", { id: "cfg", source: "config" }),
        credential("", { id: "other", provider: "codex" }),
        credential("", { id: "none", attributes: {}, metadata: {} }),
      ],
      200,
      fromHex(fixtures.scenarios[0]?.response ?? ""),
    );

    expect(summary).toEqual({ refreshed: 0, failed: 0, skipped: 1 });
    expect(calls).toHaveLength(0);
  });

  it("keeps previous quota signals not reported again", () => {
    const state: CredentialState = {
      ...emptyState(),
      quota: { ...emptyState().quota, signals: { stale: "x", plan: "Old" } },
    };

    const next = applyDevinStatus(
      {},
      state,
      parseUserStatus(fromHex(fixtures.scenarios[1]?.response ?? ""))!,
      5,
    );

    expect(next.state.quota.signals).toMatchObject({
      stale: "x",
      plan: "Free",
      daily_quota_remaining_percent: "100%",
    });
  });

  it("hands a Devin credential's observed quota signals to the executor with the pick", async () => {
    const store = new MemoryPoolStore();

    for (const name of ["devin-a", "devin-b"]) {
      store.upsert(`${name}.json`, "devin", {
        type: "devin",
        api_key: `devin-session-token$${name}`,
        email: `${name}@example.com`,
      });
    }

    // Only `devin-a` was refreshed by the status cron.
    store.states.set("devin-a.json", {
      ...emptyState(),
      quota: {
        ...emptyState().quota,
        signals: { weekly_quota_reset_at: "2026-11-12T00:00:00Z" },
      },
    });

    const harness = await makePool("requests: {}", { store });
    const picked = new Map<string, Record<string, string> | undefined>();
    const tried: string[] = [];

    for (let attempt = 0; attempt < 2; attempt++) {
      const result = harness.pool.pick({ providers: ["devin"], model: "swe-2", tried });

      if (!result.ok) throw new Error(`pick failed: ${result.failure.code}`);
      tried.push(result.credential.id);
      picked.set(result.credential.id, result.credential.quotaSignals);
    }

    expect(picked.get("devin-a.json")).toEqual({ weekly_quota_reset_at: "2026-11-12T00:00:00Z" });
    expect(picked.get("devin-b.json")).toBeUndefined();
  });

  it("is scheduled as a cron task", () => {
    expect(scheduledTasks.map((task) => task.name)).toContain("devin-user-status");
  });
});
