// A fake OAuth 2 authorization server (#202) served in workerd through the routing `fetch` of `mcp-server.ts`: its
// metadata (RFC 8414), dynamic client registration (RFC 7591), clients that come as CIMD documents (fetched from their
// `client_id` URL), the authorization code grant with PKCE S256 (RFC 7636), refreshes and the client credentials grant.
// The browser's part is `authorize`: it approves the request the browser would open and answers the URL the
// authorization server redirects it to. Every access token it issued and has not revoked is in `accessTokens`, for a
// fake MCP server's `authorized` check.
import { serveOrigin } from "./mcp-server.ts";

export interface FakeAuthServerOptions {
  /** It takes CIMD documents' URLs as client ids (`client_id_metadata_document_supported`). */
  readonly cimd?: boolean;
  /** It registers clients (`registration_endpoint`). */
  readonly registration?: boolean;
  /** It names itself in the authorization response (RFC 9207), and says so in its metadata. */
  readonly iss?: boolean;
  /** The lifetime of its access tokens (`expires_in`, seconds); absent: not said. */
  readonly expiresIn?: number;
  /** Whether it issues refresh tokens; it does by default. */
  readonly refreshTokens?: boolean;
  /** Clients registered by hand: an OAuth app's, or a client credentials grant's. */
  readonly clients?: ReadonlyArray<{ readonly id: string; readonly secret?: string }>;
  /** The token endpoint its metadata names, instead of its own. */
  readonly tokenEndpoint?: string;
}

export interface RecordedTokenRequest {
  readonly form: URLSearchParams;
  readonly headers: Headers;
  /** How the client authenticated: `basic`, `post` (`client_secret` in the form), or `none`. */
  readonly auth: "basic" | "post" | "none";
}

export interface FakeAuthServer {
  readonly issuer: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  /** The access tokens it issued and has not revoked. */
  readonly accessTokens: Set<string>;
  readonly tokenRequests: Array<RecordedTokenRequest>;
  /** The clients it registered dynamically. */
  readonly registrations: Array<{ readonly clientId: string; readonly redirectUris: unknown }>;
  /** The CIMD documents it fetched, by URL. */
  readonly fetchedDocuments: Array<string>;
  /** Approves the browser's request `url` (what `startSignIn` answered): the URL it redirects the browser to. */
  authorize(url: string, options?: { readonly iss?: string }): Promise<URL>;
  /** Revokes every refresh token: a refresh is refused (`invalid_grant`). */
  revokeRefreshTokens(): void;
}

const base64Url = (bytes: Uint8Array): string => {
  let binary = "";

  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const s256 = async (verifier: string): Promise<string> =>
  base64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );

const refused = (error: string, status = 400) => Response.json({ error }, { status });

interface Client {
  readonly secret: string | undefined;
  readonly redirectUris: ReadonlyArray<string> | undefined;
}

interface Grant {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly resource: string | null;
}

/** A fake authorization server whose issuer is `issuer` (an origin unique to the test). */
export const fakeAuthServer = (
  issuer: string,
  options: FakeAuthServerOptions = {},
): FakeAuthServer => {
  const clients = new Map<string, Client>(
    (options.clients ?? []).map((client) => [
      client.id,
      { secret: client.secret, redirectUris: undefined },
    ]),
  );

  const codes = new Map<string, Grant>();
  const refreshTokens = new Map<string, { clientId: string }>();
  let issued = 0;

  const server: FakeAuthServer = {
    issuer,
    authorizeUrl: `${issuer}/authorize`,
    tokenUrl: `${issuer}/token`,
    accessTokens: new Set(),
    tokenRequests: [],
    registrations: [],
    fetchedDocuments: [],
    authorize: async (url, authorizeOptions = {}) => {
      const params = new URL(url).searchParams;
      const clientId = params.get("client_id") ?? "";
      const redirectUri = params.get("redirect_uri") ?? "";
      const state = params.get("state") ?? "";

      if (params.get("response_type") !== "code" || params.get("code_challenge_method") !== "S256")
        throw new Error("not an authorization code request with PKCE S256");

      let client = clients.get(clientId);

      if (client === undefined && options.cimd === true && clientId.startsWith("https://")) {
        server.fetchedDocuments.push(clientId);
        const answer = await fetch(clientId);

        if (answer.status !== 200) throw new Error(`the CIMD document answered ${answer.status}`);
        const document = await answer.json<{ client_id?: string; redirect_uris?: Array<string> }>();

        if (document.client_id !== clientId)
          throw new Error("the CIMD document names another client");

        client = { secret: undefined, redirectUris: document.redirect_uris ?? [] };
      }

      if (client === undefined) throw new Error(`unknown client ${clientId}`);

      if (client.redirectUris !== undefined && !client.redirectUris.includes(redirectUri))
        throw new Error(`unregistered redirect URI ${redirectUri}`);

      issued += 1;
      const code = `code-${issued}`;

      codes.set(code, {
        clientId,
        redirectUri,
        challenge: params.get("code_challenge") ?? "",
        resource: params.get("resource"),
      });

      const back = new URL(redirectUri);

      back.searchParams.set("code", code);
      back.searchParams.set("state", state);

      const iss = authorizeOptions.iss ?? (options.iss === true ? issuer : undefined);

      if (iss !== undefined) back.searchParams.set("iss", iss);

      return back;
    },
    revokeRefreshTokens: () => refreshTokens.clear(),
  };

  const tokens = (clientId: string, refresh: boolean) => {
    issued += 1;
    const access = `access-${issued}-${crypto.randomUUID().slice(0, 8)}`;

    server.accessTokens.add(access);

    const refreshToken =
      refresh && options.refreshTokens !== false ? `refresh-${issued}` : undefined;

    if (refreshToken !== undefined) refreshTokens.set(refreshToken, { clientId });

    return Response.json({
      access_token: access,
      token_type: "Bearer",
      ...(options.expiresIn === undefined ? {} : { expires_in: options.expiresIn }),
      ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
    });
  };

  /** The client a token request authenticated as, or why not. */
  const authenticate = (request: Request, form: URLSearchParams) => {
    const basic = request.headers.get("authorization");

    if (basic?.startsWith("Basic ") === true) {
      const [id = "", secret = ""] = atob(basic.slice(6))
        .split(":")
        .map((part) => decodeURIComponent(part.replace(/\+/g, " ")));

      return { id, secret, auth: "basic" as const };
    }

    const secret = form.get("client_secret");

    return {
      id: form.get("client_id") ?? "",
      secret: secret ?? undefined,
      auth: secret === null ? ("none" as const) : ("post" as const),
    };
  };

  const token = async (request: Request): Promise<Response> => {
    const form = new URLSearchParams(new TextDecoder().decode(await request.arrayBuffer()));
    const presented = authenticate(request, form);

    server.tokenRequests.push({ form, headers: request.headers, auth: presented.auth });

    const client =
      clients.get(presented.id) ??
      (options.cimd === true && presented.id.startsWith("https://")
        ? { secret: undefined, redirectUris: undefined }
        : undefined);

    if (client === undefined || client.secret !== presented.secret)
      return refused("invalid_client", 401);

    switch (form.get("grant_type")) {
      case "authorization_code": {
        const grant = codes.get(form.get("code") ?? "");

        codes.delete(form.get("code") ?? "");

        if (
          grant === undefined ||
          grant.clientId !== presented.id ||
          grant.redirectUri !== form.get("redirect_uri") ||
          grant.resource !== form.get("resource") ||
          grant.challenge !== (await s256(form.get("code_verifier") ?? ""))
        )
          return refused("invalid_grant");

        return tokens(presented.id, true);
      }

      case "refresh_token": {
        const kept = refreshTokens.get(form.get("refresh_token") ?? "");

        if (kept === undefined || kept.clientId !== presented.id) return refused("invalid_grant");

        return tokens(presented.id, false);
      }

      case "client_credentials":
        return presented.secret === undefined
          ? refused("invalid_client", 401)
          : tokens(presented.id, false);
      default:
        return refused("unsupported_grant_type");
    }
  };

  const register = async (request: Request): Promise<Response> => {
    const body = await request.json<{
      redirect_uris?: Array<string>;
      token_endpoint_auth_method?: string;
    }>();

    issued += 1;
    // Named by the server too: two servers never register the same id.
    const clientId = `client-${issued}-${new URL(issuer).hostname.split(".")[0] ?? ""}`;
    const secret = body.token_endpoint_auth_method === "none" ? undefined : `secret-${issued}`;

    clients.set(clientId, { secret, redirectUris: body.redirect_uris ?? [] });
    server.registrations.push({ clientId, redirectUris: body.redirect_uris });

    return Response.json(
      {
        client_id: clientId,
        ...(secret === undefined ? {} : { client_secret: secret }),
        token_endpoint_auth_method: body.token_endpoint_auth_method ?? "client_secret_basic",
      },
      { status: 201 },
    );
  };

  serveOrigin(issuer, async (request) => {
    const path = new URL(request.url).pathname;

    if (path === "/.well-known/oauth-authorization-server")
      return Response.json({
        issuer,
        authorization_endpoint: server.authorizeUrl,
        token_endpoint: options.tokenEndpoint ?? server.tokenUrl,
        ...(options.registration === true ? { registration_endpoint: `${issuer}/register` } : {}),
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: [
          "none",
          "client_secret_basic",
          "client_secret_post",
        ],
        ...(options.cimd === true ? { client_id_metadata_document_supported: true } : {}),
        ...(options.iss === true ? { authorization_response_iss_parameter_supported: true } : {}),
      });

    if (path === "/token" && request.method === "POST") return await token(request);

    if (path === "/register" && request.method === "POST" && options.registration === true)
      return await register(request);

    return new Response("not found", { status: 404 });
  });

  return server;
};

/** A fake MCP server's `authorized` check: a bearer token `server` issued and has not revoked. */
export const bearerOf =
  (server: Pick<FakeAuthServer, "accessTokens">) =>
  (request: Request): boolean => {
    const header = request.headers.get("authorization") ?? "";

    return header.startsWith("Bearer ") && server.accessTokens.has(header.slice(7));
  };
