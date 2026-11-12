// OAuth building blocks: session store rules (memory and Durable Object SQLite), names, encoding, Devin protobuf.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import {
  base64Url,
  encodeQuery,
  generatePkce,
  generateState,
  queryEscape,
  randomBytes,
  sha256,
} from "../src/oauth/encoding.ts";
import { buildUserStatusRequest, parseUserStatus } from "../src/oauth/flows/devin-status.ts";
import { isValidOAuthState, normalizeCallbackProvider } from "../src/oauth/names.ts";
import {
  COMPLETED_TTL_MS,
  MemorySessionTable,
  OAuthSessions,
  SESSION_TTL_MS,
  SqliteSessionTable,
} from "../src/oauth/session-store.ts";

const T0 = 1_800_000_000_000;

/** `withSessions` runs the body where the table is usable (inside the Durable Object for SQLite). */
type WithSessions = <T>(body: (sessions: OAuthSessions) => T) => Promise<T>;

const sessionRules = (withSessions: WithSessions) => {
  const register = (sessions: OAuthSessions, state = "s1", now = T0) =>
    sessions.register(
      {
        state,
        provider: "anthropic",
        flow: "callback",
        deadlineAt: now + 300_000,
        data: { secret: "v" },
      },
      now,
    );

  it("registers pending sessions that expire after 30 minutes", () =>
    withSessions((sessions) => {
      register(sessions);
      expect(sessions.get("s1", T0)).toMatchObject({
        status: "",
        completed: false,
        provider: "anthropic",
        data: { secret: "v" },
      });
      expect(sessions.isPending("s1", T0 + SESSION_TTL_MS - 1)).toBe(true);
      expect(sessions.isPending("s1", T0, "anthropic")).toBe(true);
      expect(sessions.isPending("s1", T0, "codex")).toBe(false);
      expect(sessions.get("s1", T0 + SESSION_TTL_MS)).toBeUndefined();
      expect(sessions.isPending("unknown", T0)).toBe(false);
    }));

  it("setError records the message, wipes the secrets, extends the TTL and ignores unknown/completed sessions", () =>
    withSessions((sessions) => {
      register(sessions);
      sessions.setError("s1", "  boom ", T0 + 1000);
      expect(sessions.get("s1", T0 + 1000)).toMatchObject({
        status: "boom",
        data: {},
        expiresAt: T0 + 1000 + SESSION_TTL_MS,
      });
      expect(sessions.isPending("s1", T0 + 1000)).toBe(false);
      sessions.setError("s1", "", T0 + 2000);
      expect(sessions.get("s1", T0 + 2000)?.status).toBe("Authentication failed");
      sessions.setError("missing", "x", T0);
      expect(sessions.get("missing", T0)).toBeUndefined();

      register(sessions, "done");
      sessions.complete("done", T0);
      sessions.setError("done", "late", T0);
      expect(sessions.get("done", T0)).toMatchObject({ completed: true, status: "" });
    }));

  it("completed sessions are kept for one minute only", () =>
    withSessions((sessions) => {
      register(sessions);
      sessions.complete("s1", T0);
      expect(sessions.get("s1", T0 + COMPLETED_TTL_MS - 1)).toMatchObject({
        completed: true,
        data: {},
      });
      expect(sessions.get("s1", T0 + COMPLETED_TTL_MS)).toBeUndefined();
    }));

  it("cancel removes only pending sessions", () =>
    withSessions((sessions) => {
      register(sessions, "pending");
      register(sessions, "failed");
      register(sessions, "done");
      sessions.setError("failed", "x", T0);
      sessions.complete("done", T0);
      expect(sessions.cancel("pending", T0)).toBe(true);
      expect(sessions.cancel("pending", T0)).toBe(false);
      expect(sessions.cancel("failed", T0)).toBe(false);
      expect(sessions.cancel("done", T0)).toBe(false);
      expect(sessions.cancel("unknown", T0)).toBe(false);
    }));

  it("re-registering a state overwrites it; the busy lease admits one holder and survives an interrupted holder", () =>
    withSessions((sessions) => {
      register(sessions);
      expect(sessions.acquire("s1", T0)).toBe(true);
      expect(sessions.acquire("s1", T0 + 1)).toBe(false);
      sessions.release("s1", T0 + 2, { nextPollAt: T0 + 10, intervalMs: 7000 });
      expect(sessions.get("s1", T0 + 2)).toMatchObject({
        busyUntil: 0,
        nextPollAt: T0 + 10,
        intervalMs: 7000,
      });
      expect(sessions.acquire("s1", T0 + 3)).toBe(true);
      // A holder that never released (interrupted request) stops blocking after the lease.
      expect(sessions.acquire("s1", T0 + 3 + 2 * 60_000)).toBe(true);
      expect(sessions.acquire("missing", T0)).toBe(false);

      sessions.setError("s1", "x", T0);
      register(sessions);
      expect(sessions.get("s1", T0)).toMatchObject({ status: "", busyUntil: 0 });
    }));
};

describe("OAuthSessions over a Map", () =>
  sessionRules((body) => Promise.resolve(body(new OAuthSessions(new MemorySessionTable())))));

describe("OAuthSessions over Durable Object SQLite", () =>
  // One Durable Object per test; the table is created by the store, like in the ControlPlane.
  sessionRules((body) =>
    runInDurableObject(
      env.CONTROL_PLANE.getByName(`oauth-units-${crypto.randomUUID()}`),
      (_instance, state) => body(new OAuthSessions(new SqliteSessionTable(state.storage.sql))),
    ),
  ));

describe("state and provider names", () => {
  it("validates states like ValidateOAuthState", () => {
    for (const ok of ["a".repeat(32), "xai-1700000000000-ab12cd34", "kmi-ai-1.2_3"])
      expect(isValidOAuthState(ok), ok).toBe(true);

    for (const bad of ["", "  ", "a/b", "a\\b", "a..b", "a b", "ä", "a".repeat(129)])
      expect(isValidOAuthState(bad), bad).toBe(false);
  });

  it("normalises callback providers like NormalizeOAuthProvider (Kimi has no callback)", () => {
    expect(normalizeCallbackProvider(" Claude ")).toBe("anthropic");
    expect(normalizeCallbackProvider("OpenAI")).toBe("codex");
    expect(normalizeCallbackProvider("anti-gravity")).toBe("antigravity");
    expect(normalizeCallbackProvider("x.ai")).toBe("xai");
    expect(normalizeCallbackProvider("cognition")).toBe("devin");
    expect(normalizeCallbackProvider("muse")).toBe("meta");
    expect(normalizeCallbackProvider("kimi")).toBeUndefined();
    expect(normalizeCallbackProvider("")).toBeUndefined();
  });
});

describe("encoding", () => {
  it("encodes queries like Go's url.Values.Encode", () => {
    expect(queryEscape("a b~*'()!:/")).toBe("a+b~%2A%27%28%29%21%3A%2F");
    expect(encodeQuery({ z: "1", a: "x y", m: "" })).toBe("a=x+y&m=&z=1");
  });

  it("generates PKCE pairs, hex states and url-safe base64", async () => {
    const pkce = await generatePkce(96);
    expect(pkce.codeVerifier).toMatch(/^[A-Za-z0-9_-]{128}$/);
    expect(pkce.codeChallenge).toBe(base64Url(await sha256(pkce.codeVerifier)));
    expect((await generatePkce(64)).codeVerifier).toHaveLength(86);
    expect(generateState()).toMatch(/^[0-9a-f]{32}$/);
    expect(generateState()).not.toBe(generateState());
    expect(base64Url(Uint8Array.from([251, 255, 254]))).toBe("-__-");
    expect(randomBytes(8)).toHaveLength(8);
    // RFC 7636 appendix B.
    expect(base64Url(await sha256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});

describe("devin GetUserStatus protobuf", () => {
  const varint = (n: number): number[] => (n < 128 ? [n] : [(n & 0x7f) | 0x80, ...varint(n >> 7)]);

  const field = (num: number, bytes: ArrayLike<number>): number[] => [
    ...varint(num * 8 + 2),
    ...varint(bytes.length),
    ...Array.from(bytes),
  ];

  const text = (num: number, value: string): number[] =>
    field(num, new TextEncoder().encode(value));

  it("builds the request with the Go field layout", () => {
    const bytes = buildUserStatusRequest("devin-session-token$abc");
    const decoded = new TextDecoder().decode(bytes);
    expect(bytes[0]).toBe(0x0a); // field 1, length-delimited
    expect(decoded).toContain("chisel");
    expect(decoded).toContain("3000.10.21");
    expect(decoded).toContain("devin-session-token$abc");
    // 732 hex characters of device fingerprint.
    expect(decoded).toMatch(/[0-9a-f]{732}/);
  });

  it("parses e-mail, plan and ids, skipping unknown and varint fields", () => {
    const org = text(4, "org-9");
    const planInfo = [...text(2, "Pro Plan"), ...field(33, org)];
    const planStatus = [...field(1, planInfo), ...varint(14 * 8), 90];

    const userStatus = [
      ...text(3, "dev"),
      ...text(7, "dev@x.com"),
      ...field(13, planStatus),
      ...text(36, "user-1"),
      ...varint(40 * 8),
      1,
    ];

    const response = Uint8Array.from([...field(1, userStatus), ...varint(9 * 8), 5]);
    expect(parseUserStatus(response)).toMatchObject({
      userName: "dev",
      email: "dev@x.com",
      userId: "user-1",
      orgId: "org-9",
      plan: "Pro Plan",
      dailyQuotaRemainingPercent: 90,
    });
    expect(parseUserStatus(new Uint8Array())).toBeUndefined();
    // Truncated input yields what was readable instead of throwing.
    expect(parseUserStatus(response.subarray(0, 8))).toMatchObject({ email: "" });
  });
});
