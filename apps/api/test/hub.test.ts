// The hub API (ADR 0052) end to end through the API Worker's default export: its three routes' answers in the shape
// allowance readers such as T3 Code read, the management-key-only gate, the visibility rule of a key acting as its
// issuer, the fixed list of relayed calls, and what never leaves (tokens, CORS). Orgs, members, management keys and
// accounts are set up straight through the state Worker's objects; only the providers are mocked, through the global
// `fetch`. Commissary Cloud's rate ceiling on the hub is tested in test/hosted/hub.test.ts.
import { env, exports } from "cloudflare:workers";
import { Effect } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { AuthDirectory, syncOrgIndex } from "@commissary/auth";
import { newOrgId } from "@commissary/core";
import { probeHeaders } from "@commissary/models/testing";
import { controlPlaneOf, platformOf, stateAuthDirectory } from "@commissary/state";
import { addMember, issueKey, type TestMember } from "./support/client.ts";

const ORIGIN = "https://commissary.test";

const CODEX_USAGE = "https://chatgpt.com/backend-api/wham/usage";

const CONSUME = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";

const SUMMARY = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";

const CODEX_TOKEN = "codex-secret-access-token";

const CLAUDE_TOKEN = "sk-ant-oat-alice-secret";

// Effect's FetchHttpClient resolves `globalThis.fetch` once: install one stable fetch that delegates to the current
// test's upstream.
type Upstream = (request: Request) => Response | Promise<Response>;

const ANSWER: Upstream = () => Response.json({ plan_type: "pro" });

let upstream: Upstream = ANSWER;

/** What a provider was sent: the request, and its body read as text when it arrived. */
interface Sent {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body: string;
}

const upstreamCalls: Sent[] = [];

const realFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);

    upstreamCalls.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: await request.clone().text(),
    });

    return await upstream(request);
  };
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  upstreamCalls.length = 0;
  upstream = ANSWER;
});

/** A request to the hub API with the management key `key` (none: no `Authorization`). */
const hub = async (
  path: string,
  key: string | undefined,
  init: RequestInit & { readonly origin?: string } = {},
): Promise<Response> => {
  const headers = new Headers(init.headers);

  if (key !== undefined) headers.set("authorization", `Bearer ${key}`);

  return await exports.default.fetch(
    new Request(`${init.origin ?? ORIGIN}/v0/management${path}`, { ...init, headers }),
  );
};

/** A hub API request body, as allowance readers send it. */
interface HubBody {
  readonly auth_index?: string;
  readonly method?: string;
  readonly url?: string;
  readonly header?: Readonly<Record<string, string>>;
  readonly data?: string;
}

const post = (path: string, key: string | undefined, body: HubBody) =>
  hub(path, key, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

interface AuthFile {
  readonly id: string;
  readonly provider: string;
  readonly auth_index: string;
  readonly email?: string;
  readonly project_id?: string;
  readonly id_token?: { readonly chatgpt_account_id?: string; readonly plan_type?: string };
}

const files = async (key: string): Promise<ReadonlyArray<AuthFile>> => {
  const response = await hub("/auth-files", key);

  expect(response.status).toBe(200);

  return (await response.json<{ files: AuthFile[] }>()).files;
};

const indexOf = async (key: string, id: string): Promise<string> => {
  const found = (await files(key)).find((file) => file.id === id);

  if (found === undefined) throw new Error(`${id} is not listed`);

  return found.auth_index;
};

/** An org with private credentials on, its admin and two members, and their accounts. */
const seededOrg = async () => {
  const slug = `hub-${crypto.randomUUID().slice(0, 8)}`;
  const org = newOrgId();
  const created = await platformOf(env).createOrg({ slug, name: slug, id: org }, Date.now());

  if (!created.ok) throw new Error(created.message);
  const stub = controlPlaneOf(env, org);

  await stub.setMembershipSettings({ privateCredentials: true });

  const admin = await addMember(org, `admin-${slug}@example.com`, "admin");
  const alice = await addMember(org, `alice-${slug}@example.com`, "member");
  const bob = await addMember(org, `bob-${slug}@example.com`, "member");

  await Effect.runPromise(
    syncOrgIndex(org).pipe(Effect.provideService(AuthDirectory, stateAuthDirectory(env))),
  );

  const asAdmin = { member: admin.id, admin: true };
  const models = stub.models();

  await models.importAuthFile(
    "codex.json",
    JSON.stringify({
      type: "codex",
      email: "team@x.com",
      access_token: CODEX_TOKEN,
      refresh_token: "codex-secret-refresh",
      account_id: "acct-1",
      expired: "2999-01-01T00:00:00Z",
    }),
    {},
    asAdmin,
  );

  await models.importAuthFile(
    "antigravity.json",
    JSON.stringify({
      type: "antigravity",
      email: "g@x.com",
      access_token: "ya29.antigravity-secret",
      refresh_token: "antigravity-secret-refresh",
      project_id: "proj-1",
      expired: "2999-01-01T00:00:00Z",
    }),
    {},
    asAdmin,
  );

  await models.importAuthFile(
    "xai-off.json",
    JSON.stringify({
      type: "xai",
      access_token: "xai-secret",
      refresh_token: "xai-secret-refresh",
      expired: "2999-01-01T00:00:00Z",
    }),
    {},
    asAdmin,
  );
  await models.setCredentialDisabled("xai-off.json", true, asAdmin);

  await models.importAuthFile(
    "alice.json",
    JSON.stringify({
      type: "claude",
      email: "alice@x.com",
      access_token: CLAUDE_TOKEN,
      refresh_token: "alice-secret-refresh",
      expired: "2999-01-01T00:00:00Z",
    }),
    {},
    { member: alice.id, admin: false },
  );

  const managementKey = async (role: "member" | "admin" | "owner", issuer?: TestMember) => {
    const issued = await stub.createManagementKey(
      {
        name: "t3",
        role,
        createdBy: "test",
        ...(issuer === undefined ? {} : { ownerEmail: issuer.email }),
      },
      Date.now(),
    );

    if (!issued.ok) throw new Error(issued.message);

    return { id: issued.value.record.id, key: issued.value.key };
  };

  return { org, stub, admin, alice, bob, managementKey };
};

let shared: Awaited<ReturnType<typeof seededOrg>>;

let adminKey: string;

let aliceKey: string;

beforeAll(async () => {
  shared = await seededOrg();
  adminKey = (await shared.managementKey("admin", shared.admin)).key;
  aliceKey = (await shared.managementKey("member", shared.alice)).key;
});

describe("GET /v0/management/auth-files", () => {
  it("lists the accounts the key's issuer manages in full, in Go's shape, without tokens", async () => {
    const listed = await files(adminKey);

    expect(listed.map((file) => file.id).toSorted()).toEqual(["antigravity.json", "codex.json"]);
    expect(listed.find((file) => file.id === "codex.json")).toEqual({
      id: "codex.json",
      provider: "codex",
      auth_index: expect.stringMatching(/^[0-9a-f]{16}$/),
      email: "team@x.com",
      id_token: { chatgpt_account_id: "acct-1" },
    });
    expect(listed.find((file) => file.id === "antigravity.json")).toMatchObject({
      provider: "antigravity",
      project_id: "proj-1",
    });
    expect((await files(aliceKey)).map((file) => file.id)).toEqual(["alice.json"]);

    const text = JSON.stringify([...listed, ...(await files(aliceKey))]);

    expect(text).not.toContain("secret");
    expect(upstreamCalls).toHaveLength(0);
  });

  it("acts as no member for a key nobody issued, and as the issuer's current role", async () => {
    const nobodys = (await shared.managementKey("admin")).key;

    expect((await files(nobodys)).map((file) => file.id).toSorted()).toEqual([
      "antigravity.json",
      "codex.json",
    ]);

    // Bob is a plain member: his admin key reaches no shared account, and he has none of his own.
    const bobs = (await shared.managementKey("admin", shared.bob)).key;

    expect(await files(bobs)).toEqual([]);
  });
});

describe("POST /v0/management/api-call", () => {
  it("relays an allowed call with the headers Commissary builds, none of the caller's", async () => {
    const authIndex = await indexOf(adminKey, "codex.json");

    upstream = () => Response.json({ rate_limit: { primary_window: {} } }, { status: 200 });

    const response = await post("/api-call", adminKey, {
      auth_index: authIndex,
      method: "GET",
      url: CODEX_USAGE,
      header: { Authorization: "Bearer $TOKEN$", "X-Evil": "1", Host: "evil.com" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status_code: 200,
      body: JSON.stringify({ rate_limit: { primary_window: {} } }),
    });

    expect(upstreamCalls).toHaveLength(1);
    const [sent] = upstreamCalls;

    expect(sent?.method).toBe("GET");
    expect(sent?.url).toBe(CODEX_USAGE);

    const expected = await Effect.runPromise(
      probeHeaders({ provider: "codex", token: CODEX_TOKEN, accountId: "acct-1" }),
    );

    for (const [name, value] of Object.entries(expected))
      expect(sent?.headers.get(name), name).toBe(value);
    expect(sent?.headers.get("x-evil")).toBeNull();
    expect(sent?.headers.get("authorization")).toBe(`Bearer ${CODEX_TOKEN}`);
  });

  it("answers an upstream refusal as its status, and redacts the token from any body", async () => {
    const authIndex = await indexOf(adminKey, "codex.json");

    upstream = () =>
      new Response(`{"error":"bad token ${CODEX_TOKEN}","again":"${CODEX_TOKEN}"}`, {
        status: 401,
        headers: { "set-cookie": "upstream=1" },
      });

    const response = await post("/api-call", adminKey, {
      auth_index: authIndex,
      method: "GET",
      url: CODEX_USAGE,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();

    const text = await response.text();

    expect(text).not.toContain(CODEX_TOKEN);
    expect(JSON.parse(text)).toEqual({
      status_code: 401,
      body: '{"error":"bad token [redacted]","again":"[redacted]"}',
    });
  });

  it("relays a redirect as its status, without following it", async () => {
    const authIndex = await indexOf(adminKey, "codex.json");

    upstream = () =>
      new Response(null, { status: 302, headers: { location: "https://evil.com/steal" } });

    const response = await post("/api-call", adminKey, {
      auth_index: authIndex,
      method: "GET",
      url: CODEX_USAGE,
    });

    expect(await response.json()).toEqual({ status_code: 302, body: "" });
    expect(upstreamCalls).toHaveLength(1);
  });

  it("rebuilds a reset credit's redemption from its two fields", async () => {
    const authIndex = await indexOf(adminKey, "codex.json");
    const credit = { redeem_request_id: crypto.randomUUID(), credit_id: "credit-1" };

    const response = await post("/api-call", adminKey, {
      auth_index: authIndex,
      method: "POST",
      url: CONSUME,
      data: JSON.stringify(credit),
    });

    expect(response.status).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0]?.method).toBe("POST");
    expect(JSON.parse(upstreamCalls[0]?.body ?? "")).toEqual(credit);

    const extra = await post("/api-call", adminKey, {
      auth_index: authIndex,
      method: "POST",
      url: CONSUME,
      data: JSON.stringify({ ...credit, amount: 100 }),
    });

    expect(extra.status).toBe(400);
    expect(upstreamCalls).toHaveLength(1);
  });

  it("asks for Antigravity's quota summary with the stored project, whatever the caller sends", async () => {
    const authIndex = await indexOf(adminKey, "antigravity.json");

    const response = await post("/api-call", adminKey, {
      auth_index: authIndex,
      method: "POST",
      url: SUMMARY,
      data: '{"project":"someone-elses"}',
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(upstreamCalls[0]?.body ?? "")).toEqual({ project: "proj-1" });
  });

  it("refuses anything off the list, or for another provider's account, and sends nothing", async () => {
    const codex = await indexOf(adminKey, "codex.json");
    const antigravity = await indexOf(adminKey, "antigravity.json");

    const refused = [
      { auth_index: codex, method: "GET", url: "https://evil.com/backend-api/wham/usage" },
      { auth_index: codex, method: "POST", url: CODEX_USAGE },
      { auth_index: codex, method: "GET", url: `${CODEX_USAGE}?x=1` },
      { auth_index: codex, method: "GET", url: CODEX_USAGE, data: '{"a":1}' },
      { auth_index: antigravity, method: "GET", url: CODEX_USAGE },
      { auth_index: codex, method: "GET", url: "https://api.anthropic.com/api/oauth/usage" },
      { method: "GET", url: CODEX_USAGE },
    ];

    for (const body of refused) {
      const response = await post("/api-call", adminKey, body);

      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.headers.get("content-type")).toContain("application/json");
    }

    expect(upstreamCalls).toHaveLength(0);
  });

  it("does not find a disabled account, another member's, or another org's", async () => {
    const other = await seededOrg();
    const otherKey = (await other.managementKey("admin", other.admin)).key;

    const codexIndex = await indexOf(adminKey, "codex.json");

    // The disabled xAI account is listed nowhere; find its index as the system would and try it.
    const entries = await shared.stub.models().listCredentialEntries({ system: true });
    const found = entries.find((entry) => entry.name === "xai-off.json")?.auth_index;
    const xai = typeof found === "string" ? found : "";
    const alices = await indexOf(aliceKey, "alice.json");

    const missing = [
      [adminKey, xai, "https://cli-chat-proxy.grok.com/v1/billing?format=credits"],
      [adminKey, alices, "https://api.anthropic.com/api/oauth/usage"],
      [otherKey, codexIndex, CODEX_USAGE],
    ] as const;

    for (const [key, authIndex, url] of missing) {
      const response = await post("/api-call", key, { auth_index: authIndex, method: "GET", url });

      expect(response.status, url).toBe(404);
      expect(await response.json()).toEqual({ error: "auth not found" });
    }

    expect(upstreamCalls).toHaveLength(0);

    // Alice's own key reaches her account.
    const own = await post("/api-call", aliceKey, {
      auth_index: alices,
      method: "GET",
      url: "https://api.anthropic.com/api/oauth/usage",
    });

    expect(own.status).toBe(200);
    expect(upstreamCalls[0]?.headers.get("authorization")).toBe(`Bearer ${CLAUDE_TOKEN}`);
  });

  it("answers 502 when the provider cannot be reached or answers too much", async () => {
    const authIndex = await indexOf(adminKey, "codex.json");
    const call = { auth_index: authIndex, method: "GET", url: CODEX_USAGE };

    upstream = () => {
      throw new TypeError("network down");
    };

    expect((await post("/api-call", adminKey, call)).status).toBe(502);

    upstream = () => new Response("x".repeat(1024 * 1024 + 1));
    expect((await post("/api-call", adminKey, call)).status).toBe(502);
  });
});

describe("POST /v0/management/reset-quota", () => {
  it("clears an account's cooldowns, as Go answers it, and finds no other", async () => {
    const authIndex = await indexOf(adminKey, "codex.json");
    const response = await post("/reset-quota", adminKey, { auth_index: authIndex });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", auth_index: authIndex, models: [] });

    const alices = await indexOf(aliceKey, "alice.json");
    const refused = await post("/reset-quota", adminKey, { auth_index: alices });

    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual({ error: "auth not found" });
    expect((await post("/reset-quota", adminKey, {})).status).toBe(400);
  });
});

describe("the hub API's gate", () => {
  it("takes a management key only", async () => {
    const apiKey = (await issueKey(shared.org, shared.alice)).key;

    const refusal = async (response: Response) => ({
      status: response.status,
      body: await response.json(),
    });

    expect(await refusal(await hub("/auth-files", undefined))).toEqual({
      status: 401,
      body: { error: "Missing API key" },
    });
    expect(await refusal(await hub("/auth-files", apiKey))).toEqual({
      status: 401,
      body: { error: "Invalid API key" },
    });
    expect(
      await refusal(
        await hub("/auth-files", undefined, { headers: { "cf-access-jwt-assertion": "a.b.c" } }),
      ),
    ).toEqual({ status: 401, body: { error: "Missing API key" } });
    // The dev bypass of `localhost` (vitest.config.ts) does not apply to the hub API.
    expect(
      await refusal(await hub("/auth-files", undefined, { origin: "http://localhost" })),
    ).toEqual({ status: 401, body: { error: "Missing API key" } });
  });

  it("refuses a revoked key, and a key whose issuer left the org", async () => {
    const revoked = await shared.managementKey("admin", shared.admin);

    await shared.stub.revokeManagementKey(revoked.id);
    expect((await hub("/auth-files", revoked.key)).status).toBe(401);

    const leaving = await addMember(
      shared.org,
      `leaving-${crypto.randomUUID()}@example.com`,
      "admin",
    );

    const left = await shared.managementKey("admin", leaving);

    expect((await hub("/auth-files", left.key)).status).toBe(200);
    await shared.stub.removeMember(leaving.id, { role: "owner", sensitive: true });

    const refused = await hub("/auth-files", left.key);

    expect(refused.status).toBe(403);
    expect(refused.headers.get("content-type")).toContain("application/json");
  });

  it("answers no CORS, no preflight, and refuses a foreign Origin", async () => {
    const answers = [
      await hub("/auth-files", adminKey),
      await hub("/auth-files", adminKey, { method: "OPTIONS" }),
      await hub("/auth-files", undefined),
      await hub("/nope", adminKey),
    ];

    for (const response of answers) {
      expect(response.status).not.toBe(204);

      for (const name of response.headers.keys())
        expect(name.startsWith("access-control-"), name).toBe(false);
    }

    const foreign = await hub("/auth-files", adminKey, {
      headers: { origin: "https://evil.example.com" },
    });

    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toEqual({ error: "Cross-site request rejected" });
  });

  it("answers an unknown hub route with a JSON 404, after the key", async () => {
    const unknown = await hub("/config", adminKey);

    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "Not found" });
    expect((await hub("/config", undefined)).status).toBe(401);
    expect((await hub("/../management/auth-files", undefined)).status).toBe(401);
  });
});
