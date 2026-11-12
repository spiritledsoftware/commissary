// Sign-in on the auth host (ADR 0026, ADR 0030, src/http/sign-in-routes.ts): Better Auth's GitHub flow through the
// auth Worker, started from the sign-in page on the app host, Turnstile in front of it, only verified emails, session
// cookies scoped to the base domain and read under their name only, sign-out, and nothing else of Better Auth's API
// reachable.
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { stateAuthDirectory } from "@commissary/state";
import { BASE_COOKIE_PREFIX } from "../../../infra/settings.ts";
import { signedInPerson } from "../src/sign-in/sessions.ts";
import {
  AUTH_ORIGIN,
  call,
  clearPeople,
  cookiesOf,
  finishSignIn,
  fromApp,
  GOOD_TURNSTILE,
  OTHER_SITE_TURNSTILE,
  installFakes,
  APP_ORIGIN,
  restoreFetch,
  SESSION_COOKIE,
  signIn,
  startSignIn,
  upstreams,
} from "./support.ts";

beforeAll(installFakes);

afterAll(restoreFetch);

beforeEach(async () => {
  await clearPeople();
  upstreams.person = { email: "ada@example.com" };
  upstreams.turnstileDown = false;
  upstreams.siteverify = [];
  upstreams.unexpected = [];
});

const session = async (cookie: string) => {
  const response = await call("/api/auth/get-session", { headers: { cookie } });
  expect(response.status).toBe(200);

  // Better Auth answers `get-session` with the session and its user, or `null`.
  return await response.json<{ user: { email: string; emailVerified: boolean } } | null>();
};

describe("sign-in options", () => {
  it("lists the enabled providers and the Turnstile site key", async () => {
    const response = await call("/api/sign-in-options");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      providers: ["github", "google"],
      turnstile_site_key: env.TURNSTILE_SITE_KEY,
    });
  });
});

describe("sign-in with GitHub", () => {
  it("signs a person in with their verified email and a Secure, HttpOnly, SameSite=Lax session cookie", async () => {
    const start = await startSignIn();
    expect(start.status).toBe(200);
    expect(upstreams.siteverify).toEqual([
      { secret: env.TURNSTILE_SECRET_KEY, response: GOOD_TURNSTILE },
    ]);

    const callback = await finishSignIn(start);
    expect(callback.status).toBe(302);
    // Back to the panel, on the app host.
    expect(callback.headers.get("location")).toBe(`${APP_ORIGIN}/`);

    const cookie = callback.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${SESSION_COOKIE}=`));

    expect(cookie).toBeDefined();
    // Scoped to the base domain, so the app host under it receives it and hands it back over the RPC; named apart
    // (`AUTH_COOKIE_PREFIX`) because the base domain is above the app host.
    expect(cookie).toMatch(/;\s*Domain=\.?commissary\.test(;|$)/i);
    expect(cookie).toMatch(/;\s*Secure/i);
    expect(cookie).toMatch(/;\s*HttpOnly/i);
    expect(cookie).toMatch(/;\s*SameSite=Lax/i);

    expect((await session(cookiesOf(callback)))?.user).toMatchObject({
      email: "ada@example.com",
      emailVerified: true,
    });
  });

  it("keeps neither the provider's tokens nor the browser's address or user agent", async () => {
    await signIn({ email: "ada@example.com" });

    const account = await env.SIGN_IN.prepare(
      'SELECT "accessToken", "refreshToken", "idToken" FROM "account"',
    ).first();

    expect(account).toEqual({ accessToken: null, refreshToken: null, idToken: null });

    const stored = await env.SIGN_IN.prepare(
      'SELECT "ipAddress", "userAgent" FROM "session"',
    ).first();

    expect(stored).toEqual({ ipAddress: null, userAgent: null });
  });

  it("refuses an email the provider has not verified, a platform admin's too", async () => {
    // root@example.com is in the test Worker's PLATFORM_ADMIN_EMAILS.
    for (const email of ["eve@example.com", "root@example.com"]) {
      upstreams.person = { email, verified: false };
      const callback = await finishSignIn(await startSignIn());

      expect(callback.status).toBe(302);
      expect(callback.headers.get("location")).toContain(
        `${APP_ORIGIN}/sign-in?error=email_not_verified`,
      );
      expect(cookiesOf(callback)).not.toContain("session_token");
    }

    const people = await env.SIGN_IN.prepare('SELECT count(*) AS n FROM "user"').first<{
      n: number;
    }>();

    expect(people?.n).toBe(0);
  });

  it("sign-out ends the session and clears its cookie, under the same name and domain", async () => {
    const cookie = await signIn({ email: "ada@example.com" });
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(await session(cookie)).not.toBeNull();

    const out = await call("/api/auth/sign-out", {
      method: "POST",
      headers: fromApp({ cookie }),
      body: "{}",
    });

    expect(out.status).toBe(200);

    const cleared = out.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${SESSION_COOKIE}=`));

    expect(cleared).toBeDefined();
    expect(cleared?.split(";")[0]).toBe(`${SESSION_COOKIE}=`);
    expect(cleared).toMatch(/;\s*Domain=\.?commissary\.test(;|$)/i);
    expect(cleared).toMatch(/;\s*Max-Age=0(;|$)/i);

    expect(await session(cookie)).toBeNull();
  });
});

/** The session cookie's value, which Better Auth signs alone: valid under any name. */
const tokenOf = (cookie: string): string =>
  cookie
    .split("; ")
    .find((pair) => pair.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1) ?? "";

/** Who the session in `cookie` belongs to, read by a Better Auth whose cookie prefix is `prefix`. */
const personFor = async (prefix: string, cookie: string) =>
  await signedInPerson(
    { ...env, AUTH_COOKIE_PREFIX: prefix },
    stateAuthDirectory(env),
    AUTH_ORIGIN,
    cookie,
  );

describe("the session cookie's name", () => {
  it("is read under AUTH_COOKIE_PREFIX alone, so a renamed cookie is not shadowed by one of the old name (ADR 0031)", async () => {
    const token = tokenOf(await signIn({ email: "ada@example.com" }));
    expect(token).not.toBe("");

    // A browser sends the older of two cookies of one name first, and Better Auth reads the first: a cookie scoped to
    // the old domain shadows the new one.
    expect(
      await personFor(
        "",
        `__Secure-better-auth.session_token=stale; __Secure-better-auth.session_token=${token}`,
      ),
    ).toBeUndefined();

    // Renamed with its scope, the cookie of the old name is ignored: the person is signed out once, then signs in.
    expect(
      await personFor(BASE_COOKIE_PREFIX, `__Secure-better-auth.session_token=${token}`),
    ).toBeUndefined();
    expect(
      await personFor(
        BASE_COOKIE_PREFIX,
        `__Secure-better-auth.session_token=stale; ${SESSION_COOKIE}=${token}`,
      ),
    ).toMatchObject({ email: "ada@example.com" });
  });
});

describe("Turnstile", () => {
  it("blocks a sign-in (and so a sign-up) without a valid token", async () => {
    for (const token of [null, "", "forged", OTHER_SITE_TURNSTILE]) {
      const start = await startSignIn(token);

      expect(start.status).toBe(403);
      expect(await start.json()).toEqual({ error: "turnstile_failed" });
    }

    // A missing token never reaches siteverify.
    expect(upstreams.siteverify.map((body) => body["response"])).toEqual([
      "forged",
      OTHER_SITE_TURNSTILE,
    ]);
  });

  it("blocks a sign-in while siteverify is unreachable", async () => {
    upstreams.turnstileDown = true;
    const start = await startSignIn();

    expect(start.status).toBe(503);
  });
});

describe("cross-site requests", () => {
  it("refuses a sign-in or sign-out started by another site", async () => {
    for (const [path, headers] of [
      ["/api/auth/sign-in/social", { origin: "https://evil.test" }],
      ["/api/auth/sign-in/social", { "sec-fetch-site": "cross-site" }],
      ["/api/auth/sign-in/social", { origin: APP_ORIGIN, "sec-fetch-site": "cross-site" }],
      ["/api/auth/sign-in/social", { "sec-fetch-site": "same-site" }],
      ["/api/auth/sign-out", { origin: "https://evil.test" }],
    ] as const) {
      const response = await call(path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-captcha-response": GOOD_TURNSTILE,
          ...headers,
        },
        body: JSON.stringify({ provider: "github", callbackURL: "/" }),
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Cross-site request rejected" });
    }

    expect(upstreams.siteverify).toEqual([]);
  });
});

describe("the rest of Better Auth's API", () => {
  it("answers 404 like an unknown path, naming the app host", async () => {
    for (const [method, path] of [
      ["POST", "/api/auth/sign-up/email"],
      ["POST", "/api/auth/sign-in/email"],
      ["GET", "/api/auth/list-sessions"],
      ["POST", "/api/auth/update-user"],
      ["POST", "/api/auth/link-social"],
      ["GET", "/api/auth/error"],
      ["GET", "/api/auth/callback/github/extra"],
    ] as const) {
      const response = await call(path, {
        method,
        headers: { origin: APP_ORIGIN, "content-type": "application/json" },
        ...(method === "POST" ? { body: "{}" } : {}),
      });

      expect(response.status, `${method} ${path}`).toBe(404);
      expect(await response.json()).toEqual({
        error: `Not found: this host serves sign-in only; the control panel is at ${APP_ORIGIN}`,
      });
    }
  });
});
