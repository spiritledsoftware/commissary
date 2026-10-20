// Commissary Cloud's OAuth sign-in for MCP clients (#200), as an MCP client meets it on a stage with one host: the
// API Worker's `401` on `/mcp` names the resource's metadata, which names the app host's authorization server; the
// client registers (dynamically, or with a Client ID Metadata Document behind the outbound guard), sends the member to
// the consent page with PKCE and `resource`, the page starts and approves the sign-in through the management API with
// a tool scope, and the client exchanges and refreshes its code for tokens that stand for the one API key the sign-in
// created, scope included. Revoking that key ends the client's access, its refresh token included. `/mcp` requests go
// to the API Worker's handler (test/worker.ts `API_WORKER_HEADER`), everything else to the app Worker's.
import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetApiKeyCaches } from "@commissary/auth";
import type { ToolScope } from "@commissary/contract/api-keys";
import { fakeMcpServer, serveFakeMcpServers, signInGrants } from "@commissary/tools/testing";
import { API_WORKER_HEADER } from "../worker.ts";
import { call, installFakes, ORIGIN, panelHeaders, restoreFetch, signIn } from "./support.ts";

serveFakeMcpServers();

/** The MCP endpoint as the OAuth server's resource (`MCP_OAUTH_RESOURCE`, vitest.config.ts). */
const RESOURCE = `${ORIGIN}/mcp`;

/** A native client's loopback redirect URI. */
const REDIRECT_URI = "http://127.0.0.1:33418/callback";

/** Where the CIMD client's document is, and the documents the stubbed `fetch` serves. */
const CIMD_URL = "https://client.example.com/oauth/client.json";

const documents = new Map<string, unknown>([
  [
    CIMD_URL,
    {
      client_id: CIMD_URL,
      client_name: "Example Desktop",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  ],
  // Served too, but on an auth host of the deployment, which the outbound guard refuses before any fetch.
  [
    "https://auth.commissary.test/client.json",
    { client_id: "https://auth.commissary.test/client.json" },
  ],
]);

/** The URLs the stub was asked for. */
const fetched: Array<string> = [];

beforeAll(async () => {
  await installFakes();

  // After `serveFakeMcpServers`' own: client metadata documents first, then the fake MCP servers.
  const servers = globalThis.fetch;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const document = documents.get(request.url);

    fetched.push(request.url);

    return document === undefined
      ? await servers(input, init)
      : Response.json(document, { headers: { "cache-control": "no-store" } });
  };
});

afterAll(restoreFetch);

const json = (cookie: string, body: Readonly<Record<string, unknown>>) => ({
  method: "POST",
  headers: panelHeaders(cookie, { "content-type": "application/json" }),
  body: JSON.stringify(body),
});

/** A request to the API Worker (the client API: `/mcp`). */
const apiCall = (
  path: string,
  init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {},
) =>
  exports.default.fetch(
    new Request(`${ORIGIN}${path}`, {
      redirect: "manual",
      ...init,
      headers: { ...init.headers, [API_WORKER_HEADER]: "1" },
    }),
  );

const base64Url = (bytes: ArrayBuffer | Uint8Array): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

/** A PKCE verifier and its S256 challenge. */
const pkce = async () => {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));

  const challenge = base64Url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );

  return { verifier, challenge };
};

/** The query an MCP client sends to the authorization endpoint. */
const authorizeQuery = (options: {
  readonly clientId: string;
  readonly challenge?: string;
  readonly redirectUri?: string;
  readonly resource?: string;
  readonly state?: string;
}): string =>
  `?${new URLSearchParams({
    response_type: "code",
    client_id: options.clientId,
    redirect_uri: options.redirectUri ?? REDIRECT_URI,
    state: options.state ?? "client-state",
    resource: options.resource ?? RESOURCE,
    ...(options.challenge === undefined
      ? {}
      : { code_challenge: options.challenge, code_challenge_method: "S256" }),
  }).toString()}`;

/** `name=value` of each cookie a response sets. */
const cookiesOf = (response: Response): ReadonlyArray<string> =>
  response.headers.getSetCookie().map((cookie) => cookie.split(";")[0] ?? "");

interface Consent {
  readonly kind: "consent";
  readonly handle: string;
  readonly client: Record<string, unknown>;
}

/** Signs a person in and opens their Personal org. */
const member = async (email: string) => {
  const cookie = await signIn({ email });

  const me = await (
    await call("/v9/management/me", { headers: panelHeaders(cookie) })
  ).json<{ orgs: ReadonlyArray<{ slug: string }> }>();

  const slug = me.orgs[0]?.slug;

  if (slug === undefined) throw new Error(`${email} has no org`);

  return { cookie, slug };
};

/** An org toolkit with a read tool and a write tool, connected for everyone. */
const addToolkit = async (cookie: string, slug: string): Promise<string> => {
  const server = fakeMcpServer(`https://mcp-${crypto.randomUUID().slice(0, 8)}.example.com/mcp`, {
    tools: [
      { name: "search_issues", annotations: { readOnlyHint: true } },
      { name: "create_issue" },
    ],
  });

  const added = await call(
    `/v9/management/orgs/${slug}/toolkits`,
    json(cookie, { source: server.url, name: "github" }),
  );

  expect(added.status).toBe(201);
  const { id } = await added.json<{ id: string }>();

  const connected = await call(`/v9/management/orgs/${slug}/toolkits/${id}/credentials/shared`, {
    ...json(cookie, { kind: "bearer", token: "gh-token", subject: { kind: "everyone" } }),
    method: "PUT",
  });

  expect(connected.status).toBe(200);

  return id;
};

/** Registers a client dynamically (RFC 7591). */
const register = async (name: string): Promise<string> => {
  const response = await call("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });

  expect(response.status).toBe(201);

  return (await response.json<{ client_id: string }>()).client_id;
};

const begin = (cookie: string, slug: string, query: string) =>
  call(`/v9/management/orgs/${slug}/mcp-sign-ins`, json(cookie, { query }));

/** Begins a sign-in that asks for consent; the cookies that bind it to the browser. */
const consentFor = async (cookie: string, slug: string, query: string) => {
  const response = await begin(cookie, slug, query);
  const body = await response.json<Consent>();

  expect(response.status, JSON.stringify(body)).toBe(200);
  expect(body.kind).toBe("consent");

  return { ...body, browser: [cookie, ...cookiesOf(response)].join("; ") };
};

/** Approves a consent with `toolScope`; the code the redirect carries. */
const approve = async (
  slug: string,
  consent: { readonly handle: string; readonly browser: string },
  toolScope: ToolScope | null,
) => {
  const response = await call(
    `/v9/management/orgs/${slug}/mcp-sign-ins/approve`,
    json(consent.browser, { handle: consent.handle, tool_scope: toolScope }),
  );

  const body = await response.json<{ redirect_to: string }>();

  expect(response.status, JSON.stringify(body)).toBe(200);

  return new URL(body.redirect_to);
};

const tokenRequest = (form: Record<string, string>) =>
  call("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });

interface Tokens {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly token_type: string;
}

/** `tools/list` on `/mcp` with `token`. */
const toolsListCall = (token: string) =>
  apiCall("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/list",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });

/** `tools/list` on `/mcp` with `token`: the HTTP status and the tool names. */
const listTools = async (token: string) => {
  const response = await toolsListCall(token);
  const body = await response.json<{ result?: { tools: ReadonlyArray<{ name: string }> } }>();

  return { status: response.status, tools: body.result?.tools.map((tool) => tool.name) };
};

interface KeyView {
  readonly id: string;
  readonly name: string;
  readonly revoked_at?: string;
  readonly tool_scope?: unknown;
}

const keysOf = async (cookie: string, slug: string): Promise<ReadonlyArray<KeyView>> =>
  (
    await (
      await call(`/v9/management/orgs/${slug}/api-keys`, { headers: panelHeaders(cookie) })
    ).json<{ keys: ReadonlyArray<KeyView> }>()
  ).keys;

describe("discovery", () => {
  it("leads an MCP client from a 401 on /mcp to the authorization server on the app host", async () => {
    const refused = await apiCall("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
    await refused.body?.cancel();

    // The resource's metadata: on the app host of a stage with one host, and from the API Worker too.
    for (const fetchMetadata of [call, apiCall]) {
      const metadata = await fetchMetadata("/.well-known/oauth-protected-resource/mcp");

      expect(metadata.status).toBe(200);
      expect(await metadata.json()).toMatchObject({
        resource: RESOURCE,
        authorization_servers: [ORIGIN],
      });
    }

    const server = await call("/.well-known/oauth-authorization-server");

    expect(server.status).toBe(200);
    expect(await server.json()).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
    });
  });

  it("sends a browser without a session from the consent page to the sign-in page, and back", async () => {
    const query = authorizeQuery({ clientId: "any", challenge: "x".repeat(43) });
    const page = await call(`/authorize${query}`);

    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe(
      `/sign-in?next=${encodeURIComponent(`/authorize${query}`)}`,
    );
  });
});

describe("a sign-in", () => {
  it("issues one API key named after the client, with the member's tool scope, until the key is revoked", async () => {
    const { cookie, slug } = await member("oauth-flow@example.com");
    const toolkit = await addToolkit(cookie, slug);
    const clientId = await register("Claude Code");
    const { verifier, challenge } = await pkce();

    const consent = await consentFor(cookie, slug, authorizeQuery({ clientId, challenge }));

    expect(consent.client).toMatchObject({
      client_id: clientId,
      client_name: "Claude Code",
      redirect_host: "127.0.0.1",
      redirect_is_loopback: true,
    });
    expect(consent.client).not.toHaveProperty("client_domain");

    const redirect = await approve(slug, consent, [{ toolkit, tools: { kind: "read" } }]);

    expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT_URI);
    expect(redirect.searchParams.get("state")).toBe("client-state");
    expect(redirect.searchParams.get("iss")).toBe(ORIGIN);
    const code = redirect.searchParams.get("code") ?? "";

    // Exactly one key, named after the client, with the scope.
    const keys = (await keysOf(cookie, slug)).filter((key) => key.name === "Claude Code");

    expect(keys).toHaveLength(1);
    expect(keys[0]?.tool_scope).toEqual([{ toolkit, tools: { kind: "read" } }]);

    const exchanged = await tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
      resource: RESOURCE,
    });

    expect(exchanged.status).toBe(200);
    const tokens = await exchanged.json<Tokens>();

    expect(tokens.token_type.toLowerCase()).toBe("bearer");
    expect(tokens.access_token.startsWith("cms_")).toBe(false);

    // The token stands for the key: its scope applies.
    expect(await listTools(tokens.access_token)).toEqual({
      status: 200,
      tools: ["github_search_issues"],
    });

    const refreshed = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
      resource: RESOURCE,
    });

    expect(refreshed.status).toBe(200);
    const fresh = await refreshed.json<Tokens>();

    expect((await listTools(fresh.access_token)).tools).toEqual(["github_search_issues"]);

    // Revoking the key ends the client's access, its refresh token included.
    const revoked = await call(`/v9/management/orgs/${slug}/api-keys/${keys[0]?.id ?? ""}`, {
      method: "DELETE",
      headers: panelHeaders(cookie),
    });

    expect(revoked.status).toBe(200);
    resetApiKeyCaches();

    expect((await listTools(fresh.access_token)).status).toBe(401);

    const refused = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: fresh.refresh_token,
      client_id: clientId,
      resource: RESOURCE,
    });

    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("replaces the member's earlier sign-in of the same client, whose key is revoked", async () => {
    const { cookie, slug } = await member("oauth-again@example.com");
    const clientId = await register("Cursor");

    const signedIn = async () => {
      const { verifier, challenge } = await pkce();
      const consent = await consentFor(cookie, slug, authorizeQuery({ clientId, challenge }));
      const code = (await approve(slug, consent, null)).searchParams.get("code") ?? "";

      const exchanged = await tokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: verifier,
        resource: RESOURCE,
      });

      expect(exchanged.status).toBe(200);

      return await exchanged.json<Tokens>();
    };

    const first = await signedIn();

    // Used once, so the gate's verified-key cache knows the first key when the second sign-in revokes it.
    expect((await listTools(first.access_token)).status).toBe(200);

    const second = await signedIn();
    const keys = (await keysOf(cookie, slug)).filter((key) => key.name === "Cursor");

    // The first sign-in's key is revoked (lists leave revoked keys out): one key per client.
    expect(keys).toHaveLength(1);

    // At once, with the gate's caches still warm: the replaced grant's tokens are gone with it.
    expect((await listTools(first.access_token)).status).toBe(401);
    expect((await listTools(second.access_token)).status).toBe(200);
  });

  it("of a CIMD client shows its domain, fetches its document through the outbound guard, and can be denied", async () => {
    const { cookie, slug } = await member("oauth-cimd@example.com");
    const { challenge } = await pkce();

    const consent = await consentFor(
      cookie,
      slug,
      authorizeQuery({ clientId: CIMD_URL, challenge, state: "cimd-state" }),
    );

    expect(consent.client).toMatchObject({
      client_id: CIMD_URL,
      client_name: "Example Desktop",
      client_domain: "client.example.com",
    });
    expect(fetched).toContain(CIMD_URL);

    const denied = await call(
      `/v9/management/orgs/${slug}/mcp-sign-ins/deny`,
      json(consent.browser, { handle: consent.handle }),
    );

    expect(denied.status).toBe(200);
    const to = new URL((await denied.json<{ redirect_to: string }>()).redirect_to);

    expect(to.searchParams.get("error")).toBe("access_denied");
    expect(to.searchParams.get("state")).toBe("cimd-state");

    // Answered once: the handle is spent, and no key was issued.
    const again = await call(
      `/v9/management/orgs/${slug}/mcp-sign-ins/approve`,
      json(consent.browser, { handle: consent.handle, tool_scope: null }),
    );

    expect(again.status).toBe(422);
    await again.body?.cancel();
    expect(await keysOf(cookie, slug)).toEqual([]);
  });

  it("of a CIMD client issues tokens to its URL as client id, with the member's tool scope, and refreshes them", async () => {
    const { cookie, slug } = await member("oauth-cimd-approve@example.com");
    const toolkit = await addToolkit(cookie, slug);
    const { verifier, challenge } = await pkce();
    const query = authorizeQuery({ clientId: CIMD_URL, challenge });
    const consent = await consentFor(cookie, slug, query);
    const redirect = await approve(slug, consent, [{ toolkit, tools: { kind: "read" } }]);

    expect(`${redirect.origin}${redirect.pathname}`).toBe(REDIRECT_URI);

    const keys = (await keysOf(cookie, slug)).filter((key) => key.name === "Example Desktop");

    expect(keys).toHaveLength(1);
    expect(keys[0]?.tool_scope).toEqual([{ toolkit, tools: { kind: "read" } }]);

    const exchanged = await tokenRequest({
      grant_type: "authorization_code",
      code: redirect.searchParams.get("code") ?? "",
      redirect_uri: REDIRECT_URI,
      client_id: CIMD_URL,
      code_verifier: verifier,
      resource: RESOURCE,
    });

    expect(exchanged.status).toBe(200);
    const tokens = await exchanged.json<Tokens>();

    expect(await listTools(tokens.access_token)).toEqual({
      status: 200,
      tools: ["github_search_issues"],
    });

    const refreshed = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: CIMD_URL,
      resource: RESOURCE,
    });

    expect(refreshed.status).toBe(200);
    expect((await listTools((await refreshed.json<Tokens>()).access_token)).tools).toEqual([
      "github_search_issues",
    ]);
  });

  it("is refused for a CIMD document on a host the outbound guard refuses, without fetching it", async () => {
    const { cookie, slug } = await member("oauth-guard@example.com");
    const { challenge } = await pkce();
    const url = "https://auth.commissary.test/client.json";

    const response = await begin(cookie, slug, authorizeQuery({ clientId: url, challenge }));

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "sign_in_refused" });
    expect(fetched).not.toContain(url);
  });

  it("is refused for a redirect URI the client did not register, shown on the page", async () => {
    const { cookie, slug } = await member("oauth-redirect@example.com");
    const clientId = await register("Elsewhere");
    const { challenge } = await pkce();

    const response = await begin(
      cookie,
      slug,
      authorizeQuery({ clientId, challenge, redirectUri: "https://evil.example.com/callback" }),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "sign_in_refused" });
  });

  it("answers the client without PKCE, or for another resource, with an error redirect", async () => {
    const { cookie, slug } = await member("oauth-pkce@example.com");
    const clientId = await register("No PKCE");
    const { challenge } = await pkce();

    for (const [query, error] of [
      [authorizeQuery({ clientId }), "invalid_request"],
      [
        authorizeQuery({ clientId, challenge, resource: "https://other.example.com/mcp" }),
        "invalid_target",
      ],
    ] as const) {
      const response = await begin(cookie, slug, query);
      const body = await response.json<{ kind: string; redirect_to: string }>();

      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(body.kind).toBe("redirect");
      expect(new URL(body.redirect_to).searchParams.get("error")).toBe(error);
    }

    expect(await keysOf(cookie, slug)).toEqual([]);
  });

  it("exchanges a code only with its verifier and for the MCP endpoint, and takes no token of no grant", async () => {
    const { cookie, slug } = await member("oauth-exchange@example.com");
    const clientId = await register("Exchange");
    const { verifier, challenge } = await pkce();
    const consent = await consentFor(cookie, slug, authorizeQuery({ clientId, challenge }));
    const code = (await approve(slug, consent, null)).searchParams.get("code") ?? "";

    for (const [field, value] of [
      ["code_verifier", "a".repeat(43)],
      ["resource", "https://other.example.com/mcp"],
    ] as const) {
      const refused = await tokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: verifier,
        resource: RESOURCE,
        [field]: value,
      });

      expect(refused.status, field).toBe(400);
      await refused.body?.cancel();
    }

    expect((await listTools(`${slug}/member:grant:secret`)).status).toBe(401);
  });
});

describe("an access token", () => {
  /** A token of the OAuth server for `resource` (on the stage's KV), standing for a live API key of a member. */
  const tokenFor = async (resource: string) => {
    const { cookie, slug } = await member(`oauth-token-${crypto.randomUUID()}@example.com`);

    const issued = await call(
      `/v9/management/orgs/${slug}/api-keys`,
      json(cookie, { name: "laptop" }),
    );

    expect(issued.status).toBe(201);
    const { key } = await issued.json<{ key: string }>();

    if (env.OAUTH_KV === undefined) throw new Error("OAUTH_KV is not bound (vitest.config.ts)");

    return await signInGrants({ issuer: ORIGIN, resource, kv: env.OAUTH_KV }).accessToken(
      slug,
      "member",
      key,
    );
  };

  it("of another resource is refused on /mcp like a bad key, with the challenge", async () => {
    // The same token for the MCP endpoint stands for the key.
    expect((await listTools(await tokenFor(RESOURCE))).status).toBe(200);

    const refused = await toolsListCall(await tokenFor("https://other.example.com/mcp"));

    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
    await refused.body?.cancel();
  });

  it("stands for its key on /mcp only: the rest of the client API refuses it", async () => {
    const token = await tokenFor(RESOURCE);
    const models = await apiCall("/v1/models", { headers: { authorization: `Bearer ${token}` } });

    expect(models.status).toBe(401);
    await models.body?.cancel();
  });
});
