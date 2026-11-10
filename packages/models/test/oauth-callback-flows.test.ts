// Authorization-code logins (Claude, Codex, Antigravity, Devin): start, pasted-callback completion, credential shape.
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import { asString, type JsonObject } from "@commissary/json";
import { CALLBACK_WINDOW_MS } from "../src/oauth/service.ts";
import { SESSION_TTL_MS } from "../src/oauth/session-store.ts";
import {
  begin,
  iso,
  jwt,
  makeOAuth,
  onlyFile,
  query,
  routes,
  s256,
  startClock,
  statusOf,
  T0,
} from "./support/oauth.ts";

const CLAUDE_TOKEN = "POST https://platform.claude.com/v1/oauth/token";

const CLAUDE_PROFILE = "GET https://api.anthropic.com/api/oauth/profile";

const CLAUDE_ROLES = "GET https://api.anthropic.com/api/oauth/claude_cli/roles";

const claudeUpstream = (overrides: Record<string, unknown> = {}) =>
  routes({
    [CLAUDE_TOKEN]: {
      body: {
        access_token: "sk-ant-oat-access",
        refresh_token: "sk-ant-ort-refresh",
        expires_in: 28800,
        token_type: "Bearer",
        organization: { uuid: "org-from-token", name: "Token Org" },
        account: { uuid: "acc-from-token", email_address: "token@x.com" },
        ...overrides,
      },
    },
    [CLAUDE_PROFILE]: {
      body: {
        account: { uuid: "acc-uuid-1", email: "me@x.com" },
        organization: { uuid: "org-uuid-1", name: "My Org" },
      },
    },
    [CLAUDE_ROLES]: { body: { roles: [] } },
  });

describe("claude login", () => {
  it.effect("builds the Go authorization URL and stores a session secret server-side", () =>
    Effect.gen(function* () {
      yield* startClock;
      const h = makeOAuth(claudeUpstream());
      const started = yield* begin(h, "claude");
      assert.isUndefined(started.flow);
      const parts = query(started.url);
      // `url.Values.Encode` order and `+` for spaces.
      expect(Object.keys(parts)).toEqual([
        "client_id",
        "code",
        "code_challenge",
        "code_challenge_method",
        "redirect_uri",
        "response_type",
        "scope",
        "state",
      ]);
      expect(
        started.url.startsWith(
          "https://claude.ai/oauth/authorize?client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&code=true",
        ),
      ).toBe(true);
      expect(started.url).toContain(
        "scope=user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code",
      );
      expect(parts).toMatchObject({
        code: "true",
        code_challenge_method: "S256",
        redirect_uri: "http://localhost:54545/callback",
        response_type: "code",
        state: started.state,
      });
      expect(started.state).toMatch(/^[0-9a-f]{32}$/);

      const session = h.table.get(started.state);
      const verifier = asString(session?.data.code_verifier);
      expect(verifier).toHaveLength(128);
      expect(parts.code_challenge).toBe(yield* Effect.promise(() => s256(verifier)));
      // The verifier is never part of the response.
      expect(JSON.stringify(started)).not.toContain(verifier);
      assert.deepStrictEqual(yield* statusOf(h, started.state), { status: "wait" });
    }),
  );

  it.effect("exchanges the pasted code, enriches from the profile and writes the Go file", () =>
    Effect.gen(function* () {
      yield* startClock;
      const h = makeOAuth(claudeUpstream());
      const started = yield* begin(h, "claude");
      const verifier = asString(h.table.get(started.state)?.data.code_verifier);

      const result = yield* h.run(
        h.service.callback({
          provider: "claude",
          state: started.state,
          code: "the-code#ignored-fragment",
          error: "",
        }),
      );

      assert.deepStrictEqual(result, { ok: true, outcome: "completed" });
      assert.deepStrictEqual(yield* statusOf(h, started.state), { status: "ok" });

      const [exchange, profile, roles] = h.requests;
      expect(exchange?.json()).toEqual({
        grant_type: "authorization_code",
        code: "the-code",
        redirect_uri: "http://localhost:54545/callback",
        client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
        code_verifier: verifier,
        state: started.state,
      });
      // Key order of the body is the order Claude Code sends.
      expect(Object.keys(exchange?.json() ?? {})).toEqual([
        "grant_type",
        "code",
        "redirect_uri",
        "client_id",
        "code_verifier",
        "state",
      ]);
      expect(profile?.headers.authorization).toBe("Bearer sk-ant-oat-access");
      expect(roles?.url).toBe("https://api.anthropic.com/api/oauth/claude_cli/roles");

      const { name, file } = onlyFile(h);
      // sha256("org-uuid-1")[:8 hex] from the profile (it wins over the token response identity).
      expect(name).toBe("claude-4a1c555d-me@x.com.json");
      expect(file).toMatchObject({
        id_token: "",
        access_token: "sk-ant-oat-access",
        refresh_token: "sk-ant-ort-refresh",
        last_refresh: iso(T0),
        email: "me@x.com",
        account_uuid: "acc-uuid-1",
        organization_uuid: "org-uuid-1",
        organization_name: "My Org",
        type: "claude",
        expired: iso(T0 + 28800_000),
        disabled: false,
      });
      expect(file.claude_device_ids).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);
      // The session secrets are gone once the login ended.
      expect(h.table.get(started.state)?.data).toEqual({});
    }),
  );

  it.effect(
    "merges the previous file of a re-login and migrates the legacy email-named credential",
    () =>
      Effect.gen(function* () {
        yield* startClock;

        const legacy: JsonObject = {
          type: "claude",
          email: "me@x.com",
          account_uuid: "acc-uuid-1",
          organization_uuid: "org-uuid-1",
          access_token: "old-access",
          refresh_token: "old-refresh",
          expired: "2020-01-01T00:00:00Z",
          priority: 7,
          prefix: "team",
          note: "keep me",
        };

        const sameName: JsonObject = {
          type: "claude",
          access_token: "older",
          disabled: true,
          weight: 3,
        };

        const h = makeOAuth(claudeUpstream(), {
          "claude-me@x.com.json": legacy,
          "claude-4a1c555d-me@x.com.json": sameName,
        });

        const started = yield* begin(h, "claude");
        yield* h.run(h.service.callback({ state: started.state, code: "c", error: "" }));

        expect(h.removed).toEqual(["claude-me@x.com.json"]);
        const file = h.files.get("claude-4a1c555d-me@x.com.json");
        expect(file).toMatchObject({
          access_token: "sk-ant-oat-access",
          priority: 7,
          prefix: "team",
          note: "keep me",
          weight: 3,
          // A disabled credential stays disabled across a re-login.
          disabled: true,
        });
        expect(file?.refresh_token).toBe("sk-ant-ort-refresh");
      }),
  );

  it.effect(
    "migrates an account-hashed predecessor, but not an email-named file of another organization",
    () =>
      Effect.gen(function* () {
        yield* startClock;

        const base = {
          type: "claude",
          email: "me@x.com",
          account_uuid: "acc-uuid-1",
          access_token: "old",
          priority: 9,
        };

        const predecessor = makeOAuth(claudeUpstream(), { "claude-a586ca04-me@x.com.json": base });
        const first = yield* begin(predecessor, "claude");
        yield* predecessor.run(
          predecessor.service.callback({ state: first.state, code: "c", error: "" }),
        );
        expect(predecessor.removed).toEqual(["claude-a586ca04-me@x.com.json"]);
        expect(predecessor.files.get("claude-4a1c555d-me@x.com.json")?.priority).toBe(9);

        const other = makeOAuth(claudeUpstream(), {
          "claude-me@x.com.json": { ...base, organization_uuid: "another-org" },
        });

        const second = yield* begin(other, "claude");
        yield* other.run(other.service.callback({ state: second.state, code: "c", error: "" }));
        expect(other.removed).toEqual([]);
        expect([...other.files.keys()].toSorted()).toEqual([
          "claude-4a1c555d-me@x.com.json",
          "claude-me@x.com.json",
        ]);
      }),
  );

  it.effect("keeps the token-response identity when the profile call fails", () =>
    Effect.gen(function* () {
      yield* startClock;

      const h = makeOAuth(
        routes({
          [CLAUDE_TOKEN]: {
            body: {
              access_token: "at",
              refresh_token: "rt",
              expires_in: 60,
              account: { uuid: "acc-from-token", email_address: "token@x.com" },
            },
          },
          [CLAUDE_PROFILE]: { status: 403 },
          [CLAUDE_ROLES]: { transportError: true },
        }),
      );

      const started = yield* begin(h, "claude");
      yield* h.run(h.service.callback({ state: started.state, code: "c", error: "" }));
      const { name, file } = onlyFile(h);
      expect(name).toMatch(/^claude-[0-9a-f]{8}-token@x\.com\.json$/);
      expect(file).toMatchObject({ email: "token@x.com", account_uuid: "acc-from-token" });
      expect(file).not.toHaveProperty("organization_uuid");
    }),
  );

  it.effect("reports token endpoint errors without saving or leaking details", () =>
    Effect.gen(function* () {
      yield* startClock;

      const h = makeOAuth(
        routes({
          [CLAUDE_TOKEN]: { status: 400, body: { error: "invalid_grant", secret: "s3cr3t-body" } },
        }),
      );

      const started = yield* begin(h, "claude");

      const result = yield* h.run(
        h.service.callback({ state: started.state, code: "bad-code", error: "" }),
      );

      // Like Go: the callback is accepted, the failure shows in the status.
      assert.deepStrictEqual(result, { ok: true, outcome: "failed" });
      const status = yield* statusOf(h, started.state);
      assert.deepStrictEqual(status, {
        status: "error",
        error: "Failed to exchange authorization code for tokens",
      });
      expect(h.files.size).toBe(0);

      // The session stays failed: a retry of the same state is a conflict.
      const retry = yield* h.run(
        h.service.callback({ state: started.state, code: "c", error: "" }),
      );

      assert.deepStrictEqual(retry, {
        ok: false,
        status: 409,
        error: "Failed to exchange authorization code for tokens",
      });
    }),
  );

  it.effect("rejects unknown states, mismatching providers, replays and incomplete callbacks", () =>
    Effect.gen(function* () {
      yield* startClock;
      const h = makeOAuth(claudeUpstream());
      const started = yield* begin(h, "claude");

      const call = (input: { provider?: string; state: string; code: string; error?: string }) =>
        h.run(h.service.callback({ error: "", ...input }));

      assert.deepStrictEqual(yield* call({ state: "f".repeat(32), code: "c" }), {
        ok: false,
        status: 404,
        error: "unknown or expired state",
      });
      assert.deepStrictEqual(yield* call({ state: "", code: "c" }), {
        ok: false,
        status: 400,
        error: "state is required",
      });
      assert.deepStrictEqual(yield* call({ state: "../etc", code: "c" }), {
        ok: false,
        status: 400,
        error: "invalid state",
      });
      assert.deepStrictEqual(yield* call({ state: started.state, code: "" }), {
        ok: false,
        status: 400,
        error: "code or error is required",
      });
      assert.deepStrictEqual(yield* call({ state: started.state, code: "c", provider: "nope" }), {
        ok: false,
        status: 400,
        error: "unsupported provider",
      });
      assert.deepStrictEqual(yield* call({ state: started.state, code: "c", provider: "codex" }), {
        ok: false,
        status: 400,
        error: "provider does not match state",
      });
      // Nothing above reached the token endpoint or stored a credential.
      expect(h.requests).toHaveLength(0);
      expect(h.files.size).toBe(0);

      assert.deepStrictEqual(
        yield* call({ state: started.state, code: "c", provider: "anthropic" }),
        {
          ok: true,
          outcome: "completed",
        },
      );
      assert.deepStrictEqual(yield* call({ state: started.state, code: "c" }), {
        ok: false,
        status: 409,
        error: "oauth flow is already completed",
      });
    }),
  );

  it.effect("records a provider error and cancels cleanly", () =>
    Effect.gen(function* () {
      yield* startClock;
      const h = makeOAuth(claudeUpstream());
      const denied = yield* begin(h, "claude");
      assert.deepStrictEqual(
        yield* h.run(h.service.callback({ state: denied.state, code: "", error: "access_denied" })),
        { ok: true, outcome: "failed" },
      );
      assert.deepStrictEqual(yield* statusOf(h, denied.state), {
        status: "error",
        error: "Bad request",
      });

      const cancelled = yield* begin(h, "claude");
      assert.deepStrictEqual(yield* h.run(h.service.cancel(cancelled.state)), { cancelled: true });
      assert.deepStrictEqual(yield* h.run(h.service.cancel(cancelled.state)), { cancelled: false });
      // A failed (non-pending) login cannot be cancelled either.
      assert.deepStrictEqual(yield* h.run(h.service.cancel(denied.state)), { cancelled: false });
      assert.deepStrictEqual(
        yield* h.run(h.service.callback({ state: cancelled.state, code: "c", error: "" })),
        {
          ok: false,
          status: 404,
          error: "unknown or expired state",
        },
      );
      expect(h.files.size).toBe(0);
    }),
  );

  it.effect(
    "expires: the callback window closes after 5 minutes and sessions vanish after 30",
    () =>
      Effect.gen(function* () {
        yield* startClock;
        const h = makeOAuth(claudeUpstream());
        const late = yield* begin(h, "claude");
        yield* TestClock.adjust(CALLBACK_WINDOW_MS + 1);
        assert.deepStrictEqual(
          yield* h.run(h.service.callback({ state: late.state, code: "c", error: "" })),
          {
            ok: false,
            status: 409,
            error: "Timeout waiting for OAuth callback",
          },
        );
        assert.deepStrictEqual(yield* statusOf(h, late.state), {
          status: "error",
          error: "Timeout waiting for OAuth callback",
        });
        expect(h.requests).toHaveLength(0);

        // The status poll alone also records the timeout.
        const polled = yield* begin(h, "claude");
        yield* TestClock.adjust(CALLBACK_WINDOW_MS + 1);
        assert.deepStrictEqual(yield* statusOf(h, polled.state), {
          status: "error",
          error: "Timeout waiting for OAuth callback",
        });

        // An errored session lives for another TTL after the last error, then disappears.
        yield* TestClock.adjust(SESSION_TTL_MS + 1);
        assert.deepStrictEqual(yield* statusOf(h, polled.state), {
          status: "error",
          error: "unknown or expired state",
        });
        assert.deepStrictEqual(
          yield* h.run(h.service.callback({ state: polled.state, code: "c", error: "" })),
          {
            ok: false,
            status: 404,
            error: "unknown or expired state",
          },
        );
      }),
  );

  it.effect("a cancel racing the token exchange wins: nothing is saved", () =>
    Effect.gen(function* () {
      yield* startClock;
      let cancelNow: (() => void) | undefined;

      const h = makeOAuth((request) => {
        if (request.url.includes("/oauth/token")) cancelNow?.();

        return claudeUpstream()(request);
      });

      const started = yield* begin(h, "claude");
      cancelNow = () => h.table.delete(started.state);

      const result = yield* h.run(
        h.service.callback({ state: started.state, code: "c", error: "" }),
      );

      assert.deepStrictEqual(result, { ok: true, outcome: "cancelled" });
      expect(h.files.size).toBe(0);
    }),
  );

  it.effect("serialises duplicate callbacks with the busy lease", () =>
    Effect.gen(function* () {
      yield* startClock;
      const h = makeOAuth(claudeUpstream());
      const started = yield* begin(h, "claude");
      // Another request holds the lease (an exchange in flight).
      const session = h.table.get(started.state);

      if (session === undefined) throw new Error("missing session");
      h.table.put({ ...session, busyUntil: T0 + 60_000 });
      assert.deepStrictEqual(
        yield* h.run(h.service.callback({ state: started.state, code: "c", error: "" })),
        {
          ok: false,
          status: 409,
          error: "oauth flow is not pending",
        },
      );
      expect(h.requests).toHaveLength(0);
    }),
  );
});

describe("codex login", () => {
  const TOKEN = "POST https://auth.openai.com/oauth/token";

  const idToken = jwt({
    email: "dev@x.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct-123",
      chatgpt_plan_type: "Plus Pro",
    },
  });

  const upstream = (extra: Record<string, unknown> = {}) =>
    routes({
      [TOKEN]: {
        body: {
          access_token: "codex-at",
          refresh_token: "codex-rt",
          id_token: idToken,
          expires_in: 3600,
          ...extra,
        },
      },
    });

  it.effect("builds the authorization URL and completes with the Go file shape and name", () =>
    Effect.gen(function* () {
      yield* startClock;
      const h = makeOAuth(upstream());
      const started = yield* begin(h, "codex");
      const parts = query(started.url);
      expect(Object.keys(parts)).toEqual([
        "client_id",
        "code_challenge",
        "code_challenge_method",
        "codex_cli_simplified_flow",
        "id_token_add_organizations",
        "prompt",
        "redirect_uri",
        "response_type",
        "scope",
        "state",
      ]);
      expect(parts).toMatchObject({
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        redirect_uri: "http://localhost:1455/auth/callback",
        scope: "openid email profile offline_access",
        prompt: "login",
      });
      const verifier = asString(h.table.get(started.state)?.data.code_verifier);
      expect(parts.code_challenge).toBe(yield* Effect.promise(() => s256(verifier)));

      yield* h.run(
        h.service.callback({ provider: "codex", state: started.state, code: "abc", error: "" }),
      );
      expect(h.requests[0]?.headers["content-type"]).toContain("application/x-www-form-urlencoded");
      expect(h.requests[0]?.form()).toEqual({
        grant_type: "authorization_code",
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        code: "abc",
        redirect_uri: "http://localhost:1455/auth/callback",
        code_verifier: verifier,
      });
      const { name, file } = onlyFile(h);
      // sha256("acct-123")[:8], plan "Plus Pro" -> "plus-pro".
      expect(name).toBe("codex-3abf465e-dev@x.com-plus-pro.json");
      assert.deepStrictEqual(file, {
        id_token: idToken,
        access_token: "codex-at",
        refresh_token: "codex-rt",
        account_id: "acct-123",
        last_refresh: iso(T0),
        email: "dev@x.com",
        type: "codex",
        expired: iso(T0 + 3600_000),
        plan_type: "Plus Pro",
        disabled: false,
      });
    }),
  );

  it.effect(
    "defaults the plan to free and reports a rejected exchange with the (scrubbed) upstream text",
    () =>
      Effect.gen(function* () {
        yield* startClock;
        const h = makeOAuth(upstream({ id_token: "" }));
        const ok = yield* begin(h, "codex");
        yield* h.run(h.service.callback({ state: ok.state, code: "abc", error: "" }));
        expect(onlyFile(h).name).toBe("codex--free.json");

        const failing = makeOAuth(
          routes({
            [TOKEN]: { status: 400, body: { error: "invalid_grant for the-pasted-code" } },
          }),
        );

        const started = yield* begin(failing, "codex");
        yield* failing.run(
          failing.service.callback({ state: started.state, code: "the-pasted-code", error: "" }),
        );
        const status = yield* statusOf(failing, started.state);
        assert.strictEqual(status.status, "error");

        if (status.status !== "error") return;
        expect(status.error).toContain(
          "Failed to exchange authorization code for tokens: token exchange failed with status 400",
        );
        expect(status.error).not.toContain("the-pasted-code");
        expect(failing.files.size).toBe(0);
      }),
  );
});

describe("antigravity login", () => {
  const TOKEN = "POST https://oauth2.googleapis.com/token";
  const USERINFO = "GET https://www.googleapis.com/oauth2/v2/userinfo?alt=json";
  const LOAD = "POST https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
  const ONBOARD = "POST https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser";

  const tokens = {
    body: {
      access_token: "ya29.at",
      refresh_token: "1//rt",
      expires_in: 3599,
      token_type: "Bearer",
    },
  };

  it.effect("builds the Google URL and stores the file with the discovered project", () =>
    Effect.gen(function* () {
      yield* startClock;

      const h = makeOAuth(
        routes({
          [TOKEN]: tokens,
          [USERINFO]: { body: { email: "me@gmail.com" } },
          [LOAD]: { body: { cloudaicompanionProject: { id: "proj-1" } } },
        }),
      );

      const started = yield* begin(h, "antigravity");
      const parts = query(started.url);
      expect(Object.keys(parts)).toEqual([
        "access_type",
        "client_id",
        "prompt",
        "redirect_uri",
        "response_type",
        "scope",
        "state",
      ]);
      expect(parts).toMatchObject({
        access_type: "offline",
        prompt: "consent",
        redirect_uri: "http://localhost:51121/oauth-callback",
      });
      expect((parts.scope ?? "").split(" ")).toHaveLength(6);
      expect(parts.scope?.split(" ")).toContain("https://www.googleapis.com/auth/aicode");
      expect(started.url.startsWith("https://accounts.google.com/o/oauth2/v2/auth?")).toBe(true);

      assert.deepStrictEqual(
        yield* h.run(
          h.service.callback({
            provider: "antigravity",
            state: started.state,
            code: "4/0code",
            error: "",
          }),
        ),
        { ok: true, outcome: "completed" },
      );
      expect(h.requests[0]?.form()).toMatchObject({
        code: "4/0code",
        grant_type: "authorization_code",
        redirect_uri: "http://localhost:51121/oauth-callback",
        client_id: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
      });
      expect(h.requests[1]?.headers.authorization).toBe("Bearer ya29.at");
      expect(h.requests[2]?.json()).toEqual({ metadata: { ideType: "ANTIGRAVITY" } });
      expect(h.requests[2]?.headers["user-agent"]).toBe(
        "antigravity/hub/2.29.0 (aidev_client; os_type=darwin; arch=arm64; cl=1013060670)",
      );
      expect(h.requests[2]?.headers.accept).toBeUndefined();
      const { name, file } = onlyFile(h);
      expect(name).toBe("antigravity-me@gmail.com.json");
      assert.deepStrictEqual(file, {
        type: "antigravity",
        access_token: "ya29.at",
        refresh_token: "1//rt",
        expires_in: 3599,
        timestamp: T0,
        expired: iso(T0 + 3599_000),
        email: "me@gmail.com",
        project_id: "proj-1",
        disabled: false,
      });
    }),
  );

  it.effect("keeps the login when project discovery fails", () =>
    Effect.gen(function* () {
      yield* startClock;

      const h = makeOAuth(
        routes({
          [TOKEN]: tokens,
          [USERINFO]: { body: { email: "me@gmail.com" } },
          [LOAD]: { status: 500, body: "boom" },
        }),
      );

      const started = yield* begin(h, "antigravity");
      yield* h.run(h.service.callback({ state: started.state, code: "c", error: "" }));
      expect(onlyFile(h).file).not.toHaveProperty("project_id");
      assert.deepStrictEqual(yield* statusOf(h, started.state), { status: "ok" });
    }),
  );

  it.effect(
    "onboards the user when loadCodeAssist has no project, polling until the operation is done",
    () =>
      Effect.gen(function* () {
        yield* startClock;
        let onboardCalls = 0;

        const h = makeOAuth(
          routes({
            [TOKEN]: tokens,
            [USERINFO]: { body: { email: "me@gmail.com" } },
            [LOAD]: {
              body: {
                allowedTiers: [{ id: "standard-tier", isDefault: true }, { id: "free-tier" }],
              },
            },
            [ONBOARD]: () => {
              onboardCalls++;

              return onboardCalls === 1
                ? { body: { done: false } }
                : { body: { done: true, response: { cloudaicompanionProject: "proj-2" } } };
            },
          }),
        );

        const started = yield* begin(h, "antigravity");

        const fiber = yield* Effect.forkChild(
          h.run(h.service.callback({ state: started.state, code: "c", error: "" })),
        );

        yield* TestClock.adjust("2 seconds");
        assert.deepStrictEqual(yield* Fiber.join(fiber), { ok: true, outcome: "completed" });
        expect(onboardCalls).toBe(2);
        const onboard = h.requests.find((request) => request.url.includes("onboardUser"));
        expect(onboard?.json()).toEqual({
          tier_id: "standard-tier",
          metadata: { ide_type: "ANTIGRAVITY", ide_version: "2.29.0", ide_name: "antigravity" },
        });
        expect(onboard?.headers["x-goog-api-client"]).toBe("gl-node/22.21.1");
        expect(onlyFile(h).file.project_id).toBe("proj-2");
      }),
  );

  it.effect("fails on token, userinfo and provider errors with the Go messages", () =>
    Effect.gen(function* () {
      yield* startClock;

      const run = (table: Parameters<typeof routes>[0], input: { code: string; error: string }) =>
        Effect.gen(function* () {
          const h = makeOAuth(routes(table));
          const started = yield* begin(h, "antigravity");
          yield* h.run(h.service.callback({ state: started.state, ...input }));
          expect(h.files.size).toBe(0);

          return yield* statusOf(h, started.state);
        });

      assert.deepStrictEqual(
        yield* run(
          { [TOKEN]: { status: 400, body: { error: "invalid_grant" } } },
          { code: "c", error: "" },
        ),
        {
          status: "error",
          error: "Failed to exchange token",
        },
      );
      assert.deepStrictEqual(
        yield* run({ [TOKEN]: { body: { refresh_token: "r" } } }, { code: "c", error: "" }),
        {
          status: "error",
          error: "Failed to exchange token",
        },
      );
      assert.deepStrictEqual(
        yield* run({ [TOKEN]: tokens, [USERINFO]: { body: {} } }, { code: "c", error: "" }),
        {
          status: "error",
          error: "Failed to fetch user info",
        },
      );
      assert.deepStrictEqual(yield* run({}, { code: "", error: "access_denied" }), {
        status: "error",
        error: "Authentication failed",
      });
    }),
  );
});

describe("devin login", () => {
  const TOKEN = "POST https://api.devin.ai/auth/cli/token";
  const SELF = "GET https://api.devin.ai/v3/self";

  const STATUS =
    "POST https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus";

  it.effect(
    "builds the authorization URL with the 127.0.0.1 redirect and stores the session token",
    () =>
      Effect.gen(function* () {
        yield* startClock;

        const h = makeOAuth(
          routes({
            [TOKEN]: { body: { token: "eyJhbGciOi.payload.sig" } },
            [SELF]: { body: { user_name: "dev user", user_id: "u-1", org_id: "o-1" } },
            [STATUS]: { status: 500 },
          }),
        );

        const started = yield* begin(h, "devin");
        expect(
          started.url.startsWith(
            "https://app.devin.ai/auth/cli/continue?redirect_uri=http%3A%2F%2F127.0.0.1%3A8317%2Fcallback&state=",
          ),
        ).toBe(true);
        const parts = query(started.url);
        expect(parts).toMatchObject({
          prompt: "select_account",
          code_challenge_method: "S256",
          state: started.state,
        });
        const verifier = asString(h.table.get(started.state)?.data.code_verifier);
        expect(parts.code_challenge).toBe(yield* Effect.promise(() => s256(verifier)));

        yield* h.run(
          h.service.callback({ provider: "devin", state: started.state, code: " dc ", error: "" }),
        );
        expect(h.requests[0]?.json()).toEqual({ code: "dc", code_verifier: verifier });
        expect(h.requests[1]?.headers.authorization).toBe(
          "Bearer devin-session-token$eyJhbGciOi.payload.sig",
        );
        const { name, file } = onlyFile(h);
        // "dev user" contains a space, so the identifier is replaced by a hash of it.
        expect(name).toMatch(/^devin-user-[0-9a-f]{16}\.json$/);
        assert.deepStrictEqual(file, {
          type: "devin",
          api_key: "devin-session-token$eyJhbGciOi.payload.sig",
          session_token: "devin-session-token$eyJhbGciOi.payload.sig",
          user_name: "dev user",
          user_id: "u-1",
          org_id: "o-1",
          auth_kind: "oauth",
          disabled: false,
        });
      }),
  );

  it.effect("hides exchange failures and maps a denied authorization", () =>
    Effect.gen(function* () {
      yield* startClock;

      const h = makeOAuth(
        routes({ [TOKEN]: { status: 400, body: { error: "bad code leak-me" } } }),
      );

      const started = yield* begin(h, "devin");
      yield* h.run(h.service.callback({ state: started.state, code: "c", error: "" }));
      assert.deepStrictEqual(yield* statusOf(h, started.state), {
        status: "error",
        error: "Failed to exchange authorization code for tokens",
      });

      const denied = yield* begin(h, "devin");
      yield* h.run(h.service.callback({ state: denied.state, code: "", error: "access_denied" }));
      assert.deepStrictEqual(yield* statusOf(h, denied.state), {
        status: "error",
        error: "Devin authorization denied",
      });
      expect(h.files.size).toBe(0);
    }),
  );
});
