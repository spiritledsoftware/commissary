// Token refresh through the ControlPlane Durable Object: alarm arming, alarm-driven refresh, request-time refresh RPC,
// cron sweep (the Worker's scheduled handler runs it: apps/app/test/scheduled.test.ts). Upstream endpoints are mocked by replacing `fetch` (the DO runs in the test isolate).
import { FULL_ACCESS } from "../src/credentials/ownership.ts";
import { env } from "cloudflare:test";
import { runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

const plane = (name: string = crypto.randomUUID()) => env.CONTROL_PLANE.getByName(name);

const HOUR = 3_600_000;

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

const claudeFile = (extra: Record<string, unknown> = {}) => ({
  type: "claude",
  email: "me@x.com",
  access_token: "sk-ant-oat-old",
  refresh_token: "rt-1",
  expired: iso(Date.now() + 10 * HOUR),
  ...extra,
});

// Effect's FetchHttpClient resolves `globalThis.fetch` once and keeps it, so a per-test `vi.spyOn` would be ignored
// after the first test. Install one stable fetch for the whole file that delegates to the current test's handler.
type UpstreamHandler = (url: string, body: string) => Response | Promise<Response>;

let currentUpstream: UpstreamHandler = () =>
  new Response("no upstream configured", { status: 500 });

const realFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const body =
      init?.body instanceof Uint8Array
        ? new TextDecoder().decode(init.body)
        : typeof init?.body === "string"
          ? init.body
          : "";

    return currentUpstream(input instanceof Request ? input.url : String(input), body);
  };
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

const mockUpstream = (handler?: UpstreamHandler) => {
  const requests: { url: string; body: string }[] = [];
  let issued = 1;
  currentUpstream = (url, body) => {
    requests.push({ url, body });

    if (handler !== undefined) return handler(url, body);

    if (url.includes("platform.claude.com")) {
      issued += 1;

      return Response.json({
        access_token: `sk-ant-oat-${issued}`,
        refresh_token: `rt-${issued}`,
        expires_in: 28800,
      });
    }

    return new Response("unexpected", { status: 500 });
  };

  return { requests };
};

const alarmOf = (stub: ReturnType<typeof plane>) =>
  runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());

describe("ControlPlane token refresh", () => {
  it("arms the single alarm at the earliest refresh deadline and clears it when credentials go away", async () => {
    const stub = plane();
    const far = iso(Date.now() + 20 * HOUR);
    const near = iso(Date.now() + 8 * HOUR);
    await stub
      .models()
      .importAuthFile("claude-a.json", claudeFile({ expired: far }), {}, FULL_ACCESS);
    await stub
      .models()
      .importAuthFile("claude-b.json", claudeFile({ expired: near }), {}, FULL_ACCESS);
    await stub.models().importAuthFile(
      "vertex-a.json",
      {
        type: "vertex",
        project_id: "p",
        service_account: {},
      },
      {},
      FULL_ACCESS,
    );
    expect(await alarmOf(stub)).toBe(Date.parse(near) - 4 * HOUR);

    await stub.models().removeCredential("claude-b.json", FULL_ACCESS);
    expect(await alarmOf(stub)).toBe(Date.parse(far) - 4 * HOUR);
    await stub.models().setCredentialDisabled("claude-a.json", true, FULL_ACCESS); // disabled credentials are still refreshed (Go)
    expect(await alarmOf(stub)).toBe(Date.parse(far) - 4 * HOUR);
    await stub.models().removeCredential("claude-a.json", FULL_ACCESS);
    expect(await alarmOf(stub)).toBeNull();
  });

  it("refreshes due credentials in the alarm handler and persists the rotated tokens", async () => {
    const upstream = mockUpstream();
    const stub = plane();
    // Inside the 4 h lead: due immediately. workerd also fires the armed alarm on its own; the manager's per-credential
    // dedupe makes the explicit call below and the automatic run share one upstream refresh.
    await stub
      .models()
      .importAuthFile(
        "claude-a.json",
        claudeFile({ expired: iso(Date.now() + HOUR) }),
        {},
        FULL_ACCESS,
      );
    await runInDurableObject(stub, (instance) => instance.alarm());

    const calls = upstream.requests.filter((request) =>
      request.url.includes("platform.claude.com"),
    );

    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "rt-1",
    });
    const picked = await stub.models().pick({ providers: ["claude"], model: "claude-sonnet-4-5" });
    expect(picked.ok && picked.credential.metadata).toMatchObject({
      access_token: "sk-ant-oat-2",
      refresh_token: "rt-2",
    });
    // re-armed for the new expiry (8 h) minus the 4 h lead
    const next = await alarmOf(stub);
    expect(next).toBeGreaterThan(Date.now() + 3 * HOUR);
    expect(next).toBeLessThan(Date.now() + 4 * HOUR + 60_000);
  });

  it("refreshNow recovers from a 401 once for concurrent callers and survives an eviction", async () => {
    const upstream = mockUpstream();
    const stub = plane();
    await stub.models().importAuthFile("claude-a.json", claudeFile(), {}, FULL_ACCESS);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => stub.models().refreshNow("claude-a.json", "sk-ant-oat-old")),
    );

    expect(
      upstream.requests.filter((request) => request.url.includes("platform.claude.com")),
    ).toHaveLength(1);

    for (const result of results) {
      expect(result.ok && result.credential.metadata).toMatchObject({
        access_token: "sk-ant-oat-2",
      });
    }

    const list = await stub.models().listCredentials(FULL_ACCESS);
    expect(JSON.stringify(list)).not.toContain("sk-ant-oat-2");
    expect(list[0]).toMatchObject({ credentialVersion: 2, status: "active" });

    const late = await stub.models().refreshNow("claude-a.json", "sk-ant-oat-old");
    expect(late).toMatchObject({ ok: true, refreshed: false });
    expect(
      upstream.requests.filter((request) => request.url.includes("platform.claude.com")),
    ).toHaveLength(1);
  });

  it("reports refresh failures as structured results with back-off state", async () => {
    mockUpstream(() => new Response('{"error":"invalid_grant"}', { status: 400 }));
    const stub = plane();
    await stub.models().importAuthFile("claude-a.json", claudeFile(), {}, FULL_ACCESS);
    const result = await stub.models().refreshNow("claude-a.json");
    expect(result).toMatchObject({ ok: false, error: { code: "refresh_failed", httpStatus: 400 } });
    // the access token is still valid, so the credential keeps serving
    expect((await stub.models().listCredentials(FULL_ACCESS))[0]).toMatchObject({
      status: "active",
      unavailable: false,
      lastError: { httpStatus: 400 },
    });
    expect(JSON.stringify(result)).not.toContain("rt-1");
    expect(await stub.models().refreshNow("nope.json")).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });

  it("the cron sweep re-arms a lost alarm", async () => {
    mockUpstream();
    const stub = plane();
    await stub
      .models()
      .importAuthFile(
        "claude-a.json",
        claudeFile({ expired: iso(Date.now() + 10 * HOUR) }),
        {},
        FULL_ACCESS,
      );
    await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());
    expect(await alarmOf(stub)).toBeNull();
    await stub.models().sweepRefresh();
    expect(await alarmOf(stub)).not.toBeNull();
  });

  it("patchCredentialMetadata merges settings but never token material", async () => {
    const stub = plane();
    await stub.models().importAuthFile("claude-a.json", claudeFile({ note: "x" }), {}, FULL_ACCESS);
    expect(
      await stub
        .models()
        .patchCredentialMetadata("claude-a.json", { project_id: "p1", note: null }),
    ).toEqual({ ok: true });
    expect(
      await stub.models().patchCredentialMetadata("claude-a.json", { access_token: "x" }),
    ).toEqual({
      ok: false,
      error: "forbidden_key",
    });
    expect(await stub.models().patchCredentialMetadata("nope.json", {})).toEqual({
      ok: false,
      error: "not_found",
    });
    const picked = await stub.models().pick({ providers: ["claude"], model: "claude-sonnet-4-5" });
    expect(picked.ok && picked.credential.metadata).toMatchObject({
      project_id: "p1",
      refresh_token: "rt-1",
    });
    expect(picked.ok && picked.credential.metadata).not.toHaveProperty("note");
    expect(picked.ok && picked.credential.credentialVersion).toBe(1);
  });
});
