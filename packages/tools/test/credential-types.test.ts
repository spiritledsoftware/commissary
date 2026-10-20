// The credential types of #206 through the Tools part over RPC, against fake HTTP APIs, token endpoints and MCP servers
// served in workerd: OAuth 1.0a and NetSuite TBA signatures on each request, AWS SigV4, compound secrets placed by the
// toolkit's template (headers, query, base URL), a JWT sent as a bearer and one exchanged at a token endpoint (RFC
// 7523), a GitHub App's installation token, and an RFC 8693 token exchange: tokens cached until near their expiry,
// minted again then and on a `401`, a refused exchange marking the credential as needing to be connected again, and
// settings a credential needs refused when missing. `TestClock` drives the time the Tools part reads.
import { env, runInDurableObject } from "cloudflare:test";
import { type Duration, Effect } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import type { CredentialSettings } from "@commissary/contract/tools";
import type { AddToolkitInput } from "../src/control-plane-part.ts";
import { hmac, percentEncode, sha256Hex } from "../src/signing/encoding.ts";
import { signatureBaseString } from "../src/signing/oauth1.ts";
import { sigV4Authorization } from "../src/signing/sigv4.ts";
import { fakeHttpServer, type RecordedHttpRequest } from "./support/http-server.ts";
import {
  fakeMcpServer,
  type RecordedMcpRequest,
  serveFakeMcpServers,
} from "./support/mcp-server.ts";

serveFakeMcpServers();

const POLICY = { ownHosts: [], localDevelopment: false };

const ADMIN = { member: "m-admin", admin: true };

const ALICE = { member: "m-alice", admin: false };

const EVERYONE = { kind: "everyone" as const };

/** An org's ControlPlane whose Tools part reads the time from a `TestClock` at the real time. */
const planeWithClock = async () => {
  const stub = env.CONTROL_PLANE.getByName(crypto.randomUUID());
  const clock = await Effect.runPromise(Effect.scoped(TestClock.make()));

  await Effect.runPromise(clock.setTime(Date.now()));
  await runInDurableObject(stub, (instance) => instance.tools().useClock(clock));
  await stub.setMembershipSettings({ privateCredentials: true, privateToolkits: true });

  return {
    stub,
    adjust: (duration: Duration.Input) => Effect.runPromise(clock.adjust(duration)),
    now: () => clock.currentTimeMillisUnsafe(),
  };
};

type Stub = Awaited<ReturnType<typeof planeWithClock>>["stub"];

const origin = (name: string) => `https://${name}-${crypto.randomUUID().slice(0, 8)}.example.com`;

/** A 3.1 document with one `GET /ping` and one `POST /items` (a form body), served from `server`. */
const documentOf = (server: string) =>
  JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Ops", version: "1" },
    servers: [{ url: server }],
    paths: {
      "/ping": { get: { operationId: "ping", parameters: [{ name: "q", in: "query" }] } },
      "/files": {
        post: {
          operationId: "upload",
          requestBody: {
            content: {
              "multipart/form-data": {
                schema: { type: "object", properties: { note: { type: "string" } } },
              },
            },
          },
        },
      },
      "/items": {
        post: {
          operationId: "add",
          requestBody: {
            content: {
              "application/x-www-form-urlencoded": {
                schema: { type: "object", properties: { name: { type: "string" } } },
              },
            },
          },
        },
      },
    },
  });

/** An OpenAPI toolkit of `server`'s document with `credential` connected as its shared credential. */
const openApi = async (
  stub: Stub,
  server: string,
  credential: AddToolkitInput["credential"],
  credentialSettings?: CredentialSettings,
) => {
  const added = await stub.tools().addToolkit(
    ADMIN,
    {
      kind: "openapi",
      source: "",
      document: documentOf(server),
      name: "ops",
      private: false,
      accepts: "shared",
      credential,
      credentialSettings,
    },
    "test",
    POLICY,
  );

  if (!added.ok) throw new Error(`add failed: ${added.message}`);

  return added.value;
};

/** The toolkit `id` as `viewer` sees it in the list. */
const viewOf = async (stub: Stub, viewer: typeof ADMIN, id: string) => {
  const listed = await stub.tools().listToolkits(viewer);

  return { ok: true, value: listed.toolkits.find((toolkit) => toolkit.id === id) };
};

const ping = (stub: Stub, args: Readonly<Record<string, string>> = { q: "hello world" }) =>
  stub.tools().callTool(ALICE, { name: "ops_ping", arguments: args }, POLICY);

const ok = () => Response.json({ pong: true });

/** The decoded parameters of an `Authorization: OAuth` header, and its realm. */
const oauthHeader = (request: RecordedHttpRequest): Record<string, string> => {
  const header = request.headers.get("authorization") ?? "";

  expect(header.startsWith("OAuth ")).toBe(true);

  return Object.fromEntries(
    header
      .slice(6)
      .split(", ")
      .map((part) => {
        const equals = part.indexOf("=");

        return [part.slice(0, equals), decodeURIComponent(part.slice(equals + 2, -1))];
      }),
  );
};

/** Whether `request` carries a valid OAuth 1.0a signature under the two secrets. */
const oauthSigned = (
  request: RecordedHttpRequest,
  consumerSecret: string,
  tokenSecret: string,
): boolean => {
  const { oauth_signature: signature, realm: _realm, ...oauth } = oauthHeader(request);

  const form =
    request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded") === true
      ? [...new URLSearchParams(request.body)]
      : [];

  const base = signatureBaseString(request.method, request.url.toString(), form, oauth);
  const hash = oauth.oauth_signature_method === "HMAC-SHA256" ? "sha256" : "sha1";

  return (
    hmac(hash, `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`, base).toString(
      "base64",
    ) === signature
  );
};

describe("OAuth 1.0a", () => {
  it("signs each call with HMAC-SHA1 by default, a form body's parameters included", async () => {
    const { stub } = await planeWithClock();
    const api = fakeHttpServer(origin("api"), ok);

    await openApi(stub, api.origin, {
      kind: "oauth1",
      consumer_key: "ck",
      consumer_secret: "cs",
      token: "tk",
      token_secret: "ts",
      subject: EVERYONE,
    });

    expect(await ping(stub)).toMatchObject({ outcome: "result" });

    expect(
      await stub
        .tools()
        .callTool(ALICE, { name: "ops_add", arguments: { body: { name: "a b" } } }, POLICY),
    ).toMatchObject({ outcome: "result" });

    const [get, post] = api.requests;

    expect(get && oauthHeader(get)).toMatchObject({
      oauth_consumer_key: "ck",
      oauth_token: "tk",
      oauth_signature_method: "HMAC-SHA1",
      oauth_version: "1.0",
    });
    expect(get && oauthSigned(get, "cs", "ts")).toBe(true);
    expect(post?.body).toBe("name=a+b");
    expect(post && oauthSigned(post, "cs", "ts")).toBe(true);
    // Each request has its own nonce.
    expect(get && post && oauthHeader(get).oauth_nonce).not.toBe(
      post && oauthHeader(post).oauth_nonce,
    );
  });

  it("signs with the toolkit's signature method and realm", async () => {
    const { stub } = await planeWithClock();
    const api = fakeHttpServer(origin("api"), ok);

    await openApi(
      stub,
      api.origin,
      {
        kind: "oauth1",
        consumer_key: "ck",
        consumer_secret: "cs",
        token: "tk",
        token_secret: "ts",
        subject: EVERYONE,
      },
      { oauth1: { signature_method: "HMAC-SHA256", realm: "Photos" } },
    );

    await ping(stub);

    const [request] = api.requests;

    expect(request?.headers.get("authorization")).toMatch(/^OAuth realm="Photos", /);
    expect(request && oauthHeader(request).oauth_signature_method).toBe("HMAC-SHA256");
    expect(request && oauthSigned(request, "cs", "ts")).toBe(true);
  });
});

describe("an OAuth 1.0a sign-in", () => {
  /** A fake OAuth 1.0a service: its temporary credential and token endpoints, checking each request's signature. */
  const oauth1Service = () => {
    const callbacks: Array<string> = [];

    const service = fakeHttpServer(origin("oauth1"), (request) => {
      const params = oauthHeader(request);

      if (request.url.pathname === "/request_token") {
        if (!oauthSigned(request, "cs", "")) return new Response("bad signature", { status: 401 });
        callbacks.push(params.oauth_callback ?? "");

        return new Response(
          "oauth_token=temp&oauth_token_secret=temp-secret&oauth_callback_confirmed=true",
          {
            headers: { "content-type": "application/x-www-form-urlencoded" },
          },
        );
      }

      if (
        request.url.pathname !== "/access_token" ||
        params.oauth_token !== "temp" ||
        params.oauth_verifier !== "v-1" ||
        !oauthSigned(request, "cs", "temp-secret")
      )
        return new Response("refused", { status: 401 });

      return new Response("oauth_token=granted&oauth_token_secret=granted-secret", {
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
    });

    return { service, callbacks };
  };

  const CALLBACK = "https://app.example.com/oauth/toolkits/callback";

  const signIn = async (stub: Stub, toolkitId: string, serviceOrigin: string) => {
    expect(
      await stub.tools().setOAuthApp(
        ADMIN,
        toolkitId,
        {
          client_id: "ck",
          client_secret: "cs",
          authorize_url: `${serviceOrigin}/authorize`,
          token_url: `${serviceOrigin}/access_token`,
          request_token_url: `${serviceOrigin}/request_token`,
        },
        "test",
      ),
    ).toMatchObject({
      ok: true,
      value: { oauth_app: { request_token_url: `${serviceOrigin}/request_token` } },
    });

    const started = await stub
      .tools()
      .startSignIn(ADMIN, toolkitId, "shared", { subject: EVERYONE }, "test", POLICY, {
        callback: CALLBACK,
        clientId: undefined,
      });

    if (!started.ok) throw new Error(`sign-in failed: ${started.message}`);

    return started.value;
  };

  it("gets temporary credentials, and token credentials for the callback's verifier, which sign each call", async () => {
    const { stub } = await planeWithClock();
    const { service, callbacks } = oauth1Service();
    const api = fakeHttpServer(origin("api"), ok);
    const toolkit = await openApi(stub, api.origin, undefined);
    const started = await signIn(stub, toolkit.id, service.origin);
    const authorize = new URL(started.url);

    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${service.origin}/authorize`);
    expect(authorize.searchParams.get("oauth_token")).toBe("temp");

    // The callback names the sign-in's state, so it reaches its org and sign-in.
    const back = new URL(callbacks[0] ?? "");

    expect(`${back.origin}${back.pathname}`).toBe(CALLBACK);
    expect(back.searchParams.get("state")).toBe(started.state);

    expect(
      await stub.tools().completeSignIn(
        {
          state: started.state,
          code: "",
          error: "",
          iss: undefined,
          member: ADMIN.member,
          oauthToken: "temp",
          oauthVerifier: "v-1",
        },
        POLICY,
      ),
    ).toEqual({ outcome: "completed" });
    expect(await stub.tools().signInStatus(ADMIN, toolkit.id, started.state)).toEqual({
      ok: true,
      value: { status: "ok" },
    });

    expect(await ping(stub)).toMatchObject({ outcome: "result" });

    const [call] = api.requests;

    expect(call && oauthHeader(call)).toMatchObject({
      oauth_consumer_key: "ck",
      oauth_token: "granted",
    });
    expect(call && oauthSigned(call, "cs", "granted-secret")).toBe(true);

    const view = await viewOf(stub, ADMIN, toolkit.id);

    expect(view).toMatchObject({ value: { credentials: { shared: { kind: "oauth1" } } } });
    expect(JSON.stringify(view)).not.toContain("granted");
  });

  it("fails when the callback names another token", async () => {
    const { stub } = await planeWithClock();
    const { service } = oauth1Service();
    const api = fakeHttpServer(origin("api"), ok);
    const toolkit = await openApi(stub, api.origin, undefined);
    const started = await signIn(stub, toolkit.id, service.origin);

    expect(
      await stub.tools().completeSignIn(
        {
          state: started.state,
          code: "",
          error: "",
          iss: undefined,
          member: ADMIN.member,
          oauthToken: "other",
          oauthVerifier: "v-1",
        },
        POLICY,
      ),
    ).toEqual({ outcome: "failed" });
    expect(await stub.tools().signInStatus(ADMIN, toolkit.id, started.state)).toMatchObject({
      value: { status: "error" },
    });
  });

  it("needs the consumer's secret", async () => {
    const { stub } = await planeWithClock();
    const api = fakeHttpServer(origin("api"), ok);
    const toolkit = await openApi(stub, api.origin, undefined);

    expect(
      await stub.tools().setOAuthApp(
        ADMIN,
        toolkit.id,
        {
          client_id: "ck",
          authorize_url: "https://example.com/authorize",
          token_url: "https://example.com/access_token",
          request_token_url: "https://example.com/request_token",
        },
        "test",
      ),
    ).toMatchObject({ ok: false, error: "invalid" });
  });
});

describe("NetSuite token-based auth", () => {
  const tba = {
    kind: "tba" as const,
    consumer_key: "ck",
    consumer_secret: "cs",
    token_id: "tid",
    token_secret: "ts",
    subject: EVERYONE,
  };

  it("needs the toolkit's account", async () => {
    const { stub } = await planeWithClock();
    const api = fakeHttpServer(origin("api"), ok);

    const added = await stub.tools().addToolkit(
      ADMIN,
      {
        kind: "openapi",
        source: "",
        document: documentOf(api.origin),
        name: "ops",
        private: false,
        accepts: "shared",
        credential: tba,
      },
      "test",
      POLICY,
    );

    expect(added).toMatchObject({ ok: false, error: "invalid" });
  });

  it("signs with HMAC-SHA256 and the account as the realm", async () => {
    const { stub } = await planeWithClock();
    const api = fakeHttpServer(origin("api"), ok);

    await openApi(stub, api.origin, tba, { tba: { account_id: "1234567_SB1" } });
    await ping(stub);

    const [request] = api.requests;

    expect(request?.headers.get("authorization")).toMatch(/^OAuth realm="1234567_SB1", /);
    expect(request && oauthHeader(request)).toMatchObject({
      oauth_consumer_key: "ck",
      oauth_token: "tid",
      oauth_signature_method: "HMAC-SHA256",
    });
    expect(request && oauthSigned(request, "cs", "ts")).toBe(true);
  });
});

describe("MCP sessions", () => {
  it("signs the DELETE that ends a session, as every request", async () => {
    const { stub } = await planeWithClock();

    const recorded = (request: Request | RecordedMcpRequest): RecordedHttpRequest => ({
      method: request.method,
      url: new URL(request.url),
      headers: request.headers,
      body: "",
    });

    const mcp = fakeMcpServer(`${origin("mcp")}/mcp`, {
      tools: [{ name: "echo" }],
      authorized: (request) => request.headers.get("authorization")?.startsWith("OAuth ") === true,
    });

    const added = await stub.tools().addToolkit(
      ADMIN,
      {
        source: mcp.url,
        name: "kit",
        private: false,
        accepts: "shared",
        credential: {
          kind: "oauth1",
          consumer_key: "ck",
          consumer_secret: "cs",
          token: "tk",
          token_secret: "ts",
          subject: EVERYONE,
        },
      },
      "test",
      POLICY,
    );

    expect(added).toMatchObject({ ok: true, value: { tool_list: { tools: 1 } } });

    const ended = mcp.requests.filter((request) => request.method === "DELETE");

    expect(ended).toHaveLength(1);
    expect(ended.every((request) => oauthSigned(recorded(request), "cs", "ts"))).toBe(true);
  });
});

const AWS_KEYS = {
  accessKeyId: "AKID",
  secretAccessKey: "secret",
  region: "eu-west-1",
  service: "execute-api",
};

/** The `Authorization` header SigV4 gives `request` as the server received it, with the AWS keys. */
const sigV4Of = (request: RecordedHttpRequest | undefined, signed: ReadonlyArray<string>) => {
  const headers = request?.headers ?? new Headers();
  const amzDate = headers.get("x-amz-date") ?? "";

  return sigV4Authorization(
    {
      method: request?.method ?? "",
      path: request?.url.pathname ?? "",
      query: request?.url.search.slice(1) ?? "",
      headers: Object.fromEntries(
        signed.map((name) => [
          name,
          name === "host" ? (request?.url.host ?? "") : (headers.get(name) ?? ""),
        ]),
      ),
      payloadHash: headers.get("x-amz-content-sha256") ?? "",
    },
    AWS_KEYS,
    amzDate,
  );
};

/** An OpenAPI toolkit at `api` with AWS keys connected. */
const awsToolkit = (stub: Stub, api: string) =>
  openApi(
    stub,
    api,
    {
      kind: "aws_sigv4",
      access_key_id: "AKID",
      secret_access_key: "secret",
      session_token: "session",
      subject: EVERYONE,
    },
    { aws_sigv4: { region: "eu-west-1", service: "execute-api" } },
  );

describe("AWS SigV4", () => {
  it("signs each call for the toolkit's region and service, with the session token", async () => {
    const { stub } = await planeWithClock();
    const api = fakeHttpServer(origin("api"), ok);

    await awsToolkit(stub, api.origin);

    expect(await ping(stub)).toMatchObject({ outcome: "result" });

    const [request] = api.requests;
    const headers = request?.headers ?? new Headers();
    const amzDate = headers.get("x-amz-date") ?? "";

    expect(amzDate).toMatch(/^\d{8}T\d{6}Z$/);
    expect(headers.get("x-amz-security-token")).toBe("session");
    expect(headers.get("authorization")).toBe(
      sigV4Of(request, ["host", "x-amz-date", "x-amz-content-sha256", "x-amz-security-token"]),
    );
    expect(headers.get("authorization")).toContain(
      `Credential=AKID/${amzDate.slice(0, 8)}/eu-west-1/execute-api/aws4_request`,
    );
  });

  it("sends the query as it signs it: a space as %20, a plus as %2B", async () => {
    const { stub } = await planeWithClock();
    const api = fakeHttpServer(origin("api"), ok);

    await awsToolkit(stub, api.origin);
    await ping(stub, { q: "a+b c/d" });

    const [request] = api.requests;

    expect(request?.url.search).toBe("?q=a%2Bb%20c%2Fd");
    expect(request?.headers.get("authorization")).toBe(
      sigV4Of(request, ["host", "x-amz-date", "x-amz-content-sha256", "x-amz-security-token"]),
    );
  });

  it("hashes a multipart body as it is sent", async () => {
    const { stub } = await planeWithClock();
    const api = fakeHttpServer(origin("api"), ok);

    await awsToolkit(stub, api.origin);

    expect(
      await stub
        .tools()
        .callTool(ALICE, { name: "ops_upload", arguments: { body: { note: "hi" } } }, POLICY),
    ).toMatchObject({ outcome: "result" });

    const [request] = api.requests;
    const headers = request?.headers ?? new Headers();

    expect(headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
    expect(request?.body).toContain("hi");
    expect(headers.get("x-amz-content-sha256")).toBe(sha256Hex(request?.body ?? ""));
    expect(headers.get("authorization")).toBe(
      sigV4Of(request, [
        "content-type",
        "host",
        "x-amz-date",
        "x-amz-content-sha256",
        "x-amz-security-token",
      ]),
    );
  });
});

describe("compound secrets", () => {
  it("places the credential's fields by the toolkit's template: headers, the query and the base URL", async () => {
    const { stub } = await planeWithClock();
    const account = `acct${crypto.randomUUID().slice(0, 6)}`;
    const api = fakeHttpServer(`https://${account}.example.com`, ok);

    await openApi(
      stub,
      "https://unused.example.com",
      {
        kind: "compound",
        fields: { account_id: account, key: "k-1", secret: "s-1" },
        subject: EVERYONE,
      },
      {
        compound: {
          headers: { Authorization: "Key {key}:{secret}" },
          query: { account: "{account_id}" },
          base_url: "https://{account_id}.example.com/v2",
        },
      },
    );

    expect(await ping(stub)).toMatchObject({ outcome: "result" });

    const [request] = api.requests;

    expect(request?.url.pathname).toBe("/v2/ping");
    expect(request?.url.searchParams.get("account")).toBe(account);
    expect(request?.headers.get("authorization")).toBe("Key k-1:s-1");
  });

  it("is refused without a field its template names", async () => {
    const { stub } = await planeWithClock();
    const api = fakeHttpServer(origin("api"), ok);

    const toolkit = await openApi(
      stub,
      api.origin,
      { kind: "none", subject: EVERYONE },
      {
        compound: { headers: { "x-api-key": "{key}" } },
      },
    );

    expect(
      await stub
        .tools()
        .connectCredential(
          ADMIN,
          toolkit.id,
          "shared",
          { kind: "compound", fields: { other: "x" }, subject: EVERYONE },
          "test",
          POLICY,
        ),
    ).toMatchObject({ ok: false, error: "invalid" });
  });

  it("sends its headers to an MCP server", async () => {
    const { stub } = await planeWithClock();

    const mcp = fakeMcpServer(`${origin("mcp")}/mcp`, {
      tools: [{ name: "echo" }],
      authorized: (request) => request.headers.get("x-api-key") === "k-1",
    });

    const added = await stub.tools().addToolkit(
      ADMIN,
      {
        source: mcp.url,
        name: "kit",
        private: false,
        accepts: "shared",
        credential: { kind: "compound", fields: { key: "k-1" }, subject: EVERYONE },
        credentialSettings: { compound: { headers: { "x-api-key": "{key}" } } },
      },
      "test",
      POLICY,
    );

    expect(added).toMatchObject({ ok: true, value: { tool_list: { tools: 1 } } });
  });
});

/** A fresh RSA key pair: the private key as PKCS#8 PEM, and the public key to check signatures with. */
const rsaKey = async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );

  // SAFETY: generateKey of an RSA algorithm answers a key pair.
  const { privateKey, publicKey } = pair as CryptoKeyPair;
  // SAFETY: a PKCS#8 export answers an ArrayBuffer (JWK alone answers an object).
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", privateKey)) as ArrayBuffer);
  const base64 = btoa(String.fromCharCode(...pkcs8));

  return { pem: `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----\n`, publicKey };
};

const base64UrlBytes = (text: string) =>
  Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/** The claims of `jwt` when its RS256 signature checks out with `publicKey`, else undefined. */
const verifiedClaims = async (jwt: string, publicKey: CryptoKey) => {
  const [header = "", payload = "", signature = ""] = jwt.split(".");

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    base64UrlBytes(signature),
    new TextEncoder().encode(`${header}.${payload}`),
  );

  if (!valid) return undefined;

  // SAFETY: a JWS this test checks carries a JSON object of claims, which Commissary signed.
  return JSON.parse(new TextDecoder().decode(base64UrlBytes(payload))) as Record<string, unknown>;
};

const bearerOf = (request: RecordedHttpRequest | undefined) =>
  request?.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";

describe("a signed JWT", () => {
  it("is sent as the bearer token, signed with the toolkit's claims, and signed again near its expiry", async () => {
    const { stub, adjust, now } = await planeWithClock();
    const { pem, publicKey } = await rsaKey();
    const api = fakeHttpServer(origin("api"), ok);

    await openApi(
      stub,
      api.origin,
      { kind: "jwt", private_key: pem, issuer: "svc@example.com", key_id: "k1", subject: EVERYONE },
      {
        jwt: {
          algorithm: "RS256",
          audience: "https://api.example.com/",
          scope: "read",
          lifetime_seconds: 600,
          claims: { tenant: "t1" },
        },
      },
    );

    await ping(stub);
    await ping(stub);

    const first = bearerOf(api.requests[0]);
    const issuedAt = Math.floor(now() / 1000);

    expect(bearerOf(api.requests[1])).toBe(first);
    expect(await verifiedClaims(first, publicKey)).toEqual({
      tenant: "t1",
      iss: "svc@example.com",
      aud: "https://api.example.com/",
      scope: "read",
      iat: issuedAt,
      exp: issuedAt + 600,
    });
    expect(JSON.parse(atob(first.split(".")[0] ?? ""))).toEqual({
      alg: "RS256",
      typ: "JWT",
      kid: "k1",
    });

    await adjust("10 minutes");
    await ping(stub);

    expect(bearerOf(api.requests[2])).not.toBe(first);
  });

  it("is exchanged at the token endpoint (RFC 7523), the token cached and minted again on a 401", async () => {
    const { stub } = await planeWithClock();
    const { pem, publicKey } = await rsaKey();
    const issued = new Set<string>();
    const assertions: Array<string> = [];

    const auth = fakeHttpServer(origin("auth"), (request) => {
      const form = new URLSearchParams(request.body);

      if (
        form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer" ||
        form.get("client_id") !== "box-client" ||
        form.get("client_secret") !== "box-secret" ||
        form.get("scope") !== "https://scope"
      )
        return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
      assertions.push(form.get("assertion") ?? "");
      const token = `at-${crypto.randomUUID()}`;

      issued.add(token);

      return Response.json({ access_token: token, token_type: "Bearer", expires_in: 3600 });
    });

    const api = fakeHttpServer(origin("api"), (request) =>
      issued.has(bearerOf(request))
        ? ok()
        : Response.json({ error: "stale-token" }, { status: 401 }),
    );

    const tokenUrl = `${auth.origin}/token`;

    const toolkit = await openApi(
      stub,
      api.origin,
      {
        kind: "jwt",
        private_key: pem,
        issuer: "svc@example.com",
        client_id: "box-client",
        client_secret: "box-secret",
        subject: EVERYONE,
      },
      { jwt: { algorithm: "RS256", token_url: tokenUrl, scope: "https://scope" } },
    );

    expect(await ping(stub)).toMatchObject({ outcome: "result" });
    expect(await ping(stub)).toMatchObject({ outcome: "result" });
    expect(auth.requests).toHaveLength(1);
    expect(await verifiedClaims(assertions[0] ?? "", publicKey)).toMatchObject({
      iss: "svc@example.com",
      aud: tokenUrl,
      scope: "https://scope",
    });

    const view = await viewOf(stub, ADMIN, toolkit.id);

    expect(view).toMatchObject({ ok: true, value: { credentials: { shared: { kind: "jwt" } } } });
    expect(JSON.stringify(view)).not.toContain("at-");
    expect(JSON.stringify(view)).not.toContain("PRIVATE KEY");

    // The API refuses the token now: another is minted, and the call goes through with it.
    issued.clear();

    const called = await ping(stub);

    expect(called).toMatchObject({ outcome: "result" });
    expect(JSON.stringify(called)).not.toContain("stale-token");
    expect(auth.requests).toHaveLength(2);
  });

  it("mints again when the toolkit's settings change, and is not used once they are removed", async () => {
    const { stub } = await planeWithClock();
    const { pem, publicKey } = await rsaKey();
    const api = fakeHttpServer(origin("api"), ok);

    const toolkit = await openApi(
      stub,
      api.origin,
      { kind: "jwt", private_key: pem, issuer: "svc", subject: EVERYONE },
      { jwt: { algorithm: "RS256", audience: "one" } },
    );

    await ping(stub);

    const changed = await stub
      .tools()
      .updateToolkit(
        ADMIN,
        toolkit.id,
        toolkit.revision,
        { credential_settings: { jwt: { algorithm: "RS256", audience: "two" } } },
        "test",
        POLICY,
      );

    if (!changed.ok) throw new Error(`update failed: ${changed.message}`);
    await ping(stub);

    expect(await verifiedClaims(bearerOf(api.requests[0]), publicKey)).toMatchObject({
      aud: "one",
    });
    expect(await verifiedClaims(bearerOf(api.requests[1]), publicKey)).toMatchObject({
      aud: "two",
    });

    expect(
      await stub
        .tools()
        .updateToolkit(
          ADMIN,
          toolkit.id,
          changed.value.revision,
          { credential_settings: null },
          "test",
          POLICY,
        ),
    ).toMatchObject({ ok: true });
    expect(await ping(stub)).not.toMatchObject({ outcome: "result" });
    expect(api.requests).toHaveLength(2);
  });

  it("is refused without its issuer when it is exchanged at a token endpoint (RFC 7523 §3)", async () => {
    const { stub } = await planeWithClock();
    const api = fakeHttpServer(origin("api"), ok);
    const { pem } = await rsaKey();

    const toolkit = await openApi(
      stub,
      api.origin,
      { kind: "none", subject: EVERYONE },
      { jwt: { algorithm: "RS256", token_url: "https://auth.example.com/token" } },
    );

    expect(
      await stub
        .tools()
        .connectCredential(
          ADMIN,
          toolkit.id,
          "shared",
          { kind: "jwt", private_key: pem, subject: EVERYONE },
          "test",
          POLICY,
        ),
    ).toMatchObject({ ok: false, error: "invalid", message: expect.stringContaining("issuer") });
  });

  it("is refused with a key that is not the algorithm's", async () => {
    const { stub } = await planeWithClock();
    const api = fakeHttpServer(origin("api"), ok);

    const toolkit = await openApi(
      stub,
      api.origin,
      { kind: "none", subject: EVERYONE },
      {
        jwt: { algorithm: "ES256" },
      },
    );

    const { pem } = await rsaKey();

    expect(
      await stub
        .tools()
        .connectCredential(
          ADMIN,
          toolkit.id,
          "shared",
          { kind: "jwt", private_key: pem, subject: EVERYONE },
          "test",
          POLICY,
        ),
    ).toMatchObject({ ok: false, error: "invalid" });
  });
});

describe("a GitHub App", () => {
  it("gets an installation token for the installation chosen at connect, refreshed before it expires", async () => {
    const { stub, adjust, now } = await planeWithClock();
    const { pem, publicKey } = await rsaKey();
    const issued = new Set<string>();
    const appJwts: Array<string> = [];

    const github = fakeHttpServer(origin("github"), (request) => {
      if (
        request.method !== "POST" ||
        request.url.pathname !== "/app/installations/42/access_tokens"
      )
        return Response.json({ message: "Not Found" }, { status: 404 });
      appJwts.push(bearerOf(request));
      const token = `ghs_${crypto.randomUUID().replace(/-/g, "")}`;

      issued.add(token);

      return Response.json(
        { token, expires_at: new Date(now() + 3600_000).toISOString() },
        { status: 201 },
      );
    });

    const mcp = fakeMcpServer(`${origin("mcp")}/mcp`, {
      tools: [{ name: "echo" }],
      authorized: (request) => issued.has(request.headers.get("authorization")?.slice(7) ?? ""),
    });

    const added = await stub.tools().addToolkit(
      ADMIN,
      {
        source: mcp.url,
        name: "github",
        private: false,
        accepts: "shared",
        credential: {
          kind: "app",
          app_id: "123",
          private_key: pem,
          installation_id: "42",
          subject: EVERYONE,
        },
        credentialSettings: { app: { api_url: github.origin } },
      },
      "test",
      POLICY,
    );

    expect(added).toMatchObject({ ok: true, value: { tool_list: { tools: 1 } } });

    const call = () => stub.tools().callTool(ALICE, { name: "github_echo", arguments: {} }, POLICY);

    expect(await call()).toMatchObject({ outcome: "result" });
    expect(github.requests).toHaveLength(1);

    const issuedAt = Math.floor(now() / 1000);

    expect(await verifiedClaims(appJwts[0] ?? "", publicKey)).toEqual({
      iss: "123",
      iat: issuedAt - 60,
      exp: issuedAt + 540,
    });
    expect(github.requests[0]?.headers.get("accept")).toBe("application/vnd.github+json");

    // Within a minute of its expiry the token is refreshed before it is used.
    await adjust("3570 seconds");

    expect(await call()).toMatchObject({ outcome: "result" });
    expect(github.requests).toHaveLength(2);
  });

  it("names its installation by its numeric id", async () => {
    const { stub } = await planeWithClock();
    const api = fakeHttpServer(origin("api"), ok);
    const toolkit = await openApi(stub, api.origin, { kind: "none", subject: EVERYONE });
    const { pem } = await rsaKey();

    expect(
      await stub.tools().connectCredential(
        ADMIN,
        toolkit.id,
        "shared",
        {
          kind: "app",
          app_id: "1",
          private_key: pem,
          installation_id: "../x",
          subject: EVERYONE,
        },
        "test",
        POLICY,
      ),
    ).toMatchObject({ ok: false, error: "invalid" });
  });
});

describe("an RFC 8693 token exchange", () => {
  it("exchanges the subject token with the client's Basic auth, and caches what it gets", async () => {
    const { stub } = await planeWithClock();
    const issued = new Set<string>();

    const auth = fakeHttpServer(origin("auth"), (request) => {
      const form = new URLSearchParams(request.body);

      if (form.get("subject_token") !== "subject-1")
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      const token = `xt-${crypto.randomUUID()}`;

      issued.add(token);

      return Response.json({
        access_token: token,
        issued_token_type: "urn:ietf:params:oauth:token-type:jwt",
        token_type: "N_A",
        expires_in: 600,
      });
    });

    const api = fakeHttpServer(origin("api"), (request) =>
      issued.has(bearerOf(request)) ? ok() : Response.json({}, { status: 401 }),
    );

    await openApi(
      stub,
      api.origin,
      {
        kind: "token_exchange",
        subject_token: "subject-1",
        client_id: "c id",
        client_secret: "s+/:",
        subject: EVERYONE,
      },
      { token_exchange: { token_url: `${auth.origin}/token`, audience: "api", scope: "read" } },
    );

    expect(await ping(stub)).toMatchObject({ outcome: "result" });
    expect(await ping(stub)).toMatchObject({ outcome: "result" });
    expect(auth.requests).toHaveLength(1);
    // Each part form-encoded (RFC 6749 §2.3.1).
    expect(auth.requests[0]?.headers.get("authorization")).toBe(`Basic ${btoa("c+id:s%2B%2F%3A")}`);
    expect(Object.fromEntries(new URLSearchParams(auth.requests[0]?.body))).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: "subject-1",
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      audience: "api",
      scope: "read",
    });
  });

  it("is not used when the answer does not say what it issued", async () => {
    const { stub } = await planeWithClock();

    const auth = fakeHttpServer(origin("auth"), () =>
      Response.json({ access_token: "xt-1", token_type: "Bearer", expires_in: 600 }),
    );

    const api = fakeHttpServer(origin("api"), ok);

    await openApi(
      stub,
      api.origin,
      { kind: "token_exchange", subject_token: "subject-1", subject: EVERYONE },
      { token_exchange: { token_url: `${auth.origin}/token` } },
    );

    expect(await ping(stub)).not.toMatchObject({ outcome: "result" });
    expect(auth.requests).toHaveLength(1);
    expect(api.requests).toHaveLength(0);
  });

  it("marks the credential as needing to be connected again when the endpoint refuses it", async () => {
    const { stub } = await planeWithClock();

    const auth = fakeHttpServer(origin("auth"), () =>
      Response.json({ error: "invalid_grant" }, { status: 400 }),
    );

    const api = fakeHttpServer(origin("api"), ok);

    const toolkit = await openApi(
      stub,
      api.origin,
      { kind: "token_exchange", subject_token: "expired", subject: EVERYONE },
      { token_exchange: { token_url: `${auth.origin}/token` } },
    );

    expect(await ping(stub)).not.toMatchObject({ outcome: "result" });
    expect(api.requests).toHaveLength(0);
    expect(await viewOf(stub, ADMIN, toolkit.id)).toMatchObject({
      ok: true,
      value: { credentials: { shared: { kind: "token_exchange", needs_sign_in: true } } },
    });
  });
});

describe("credential settings", () => {
  it("are refused when they do not hold up, and shown to the toolkit's readers", async () => {
    const { stub } = await planeWithClock();
    const api = fakeHttpServer(origin("api"), ok);
    const toolkit = await openApi(stub, api.origin, { kind: "none", subject: EVERYONE });

    for (const [settings, path] of [
      [{ jwt: { algorithm: "RS256", claims: { exp: 1 } } }, "credential_settings.jwt.claims"],
      [
        { jwt: { algorithm: "RS256", lifetime_seconds: 60 } },
        "credential_settings.jwt.lifetime_seconds",
      ],
      [{ aws_sigv4: { region: "EU West", service: "s3" } }, "credential_settings.aws_sigv4.region"],
      [{ compound: { headers: { host: "{x}" } } }, "credential_settings.compound.headers.host"],
    ] as const)
      await expect(
        stub
          .tools()
          .updateToolkit(
            ADMIN,
            toolkit.id,
            toolkit.revision,
            { credential_settings: settings },
            "test",
            POLICY,
          ),
      ).resolves.toMatchObject({ ok: false, error: "invalid", path });

    const settings = { aws_sigv4: { region: "us-east-1", service: "s3" } };

    expect(
      await stub
        .tools()
        .updateToolkit(
          ADMIN,
          toolkit.id,
          toolkit.revision,
          { credential_settings: settings },
          "test",
          POLICY,
        ),
    ).toMatchObject({ ok: true, value: { credential_settings: settings } });
    expect(await viewOf(stub, ALICE, toolkit.id)).toMatchObject({
      ok: true,
      value: { credential_settings: settings },
    });
  });
});
