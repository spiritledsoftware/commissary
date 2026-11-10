// Device-code logins (xAI, Meta, Kimi, Codex device): start, client-driven polling at the provider interval, results.
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import type { JsonObject } from "@commissary/json";
import {
  begin,
  iso,
  jwt,
  makeOAuth,
  onlyFile,
  routes,
  startClock,
  statusOf,
  T0,
} from "./support/oauth.ts";

const pending = { status: 200, body: { error: "authorization_pending" } };

/** Meta (RFC 8628) answers pending with a 4xx; a 200 is a token response. */
const metaPending = { status: 400, body: { error: "authorization_pending" } };

describe("xai login", () => {
  const DISCOVERY = "GET https://auth.x.ai/.well-known/openid-configuration";
  const DEVICE = "POST https://auth.x.ai/oauth2/device/code";
  const TOKEN = "POST https://auth.x.ai/oauth2/token";

  const discovery = {
    body: {
      device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code",
      token_endpoint: "https://auth.x.ai/oauth2/token",
    },
  };

  const device = (body: Record<string, unknown> = {}) => ({
    body: {
      device_code: "dev-code-xyz",
      user_code: "ABCD-1234",
      verification_uri: "https://x.ai/device",
      verification_uri_complete: "https://x.ai/device?code=ABCD-1234",
      expires_in: 900,
      interval: 7,
      ...body,
    },
  });

  const idToken = jwt({ email: "grok@x.com", sub: "sub-9" });

  it.effect(
    "starts through discovery and polls once immediately, then at most every interval",
    () =>
      Effect.gen(function* () {
        yield* startClock;
        const replies = [pending, { status: 200, body: { error: "slow_down" } }, pending];

        const h = makeOAuth(
          routes({
            [DISCOVERY]: discovery,
            [DEVICE]: device(),
            [TOKEN]: () => replies.shift() ?? pending,
          }),
        );

        const started = yield* begin(h, "xai");
        assert.deepStrictEqual(
          {
            flow: started.flow,
            userCode: started.userCode,
            expiresIn: started.expiresIn,
            url: started.url,
          },
          {
            flow: "device",
            userCode: "ABCD-1234",
            expiresIn: 900,
            url: "https://x.ai/device?code=ABCD-1234",
          },
        );
        expect(started.state).toMatch(/^xai-\d+-[0-9a-f]{8}$/);
        expect(h.requests[1]?.form()).toEqual({
          client_id: "b1a00492-073a-47ea-816f-4c329264a828",
          scope: "openid profile email offline_access grok-cli:access api:access",
        });
        // No secrets in the start response.
        expect(JSON.stringify(started)).not.toContain("dev-code-xyz");

        const polls = () =>
          h.requests.filter((request) => request.url === "https://auth.x.ai/oauth2/token").length;

        assert.deepStrictEqual(yield* statusOf(h, started.state), { status: "wait" });
        expect(polls()).toBe(1);
        expect(h.requests[2]?.form()).toEqual({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: "dev-code-xyz",
          client_id: "b1a00492-073a-47ea-816f-4c329264a828",
        });

        // Polling faster than the 7 s interval never reaches the provider.
        yield* TestClock.adjust(6_999);
        assert.deepStrictEqual(yield* statusOf(h, started.state), { status: "wait" });
        assert.deepStrictEqual(yield* statusOf(h, started.state), { status: "wait" });
        expect(polls()).toBe(1);

        // Due: slow_down adds 5 s to the interval.
        yield* TestClock.adjust(1);
        yield* statusOf(h, started.state);
        expect(polls()).toBe(2);
        yield* TestClock.adjust(11_999);
        yield* statusOf(h, started.state);
        expect(polls()).toBe(2);
        yield* TestClock.adjust(1);
        yield* statusOf(h, started.state);
        expect(polls()).toBe(3);
      }),
  );

  it.effect("stores the Go credential once the user approved", () =>
    Effect.gen(function* () {
      yield* startClock;

      const h = makeOAuth(
        routes({
          [DISCOVERY]: discovery,
          [DEVICE]: device({ interval: 0 }),
          [TOKEN]: {
            body: {
              access_token: "xai-at",
              refresh_token: "xai-rt",
              id_token: idToken,
              token_type: "Bearer",
              expires_in: 1800,
            },
          },
        }),
      );

      const started = yield* begin(h, "xai");
      assert.deepStrictEqual(yield* statusOf(h, started.state), { status: "ok" });
      const { name, file } = onlyFile(h);
      expect(name).toBe("xai-grok@x.com-ed744a8e197a1f72.json");
      assert.deepStrictEqual(file, {
        type: "xai",
        access_token: "xai-at",
        refresh_token: "xai-rt",
        id_token: idToken,
        token_type: "Bearer",
        expires_in: 1800,
        expired: iso(T0 + 1800_000),
        last_refresh: iso(T0),
        base_url: "https://api.x.ai/v1",
        token_endpoint: "https://auth.x.ai/oauth2/token",
        auth_kind: "oauth",
        email: "grok@x.com",
        sub: "sub-9",
        disabled: false,
      });
      // Completed sessions answer ok without polling again.
      const before = h.requests.length;
      assert.deepStrictEqual(yield* statusOf(h, started.state), { status: "ok" });
      expect(h.requests).toHaveLength(before);
    }),
  );

  it.effect("names the file after the subject, or the time, when the id token has no e-mail", () =>
    Effect.gen(function* () {
      yield* startClock;

      const make = (claims: JsonObject) =>
        makeOAuth(
          routes({
            [DISCOVERY]: discovery,
            [DEVICE]: device(),
            [TOKEN]: { body: { access_token: "a", id_token: jwt(claims) } },
          }),
        );

      const bySub = make({ sub: "user/1" });
      yield* statusOf(bySub, (yield* begin(bySub, "xai")).state);
      expect(onlyFile(bySub).name).toBe("xai-user-1-1e1bd7ff51b7806c.json");
      const anonymous = make({});
      yield* statusOf(anonymous, (yield* begin(anonymous, "xai")).state);
      expect(onlyFile(anonymous).name).toBe(`xai-${T0}.json`);
    }),
  );

  it.effect("reports denial, expiry and provider errors and never saves", () =>
    Effect.gen(function* () {
      yield* startClock;

      const failure = (reply: { status?: number; body?: unknown }) =>
        Effect.gen(function* () {
          const h = makeOAuth(
            routes({ [DISCOVERY]: discovery, [DEVICE]: device(), [TOKEN]: reply }),
          );

          const started = yield* begin(h, "xai");
          const status = yield* statusOf(h, started.state);
          expect(h.files.size).toBe(0);
          // The failure sticks.
          assert.deepStrictEqual(yield* statusOf(h, started.state), status);

          return status;
        });

      assert.deepStrictEqual(yield* failure({ body: { error: "access_denied" } }), {
        status: "error",
        error: "Authentication failed: xai device authorization denied",
      });
      assert.deepStrictEqual(yield* failure({ body: { error: "expired_token" } }), {
        status: "error",
        error: "Authentication failed: xai device code expired",
      });
      assert.deepStrictEqual(
        yield* failure({
          status: 400,
          body: { error: "invalid_client", error_description: "nope" },
        }),
        {
          status: "error",
          error: "Authentication failed: xai device token error: invalid_client: nope",
        },
      );
      assert.deepStrictEqual(yield* failure({ status: 200, body: { refresh_token: "r" } }), {
        status: "error",
        error: "Authentication failed: xai device token response missing access_token",
      });
    }),
  );

  it.effect("expires with the device code and survives transient transport errors", () =>
    Effect.gen(function* () {
      yield* startClock;
      let transient = true;

      const h = makeOAuth(
        routes({
          [DISCOVERY]: discovery,
          [DEVICE]: device({ expires_in: 600, interval: 5 }),
          [TOKEN]: () => (transient ? { transportError: true } : pending),
        }),
      );

      const started = yield* begin(h, "xai");
      assert.deepStrictEqual(yield* statusOf(h, started.state), { status: "wait" });
      transient = false;
      yield* TestClock.adjust(5_000);
      assert.deepStrictEqual(yield* statusOf(h, started.state), { status: "wait" });
      const polls = h.requests.length;
      yield* TestClock.adjust(600_000);
      assert.deepStrictEqual(yield* statusOf(h, started.state), {
        status: "error",
        error: "Authentication failed: xai device code expired",
      });
      expect(h.requests).toHaveLength(polls);
    }),
  );

  it.effect("stops polling once cancelled and refuses non-x.ai endpoints", () =>
    Effect.gen(function* () {
      yield* startClock;
      const h = makeOAuth(routes({ [DISCOVERY]: discovery, [DEVICE]: device(), [TOKEN]: pending }));
      const started = yield* begin(h, "xai");
      yield* statusOf(h, started.state);
      assert.deepStrictEqual(yield* h.run(h.service.cancel(started.state)), { cancelled: true });
      const polls = h.requests.length;
      yield* TestClock.adjust(60_000);
      assert.deepStrictEqual(yield* statusOf(h, started.state), {
        status: "error",
        error: "unknown or expired state",
      });
      expect(h.requests).toHaveLength(polls);

      const evil = makeOAuth(
        routes({
          [DISCOVERY]: {
            body: {
              device_authorization_endpoint: "https://evil.example/device",
              token_endpoint: "https://auth.x.ai/t",
            },
          },
        }),
      );

      assert.deepStrictEqual(yield* evil.run(evil.service.start({ provider: "xai" })), {
        ok: false,
        status: 500,
        error: "failed to start device authorization flow",
      });
      expect(evil.table.rows.size).toBe(0);
    }),
  );
});

describe("meta login", () => {
  const DEVICE = "POST https://auth.meta.com/oidc/device/authorization/";
  const TOKEN = "POST https://auth.meta.com/oidc/device/token/";
  const MINT = "POST https://api.meta.ai/muse-code/key";

  const deviceReply = {
    body: {
      device_code: "meta-dev",
      user_code: "WXYZ",
      verification_uri_complete: "https://meta.com/device?c=WXYZ",
      expires_in: 1200,
    },
  };

  const minted = {
    body: {
      api_key: "meta-api-key",
      base_url: "https://api.meta.ai/v2",
      user_email: "me@meta.com",
      user_full_name: "Me Meta",
      subs_tier_name: "Pro",
      subs_tier_id: "t1",
      is_subs_active: true,
      has_payment_method: false,
    },
  };

  it.effect("mints through META_MINT_URL when it is set", () =>
    Effect.gen(function* () {
      yield* startClock;

      const h = makeOAuth(
        routes({
          [DEVICE]: deviceReply,
          [TOKEN]: { body: { access_token: "dca:abc123", token_type: "Bearer", expires_in: 7200 } },
          "POST https://mint.example.test/key": minted,
        }),
        {},
        { metaMintUrl: "https://mint.example.test/key" },
      );

      const started = yield* begin(h, "meta");
      yield* TestClock.adjust(5_000);
      assert.deepStrictEqual(yield* statusOf(h, started.state), { status: "ok" });
      expect(h.requests.at(-1)?.url).toBe("https://mint.example.test/key");
      expect(onlyFile(h).file).toMatchObject({ api_key: "meta-api-key" });
    }),
  );

  it.effect("waits one interval before the first poll, mints the key and writes the Go file", () =>
    Effect.gen(function* () {
      yield* startClock;

      const h = makeOAuth(
        routes({
          [DEVICE]: deviceReply,
          [TOKEN]: { body: { access_token: "dca:abc123", token_type: "Bearer", expires_in: 7200 } },
          [MINT]: minted,
        }),
      );

      const started = yield* begin(h, "meta");
      expect(started).toMatchObject({
        flow: "device",
        userCode: "WXYZ",
        expiresIn: 1200,
        url: "https://meta.com/device?c=WXYZ",
      });
      expect(h.requests[0]?.headers["user-agent"]).toBe("muse-code/1.0.2");
      expect(h.requests[0]?.form()).toEqual({ client_id: "1031625952748946" });

      // Default interval is 5 s and Go's ticker fires first after one interval.
      assert.deepStrictEqual(yield* statusOf(h, started.state), { status: "wait" });
      expect(h.requests).toHaveLength(1);
      yield* TestClock.adjust(5_000);
      assert.deepStrictEqual(yield* statusOf(h, started.state), { status: "ok" });
      expect(h.requests[1]?.form()).toEqual({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: "meta-dev",
        client_id: "1031625952748946",
      });
      expect(h.requests[2]?.headers.authorization).toBe("Bearer dca:abc123");
      expect(h.requests[2]?.json()).toEqual({ dca_token: "dca:abc123" });

      const { name, file } = onlyFile(h);
      // sha256("me@meta.com")[:8 bytes].
      expect(name).toMatch(/^meta-me_meta\.com-[0-9a-f]{16}\.json$/);
      const expiresAt = Math.floor((T0 + 5_000) / 1000) + 7200;
      assert.deepStrictEqual(file, {
        type: "meta",
        auth_kind: "oauth",
        access_token: "meta-api-key",
        dca_token: "dca:abc123",
        api_key: "meta-api-key",
        token_type: "Bearer",
        expires_in: 7200,
        dca_expired: iso(expiresAt * 1000),
        dca_expires_at: expiresAt,
        last_refresh: iso(T0 + 5_000),
        base_url: "https://api.meta.ai/v2",
        email: "me@meta.com",
        name: "Me Meta",
        subs_tier_name: "Pro",
        subs_tier_id: "t1",
        is_subs_active: true,
        has_payment_method: false,
        disabled: false,
      });
    }),
  );

  it.effect(
    "stores the DCA token alone when minting fails and names the file after the token",
    () =>
      Effect.gen(function* () {
        yield* startClock;

        const h = makeOAuth(
          routes({
            [DEVICE]: deviceReply,
            [TOKEN]: { body: { access_token: "dca:abc123", expires_in: 3600 } },
            [MINT]: { status: 500 },
          }),
        );

        const started = yield* begin(h, "meta");
        yield* TestClock.adjust(5_000);
        assert.deepStrictEqual(yield* statusOf(h, started.state), { status: "ok" });
        const { name, file } = onlyFile(h);
        expect(name).toBe("meta-d58656405508ee51.json");
        expect(file).toMatchObject({
          access_token: "dca:abc123",
          dca_token: "dca:abc123",
          base_url: "https://api.meta.ai/v1",
          expired: iso(Math.floor((T0 + 5_000) / 1000) * 1000 + 3600_000),
        });
        expect(file).not.toHaveProperty("api_key");
        expect(file).not.toHaveProperty("email");
      }),
  );

  it.effect("handles pending, slow_down, denial and expiry", () =>
    Effect.gen(function* () {
      yield* startClock;

      const replies = [
        metaPending,
        { status: 400, body: { error: "slow_down" } },
        { status: 400, body: { error: "access_denied" } },
      ];

      const h = makeOAuth(
        routes({ [DEVICE]: deviceReply, [TOKEN]: () => replies.shift() ?? metaPending }),
      );

      const started = yield* begin(h, "meta");
      yield* TestClock.adjust(5_000);
      assert.deepStrictEqual(yield* statusOf(h, started.state), { status: "wait" });
      yield* TestClock.adjust(5_000);
      assert.deepStrictEqual(yield* statusOf(h, started.state), { status: "wait" });
      // slow_down: the next poll is 10 s after the previous one.
      yield* TestClock.adjust(9_999);
      assert.deepStrictEqual(yield* statusOf(h, started.state), { status: "wait" });
      expect(h.requests).toHaveLength(3);
      yield* TestClock.adjust(1);
      assert.deepStrictEqual(yield* statusOf(h, started.state), {
        status: "error",
        error: "Authentication failed: meta auth: access was denied by user",
      });
      expect(h.files.size).toBe(0);

      const expired = makeOAuth(routes({ [DEVICE]: deviceReply, [TOKEN]: metaPending }));
      const later = yield* begin(expired, "meta");
      yield* TestClock.adjust(1_200_001);
      assert.deepStrictEqual(yield* statusOf(expired, later.state), {
        status: "error",
        error:
          "Authentication failed: meta auth: authorization timed out or canceled: context deadline exceeded",
      });
    }),
  );

  it.effect("rejects a device response without codes", () =>
    Effect.gen(function* () {
      yield* startClock;
      const h = makeOAuth(routes({ [DEVICE]: { body: { device_code: "x" } } }));
      assert.deepStrictEqual(yield* h.run(h.service.start({ provider: "meta" })), {
        ok: false,
        status: 500,
        error: "failed to start device authorization flow",
      });
    }),
  );
});

describe("kimi login", () => {
  const COM_DEVICE = "POST https://auth.kimi.com/api/oauth/device_authorization";
  const COM_TOKEN = "POST https://auth.kimi.com/api/oauth/token";
  const AI_DEVICE = "POST https://auth.kimi.ai/api/oauth/device_authorization";
  const AI_TOKEN = "POST https://auth.kimi.ai/api/oauth/token";

  const deviceReply = {
    body: {
      device_code: "kimi-dev",
      user_code: "K-1",
      verification_uri_complete: "https://www.kimi.com/code/authorize_device?user_code=K-1",
      expires_in: 600,
      interval: 1,
    },
  };

  const tokens = {
    body: {
      access_token: "kimi-at",
      refresh_token: "kimi-rt",
      token_type: "Bearer",
      expires_in: 3600.5,
      scope: "kimi-code",
    },
  };

  it.effect("kimi.com: device headers, the 5 s minimum interval and the Go file", () =>
    Effect.gen(function* () {
      yield* startClock;
      const h = makeOAuth(routes({ [COM_DEVICE]: deviceReply, [COM_TOKEN]: tokens }));
      const started = yield* begin(h, "kimi");
      expect(started.state).toMatch(/^kmi-\d+-[0-9a-f]{8}$/);
      expect(started).toMatchObject({ flow: "device", userCode: "K-1", expiresIn: 600 });
      const deviceId = h.requests[0]?.headers["x-msh-device-id"];
      expect(deviceId).toMatch(/^[0-9a-f-]{36}$/);
      expect(h.requests[0]?.headers).toMatchObject({
        "x-msh-platform": "CLIProxyAPI",
        accept: "application/json",
      });
      expect(h.requests[0]?.form()).toEqual({ client_id: "17e5f671-d194-4dfb-9706-5516cb48c098" });

      // `interval: 1` is raised to 5 s.
      yield* TestClock.adjust(4_999);
      assert.deepStrictEqual(yield* statusOf(h, started.state), { status: "wait" });
      expect(h.requests).toHaveLength(1);
      yield* TestClock.adjust(1);
      assert.deepStrictEqual(yield* statusOf(h, started.state), { status: "ok" });
      expect(h.requests[1]?.headers["x-msh-device-id"]).toBe(deviceId);
      expect(h.requests[1]?.form()).toEqual({
        client_id: "17e5f671-d194-4dfb-9706-5516cb48c098",
        device_code: "kimi-dev",
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
      const now = T0 + 5_000;
      const { name, file } = onlyFile(h);
      expect(name).toBe(`kimi-${now}.json`);
      assert.deepStrictEqual(file, {
        type: "kimi",
        access_token: "kimi-at",
        refresh_token: "kimi-rt",
        token_type: "Bearer",
        scope: "kimi-code",
        timestamp: now,
        domain: "kimi.com",
        base_url: "https://api.kimi.com/coding",
        expired: iso((Math.floor(now / 1000) + 3600) * 1000),
        device_id: deviceId ?? "",
        disabled: false,
      });
    }),
  );

  it.effect("kimi-ai (and ?domain=kimi.ai) use the .ai hosts and the kimi-ai type", () =>
    Effect.gen(function* () {
      yield* startClock;

      for (const input of [{ provider: "kimi-ai" }, { provider: "kimi", domain: "kimi.ai" }]) {
        const h = makeOAuth(routes({ [AI_DEVICE]: deviceReply, [AI_TOKEN]: tokens }));

        const started = yield* begin(
          h,
          input.provider,
          input.domain === undefined ? {} : { domain: input.domain },
        );

        expect(started.state).toMatch(/^kmi-ai-/);
        yield* TestClock.adjust(5_000);
        assert.deepStrictEqual(yield* statusOf(h, started.state), { status: "ok" });
        const { name, file } = onlyFile(h);
        expect(name).toMatch(/^kimi-ai-\d+\.json$/);
        expect(file).toMatchObject({
          type: "kimi-ai",
          domain: "kimi.ai",
          base_url: "https://api.kimi.ai/coding",
        });
      }
    }),
  );

  it.effect("keeps polling through pending/slow_down and reports terminal errors", () =>
    Effect.gen(function* () {
      yield* startClock;

      const replies = [
        { body: { error: "authorization_pending" } },
        { body: { error: "slow_down" } },
        { body: { error: "access_denied" } },
      ];

      const h = makeOAuth(
        routes({ [COM_DEVICE]: deviceReply, [COM_TOKEN]: () => replies.shift() ?? pending }),
      );

      const started = yield* begin(h, "kimi");

      for (const _ of [1, 2]) {
        yield* TestClock.adjust(5_000);
        assert.deepStrictEqual(yield* statusOf(h, started.state), { status: "wait" });
      }

      // slow_down does not increase Kimi's interval.
      yield* TestClock.adjust(5_000);
      assert.deepStrictEqual(yield* statusOf(h, started.state), {
        status: "error",
        error: "Authentication failed: kimi: access denied by user",
      });

      const other = makeOAuth(
        routes({
          [COM_DEVICE]: deviceReply,
          [COM_TOKEN]: { body: { error: "weird", error_description: "why" } },
        }),
      );

      const second = yield* begin(other, "kimi");
      yield* TestClock.adjust(5_000);
      assert.deepStrictEqual(yield* statusOf(other, second.state), {
        status: "error",
        error: "Authentication failed: kimi: OAuth error: weird - why",
      });

      const slow = makeOAuth(routes({ [COM_DEVICE]: deviceReply, [COM_TOKEN]: pending }));
      const third = yield* begin(slow, "kimi");
      yield* TestClock.adjust(600_001);
      assert.deepStrictEqual(yield* statusOf(slow, third.state), {
        status: "error",
        error: "Authentication failed: kimi: device code expired",
      });
    }),
  );

  it.effect("answers a failing device endpoint with 500 and unknown providers with 404", () =>
    Effect.gen(function* () {
      yield* startClock;
      const h = makeOAuth(routes({ [COM_DEVICE]: { status: 503 } }));
      assert.deepStrictEqual(yield* h.run(h.service.start({ provider: "kimi" })), {
        ok: false,
        status: 500,
        error: "failed to generate authorization url",
      });
      assert.deepStrictEqual(yield* h.run(h.service.start({ provider: "nope" })), {
        ok: false,
        status: 404,
        error: "provider_not_found",
      });
      assert.deepStrictEqual(yield* h.run(h.service.start({ provider: " " })), {
        ok: false,
        status: 400,
        error: "provider is required",
      });
    }),
  );
});

describe("codex device login", () => {
  const USERCODE = "POST https://auth.openai.com/api/accounts/deviceauth/usercode";
  const POLL = "POST https://auth.openai.com/api/accounts/deviceauth/token";
  const TOKEN = "POST https://auth.openai.com/oauth/token";

  const idToken = jwt({
    email: "dev@x.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" },
  });

  it.effect(
    "polls until approved, then exchanges with the device redirect and the returned verifier",
    () =>
      Effect.gen(function* () {
        yield* startClock;

        const replies = [
          { status: 403 },
          { status: 404 },
          { body: { authorization_code: "ac", code_verifier: "cv", code_challenge: "cc" } },
        ];

        const h = makeOAuth(
          routes({
            [USERCODE]: { body: { device_auth_id: "dai-1", usercode: "UC-9", interval: "3" } },
            [POLL]: () => replies.shift() ?? { status: 403 },
            [TOKEN]: {
              body: { access_token: "at", refresh_token: "rt", id_token: idToken, expires_in: 100 },
            },
          }),
        );

        const started = yield* begin(h, "codex", { flow: "device" });
        expect(started).toMatchObject({
          flow: "device",
          userCode: "UC-9",
          url: "https://auth.openai.com/codex/device",
          expiresIn: 900,
        });
        expect(h.requests[0]?.json()).toEqual({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });

        assert.deepStrictEqual(yield* statusOf(h, started.state), { status: "wait" });
        expect(h.requests).toHaveLength(1);

        for (const _ of [1, 2]) {
          yield* TestClock.adjust(3_000);
          assert.deepStrictEqual(yield* statusOf(h, started.state), { status: "wait" });
        }

        yield* TestClock.adjust(3_000);
        assert.deepStrictEqual(yield* statusOf(h, started.state), { status: "ok" });
        expect(h.requests[1]?.json()).toEqual({ device_auth_id: "dai-1", user_code: "UC-9" });
        expect(h.requests[4]?.form()).toEqual({
          grant_type: "authorization_code",
          client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
          code: "ac",
          redirect_uri: "https://auth.openai.com/deviceauth/callback",
          code_verifier: "cv",
        });
        const { name, file } = onlyFile(h);
        expect(name).toBe("codex-3abf465e-dev@x.com-free.json");
        expect(file).toMatchObject({
          type: "codex",
          email: "dev@x.com",
          account_id: "acct-123",
          plan_type: "free",
        });
      }),
  );

  it.effect("fails on unexpected poll statuses, missing e-mail and the 15 minute limit", () =>
    Effect.gen(function* () {
      yield* startClock;
      const usercode = { body: { device_auth_id: "dai", user_code: "UC" } };

      const failed = makeOAuth(
        routes({ [USERCODE]: usercode, [POLL]: { status: 500, body: "internal" } }),
      );

      const first = yield* begin(failed, "codex", { flow: "device" });
      yield* TestClock.adjust(5_000);
      assert.deepStrictEqual(yield* statusOf(failed, first.state), {
        status: "error",
        error: "Authentication failed: codex device token polling failed with status 500: internal",
      });

      const anonymous = makeOAuth(
        routes({
          [USERCODE]: usercode,
          [POLL]: { body: { authorization_code: "ac", code_verifier: "cv", code_challenge: "cc" } },
          [TOKEN]: { body: { access_token: "at", id_token: jwt({}) } },
        }),
      );

      const second = yield* begin(anonymous, "codex", { flow: "device" });
      yield* TestClock.adjust(5_000);
      assert.deepStrictEqual(yield* statusOf(anonymous, second.state), {
        status: "error",
        error: "Authentication failed: codex token storage missing account information",
      });
      expect(anonymous.files.size).toBe(0);

      const slow = makeOAuth(routes({ [USERCODE]: usercode, [POLL]: { status: 403 } }));
      const third = yield* begin(slow, "codex", { flow: "device" });
      yield* TestClock.adjust(15 * 60_000 + 1);
      assert.deepStrictEqual(yield* statusOf(slow, third.state), {
        status: "error",
        error: "Authentication failed: codex device authentication timed out after 15 minutes",
      });
    }),
  );

  it.effect("device sessions refuse pasted callbacks", () =>
    Effect.gen(function* () {
      yield* startClock;

      const h = makeOAuth(
        routes({ [USERCODE]: { body: { device_auth_id: "dai", user_code: "UC" } } }),
      );

      const started = yield* begin(h, "codex", { flow: "device" });
      assert.deepStrictEqual(
        yield* h.run(
          h.service.callback({ provider: "codex", state: started.state, code: "c", error: "" }),
        ),
        { ok: false, status: 409, error: "oauth flow does not accept a callback" },
      );
    }),
  );
});
