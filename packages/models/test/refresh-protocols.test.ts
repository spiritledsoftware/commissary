// Per-provider refresh request/response shapes against a mocked HttpClient.
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import type { JsonObject } from "@commissary/json";
import { refreshAntigravity } from "../src/credentials/refresh/antigravity.ts";
import { refreshClaude } from "../src/credentials/refresh/claude.ts";
import { refreshCodex } from "../src/credentials/refresh/codex.ts";
import { RefreshError } from "../src/credentials/refresh/error.ts";
import { refreshKimi } from "../src/credentials/refresh/kimi.ts";
import { refreshMeta } from "../src/credentials/refresh/meta.ts";
import type { RefreshContext, RefreshProtocol } from "../src/credentials/refresh/types.ts";
import { refreshXai } from "../src/credentials/refresh/xai.ts";
import { jwt, mockHttp, routes, T0, type MockHandler } from "./support/refresh.ts";

const run = async (
  protocol: RefreshProtocol,
  metadata: JsonObject,
  handler: MockHandler,
  overrides: Partial<RefreshContext> = {},
) => {
  const http = mockHttp(handler);

  const outcome = await Effect.runPromise(
    protocol({
      provider: "test",
      metadata,
      attributes: {},
      now: T0,
      retryDelayMs: () => 0,
      ...overrides,
    }).pipe(
      Effect.provide(http.layer),
      Effect.map((value) => ({ ok: true as const, value })),
      Effect.catch((error: RefreshError) => Effect.succeed({ ok: false as const, error })),
    ),
  );

  return { outcome, requests: http.requests };
};

const success = <T>(outcome: { ok: true; value: T } | { ok: false; error: RefreshError }): T => {
  if (!outcome.ok) throw new Error(`refresh failed: ${outcome.error.message}`);

  return outcome.value;
};

const failure = (outcome: { ok: boolean; error?: RefreshError }): RefreshError => {
  if (outcome.ok || outcome.error === undefined) throw new Error("refresh unexpectedly succeeded");

  return outcome.error;
};

const rfc = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

describe("claude", () => {
  const TOKEN = "POST https://platform.claude.com/v1/oauth/token";
  const PROFILE = "GET https://api.anthropic.com/api/oauth/profile";

  const metadata = {
    type: "claude",
    access_token: "old",
    refresh_token: "rt-1",
    email: "old@x.com",
    extra: "kept",
  };

  it("posts the JSON refresh body, rotates tokens and fills the profile identity", async () => {
    const { outcome, requests } = await run(
      refreshClaude,
      metadata,
      routes({
        [TOKEN]: {
          body: {
            access_token: "new-at",
            refresh_token: "rt-2",
            expires_in: 28800,
            token_type: "Bearer",
          },
        },
        [PROFILE]: {
          body: {
            account: { uuid: "acc", email: "me@x.com" },
            organization: { uuid: "org", name: "Org" },
          },
        },
      }),
    );

    expect(requests).toHaveLength(2);
    expect(requests[0]?.json()).toEqual({
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      grant_type: "refresh_token",
      refresh_token: "rt-1",
      scope:
        "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
    });
    expect(requests[0]?.headers).toMatchObject({
      "content-type": "application/json",
      accept: "application/json, text/plain, */*",
      "user-agent": "axios/1.15.2",
    });
    expect(requests[1]?.headers).toMatchObject({
      authorization: "Bearer new-at",
      "cache-control": "no-cache",
    });
    expect(success(outcome)).toEqual({
      type: "claude",
      access_token: "new-at",
      refresh_token: "rt-2",
      email: "me@x.com",
      account_uuid: "acc",
      organization_uuid: "org",
      organization_name: "Org",
      expired: rfc(T0 + 28_800_000),
      last_refresh: rfc(T0),
      extra: "kept",
    });
  });

  it("keeps the old refresh token when none is returned and never blanks identity when the profile fails", async () => {
    const { outcome } = await run(
      refreshClaude,
      metadata,
      routes({
        [TOKEN]: { body: { access_token: "new-at", expires_in: 60 } },
        [PROFILE]: { status: 403, body: "no" },
      }),
    );

    expect(success(outcome)).toMatchObject({
      refresh_token: "rt-1",
      email: "old@x.com",
      access_token: "new-at",
    });
  });

  it("returns the metadata unchanged without a refresh token (no request)", async () => {
    const { outcome, requests } = await run(refreshClaude, { access_token: "a" }, routes({}));
    expect(success(outcome)).toEqual({ access_token: "a" });
    expect(requests).toHaveLength(0);
  });

  it("retries HTTP >= 500 up to three attempts but not other statuses", async () => {
    const server = await run(
      refreshClaude,
      metadata,
      routes({ [TOKEN]: { status: 503, body: "busy" } }),
    );

    expect(server.requests).toHaveLength(3);
    expect(failure(server.outcome)).toMatchObject({ status: 503 });

    const client = await run(
      refreshClaude,
      metadata,
      routes({ [TOKEN]: { status: 400, body: '{"error":"invalid_grant"}' } }),
    );

    expect(client.requests).toHaveLength(1);
    expect(failure(client.outcome).message).toContain("status 400");
    expect(failure(client.outcome).message).toContain("invalid_grant");
  });

  it("does not retry a transport failure (the single-use token may be consumed)", async () => {
    const { outcome, requests } = await run(refreshClaude, metadata, () => ({
      transportError: true,
    }));

    expect(requests).toHaveLength(1);
    expect(failure(outcome).status).toBeUndefined();
  });

  it("429 blocks the refresh token for Retry-After, clamped to 5 s .. 5 min", async () => {
    const block = async (headers: Record<string, string>) =>
      failure(
        (
          await run(
            refreshClaude,
            metadata,
            routes({ [TOKEN]: { status: 429, body: "slow", headers } }),
          )
        ).outcome,
      );

    expect(await block({ "retry-after": "30" })).toMatchObject({ status: 429, blockMs: 30_000 });
    expect((await block({ "retry-after": "1" })).blockMs).toBe(5_000);
    expect((await block({ "retry-after": "99999" })).blockMs).toBe(300_000);
    expect((await block({ "retry-after-ms": "12000" })).blockMs).toBe(12_000);
    expect((await block({})).blockMs).toBe(5_000);

    const retried = await run(
      refreshClaude,
      metadata,
      routes({ [TOKEN]: { status: 429, body: "slow" } }),
    );

    expect(retried.requests).toHaveLength(1);
  });
});

describe("codex", () => {
  const TOKEN = "POST https://auth.openai.com/oauth/token";

  const idToken = jwt({
    email: "me@x.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-1", chatgpt_plan_type: "plus" },
  });

  const metadata = {
    type: "codex",
    refresh_token: "rt-1",
    access_token: "old",
    email: "old@x.com",
    plan_type: "team",
  };

  it("posts the urlencoded refresh form and stores the id_token identity", async () => {
    const { outcome, requests } = await run(
      refreshCodex,
      metadata,
      routes({
        [TOKEN]: {
          body: {
            access_token: "at-2",
            refresh_token: "rt-2",
            id_token: idToken,
            expires_in: 3600,
          },
        },
      }),
    );

    expect(requests[0]?.form()).toEqual({
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      grant_type: "refresh_token",
      refresh_token: "rt-1",
      scope: "openid profile email",
    });
    expect(requests[0]?.headers).toMatchObject({
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    });
    expect(success(outcome)).toMatchObject({
      type: "codex",
      id_token: idToken,
      access_token: "at-2",
      refresh_token: "rt-2",
      account_id: "acct-1",
      email: "me@x.com",
      plan_type: "plus",
      expired: rfc(T0 + 3_600_000),
      last_refresh: rfc(T0),
    });
  });

  it("keeps refresh_token, email and plan when the response lacks them", async () => {
    const { outcome } = await run(
      refreshCodex,
      metadata,
      routes({ [TOKEN]: { body: { access_token: "at-2", expires_in: 10 } } }),
    );

    expect(success(outcome)).toMatchObject({
      refresh_token: "rt-1",
      email: "old@x.com",
      plan_type: "team",
      id_token: "",
    });
  });

  it("retries three times, except for refresh_token_reused", async () => {
    const flaky = await run(
      refreshCodex,
      metadata,
      routes({ [TOKEN]: { status: 400, body: "nope" } }),
    );

    expect(flaky.requests).toHaveLength(3);

    const reused = await run(
      refreshCodex,
      metadata,
      routes({ [TOKEN]: { status: 400, body: '{"error":{"code":"refresh_token_reused"}}' } }),
    );

    expect(reused.requests).toHaveLength(1);
    expect(failure(reused.outcome).message).toContain("refresh_token_reused");
  });
});

describe("antigravity", () => {
  const TOKEN = "POST https://oauth2.googleapis.com/token";

  const metadata = {
    type: "antigravity",
    refresh_token: "rt-1",
    access_token: "old",
    project_id: "proj",
  };

  it("posts the Google refresh form and records expiry fields", async () => {
    const { outcome, requests } = await run(
      refreshAntigravity,
      metadata,
      routes({
        [TOKEN]: { body: { access_token: "at-2", expires_in: 3599, token_type: "Bearer" } },
      }),
    );

    expect(requests[0]?.form()).toEqual({
      client_id: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
      client_secret: "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",
      grant_type: "refresh_token",
      refresh_token: "rt-1",
    });
    expect(requests[0]?.headers["user-agent"]).toBe("Go-http-client/2.0");
    expect(success(outcome)).toEqual({
      type: "antigravity",
      refresh_token: "rt-1",
      access_token: "at-2",
      expires_in: 3599,
      timestamp: T0,
      expired: rfc(T0 + 3_599_000),
      project_id: "proj",
    });
  });

  it("rotates the refresh token when returned and reports non-2xx with the status", async () => {
    const rotated = await run(
      refreshAntigravity,
      metadata,
      routes({
        [TOKEN]: { body: { access_token: "at-2", refresh_token: "rt-2", expires_in: 60 } },
      }),
    );

    expect(success(rotated.outcome)).toMatchObject({ refresh_token: "rt-2" });

    const denied = await run(
      refreshAntigravity,
      metadata,
      routes({ [TOKEN]: { status: 400, body: '{"error":"invalid_grant"}' } }),
    );

    expect(failure(denied.outcome)).toMatchObject({ status: 400 });
    const missing = await run(refreshAntigravity, { type: "antigravity" }, routes({}));
    expect(failure(missing.outcome)).toMatchObject({
      status: 401,
      message: "missing refresh token",
    });
  });
});

describe("xai", () => {
  const DISCOVERY = "GET https://auth.x.ai/.well-known/openid-configuration";
  const idToken = jwt({ email: "me@x.ai", sub: "sub-1" });

  const reply = {
    body: {
      access_token: "at-2",
      refresh_token: "rt-2",
      id_token: idToken,
      token_type: "Bearer",
      expires_in: 7200,
    },
  };

  it("discovers the token endpoint, refreshes and parses identity from the id_token", async () => {
    const { outcome, requests } = await run(
      refreshXai,
      { type: "xai", refresh_token: "rt-1", access_token: "old" },
      routes({
        [DISCOVERY]: { body: { token_endpoint: "https://auth.x.ai/oauth2/token" } },
        "POST https://auth.x.ai/oauth2/token": reply,
      }),
    );

    expect(requests.map((request) => request.url)).toEqual([
      "https://auth.x.ai/.well-known/openid-configuration",
      "https://auth.x.ai/oauth2/token",
    ]);
    expect(requests[1]?.form()).toEqual({
      grant_type: "refresh_token",
      client_id: "b1a00492-073a-47ea-816f-4c329264a828",
      refresh_token: "rt-1",
    });
    expect(success(outcome)).toMatchObject({
      type: "xai",
      auth_kind: "oauth",
      access_token: "at-2",
      refresh_token: "rt-2",
      id_token: idToken,
      token_type: "Bearer",
      expires_in: 7200,
      expired: rfc(T0 + 7_200_000),
      email: "me@x.ai",
      sub: "sub-1",
      token_endpoint: "https://auth.x.ai/oauth2/token",
      base_url: "https://api.x.ai/v1",
      last_refresh: rfc(T0),
    });
  });

  it("uses a cached token_endpoint without discovery and ignores a non-x.ai one", async () => {
    const cached = await run(
      refreshXai,
      {
        refresh_token: "rt-1",
        token_endpoint: "https://login.x.ai/token",
        base_url: "https://custom/v1",
      },
      routes({ "POST https://login.x.ai/token": reply }),
    );

    expect(cached.requests).toHaveLength(1);
    expect(success(cached.outcome)).toMatchObject({ base_url: "https://custom/v1" });

    const evil = await run(
      refreshXai,
      { refresh_token: "rt-1", token_endpoint: "https://evil.example/token" },
      routes({
        [DISCOVERY]: { body: { token_endpoint: "https://auth.x.ai/oauth2/token" } },
        "POST https://auth.x.ai/oauth2/token": reply,
      }),
    );

    expect(evil.requests.map((request) => request.url)).not.toContain("https://evil.example/token");
  });

  it("fails with the response body on non-200 and rejects non-x.ai discovery endpoints", async () => {
    const denied = await run(
      refreshXai,
      { refresh_token: "rt-1", token_endpoint: "https://auth.x.ai/t" },
      routes({ "POST https://auth.x.ai/t": { status: 400, body: '{"error":"invalid_grant"}' } }),
    );

    expect(failure(denied.outcome).message).toContain("status 400");

    const bad = await run(
      refreshXai,
      { refresh_token: "rt-1" },
      routes({ [DISCOVERY]: { body: { token_endpoint: "https://evil.example/token" } } }),
    );

    expect(failure(bad.outcome).message).toContain("x.ai");
  });
});

describe("kimi", () => {
  const COM = "POST https://auth.kimi.com/api/oauth/token";
  const AI = "POST https://auth.kimi.ai/api/oauth/token";
  const metadata = { refresh_token: "rt-1", access_token: "old", device_id: "dev-9" };

  it("posts to the domain's OAuth host with the device headers", async () => {
    const { outcome, requests } = await run(
      refreshKimi,
      { ...metadata, type: "kimi" },
      routes({
        [COM]: {
          body: {
            access_token: "at-2",
            refresh_token: "rt-2",
            expires_in: 900.5,
            token_type: "Bearer",
          },
        },
      }),
      { attributes: { domain: "kimi.com", base_url: "https://api.kimi.com/coding" } },
    );

    expect(requests[0]?.form()).toEqual({
      client_id: "17e5f671-d194-4dfb-9706-5516cb48c098",
      grant_type: "refresh_token",
      refresh_token: "rt-1",
    });
    expect(requests[0]?.headers).toMatchObject({
      accept: "application/json",
      "x-msh-platform": "CLIProxyAPI",
      "x-msh-device-id": "dev-9",
    });
    expect(success(outcome)).toMatchObject({
      access_token: "at-2",
      refresh_token: "rt-2",
      expired: rfc(T0 + 900_000),
      domain: "kimi.com",
      base_url: "https://api.kimi.com/coding",
      last_refresh: rfc(T0),
    });
  });

  it("uses auth.kimi.ai for the kimi.ai domain and defaults the type", async () => {
    const { outcome, requests } = await run(
      refreshKimi,
      metadata,
      routes({ [AI]: { body: { access_token: "at-2" } } }),
      { attributes: { domain: "kimi.ai" } },
    );

    expect(requests[0]?.url).toBe("https://auth.kimi.ai/api/oauth/token");
    const written = success(outcome);
    expect(written).toMatchObject({
      type: "kimi-ai",
      refresh_token: "rt-1",
      base_url: "https://api.kimi.ai/coding",
    });
    expect(written.expired).toBeUndefined();
  });

  it("maps 401/403 to a rejected refresh token and requires an access token", async () => {
    const rejected = await run(
      refreshKimi,
      metadata,
      routes({ [COM]: { status: 403, body: "x" } }),
    );

    expect(failure(rejected.outcome)).toMatchObject({
      status: 403,
      message: "kimi: refresh token rejected (status 403)",
    });

    const empty = await run(
      refreshKimi,
      metadata,
      routes({ [COM]: { body: { access_token: "" } } }),
    );

    expect(failure(empty.outcome).message).toContain("empty access token");
  });
});

describe("meta", () => {
  const MINT = "POST https://api.meta.ai/muse-code/key";

  it("META_MINT_URL overrides the mint endpoint; a blank override keeps the default", async () => {
    const metadata = { type: "meta", dca_token: "dca:abc", access_token: "dca:abc" };
    const minted = { body: { api_key: "meta-key" } };

    const overridden = await run(
      refreshMeta,
      metadata,
      routes({ "POST https://mint.example.test/key": minted }),
      {
        metaMintUrl: " https://mint.example.test/key ",
      },
    );

    expect(success(overridden.outcome)).toMatchObject({ api_key: "meta-key" });
    expect(overridden.requests.map((request) => request.url)).toEqual([
      "https://mint.example.test/key",
    ]);

    const blank = await run(refreshMeta, metadata, routes({ [MINT]: minted }), {
      metaMintUrl: "  ",
    });

    expect(success(blank.outcome)).toMatchObject({ api_key: "meta-key" });
    expect(blank.requests.map((request) => request.url)).toEqual([
      "https://api.meta.ai/muse-code/key",
    ]);
  });

  it("mints a provider key from the DCA token and persists the identity fields", async () => {
    const { outcome, requests } = await run(
      refreshMeta,
      {
        type: "meta",
        dca_token: "dca:abc",
        access_token: "dca:abc",
        expired: "2020-01-01T00:00:00Z",
        subs_tier_id: "old",
      },
      routes({
        [MINT]: {
          body: {
            api_key: "meta-key",
            base_url: "https://api.meta.ai/v2",
            user_email: "me@meta.com",
            user_full_name: "Me",
            subs_tier_name: "Pro",
            is_subs_active: true,
          },
        },
      }),
    );

    expect(requests[0]?.json()).toEqual({ dca_token: "dca:abc" });
    expect(requests[0]?.headers).toMatchObject({
      authorization: "Bearer dca:abc",
      "user-agent": "muse-code/1.0.2",
      accept: "application/json",
    });
    const written = success(outcome);
    expect(written).toMatchObject({
      type: "meta",
      api_key: "meta-key",
      access_token: "meta-key",
      dca_token: "dca:abc",
      base_url: "https://api.meta.ai/v2",
      email: "me@meta.com",
      name: "Me",
      subs_tier_name: "Pro",
      is_subs_active: true,
      has_payment_method: false,
      last_refresh: rfc(T0),
    });
    expect(written).not.toHaveProperty("expired");
    expect(written).not.toHaveProperty("subs_tier_id");
  });

  it("reports mint failures and handles missing credentials like Go", async () => {
    const empty = await run(
      refreshMeta,
      { dca_token: "dca:abc" },
      routes({ [MINT]: { body: { api_key: "" } } }),
    );

    expect(failure(empty.outcome).message).toContain("empty key");

    const denied = await run(
      refreshMeta,
      { dca_token: "dca:abc" },
      routes({ [MINT]: { status: 401, body: "bad dca" } }),
    );

    expect(failure(denied.outcome)).toMatchObject({ status: 401 });
    const keyOnly = await run(refreshMeta, { api_key: "k", access_token: "k" }, routes({}));
    expect(success(keyOnly.outcome)).toEqual({ api_key: "k", access_token: "k" });
    const none = await run(refreshMeta, { type: "meta" }, routes({}));
    expect(failure(none.outcome)).toMatchObject({ status: 401 });
  });
});
