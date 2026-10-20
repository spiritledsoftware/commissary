/**
 * Commissary Cloud's OAuth 2.1 server for MCP clients (#200, ADR 0036, ADR 0045, MCP authorization 2025-11-25 and
 * 2026-07-28), on Cloudflare's `@cloudflare/workers-oauth-provider`: RFC 8414 metadata, PKCE, RFC 8707 `resource`
 * (tokens are bound to the MCP endpoint, `config.ts`), RFC 9207 `iss`, refresh tokens that rotate, Client ID Metadata
 * Documents (CIMD) as the preferred registration and dynamic registration (DCR, RFC 7591) as the fallback.
 *
 * - **One principal per client.** A completed sign-in creates an API key for the member, named after the client, with
 *   the tool scope the member picked on the consent page (the app Worker issues it, {@link approveSignIn}). The grant's
 *   tokens carry that key, encrypted by the library ({@link SignInProps}), and the MCP endpoint resolves a token to it
 *   ({@link resolveAccessToken}), so usage, Spend limits, tool scopes and revocation are the key's. A refresh checks
 *   that the key is still live: revoking the key ends the client's access, its refresh token included.
 * - **No token passes through.** The tokens are Commissary's own; neither they nor any upstream token cross over.
 * - **Exact redirect URIs**, and **PKCE required**: the library holds every request to a registered redirect URI (any
 *   port of a loopback one, RFC 8252 §7.3) and asks PKCE of public clients; Commissary refuses an authorization
 *   request without it from any client.
 * - **`state` stays server-side**: the authorization request waits in the library's KV while the member decides, bound
 *   to their browser by a `__Host-` cookie; the consent page posts back only its handle.
 * - **The outbound guard** (ADR 0044): the library fetches CIMD documents and their JWKS itself, so every call that may
 *   fetch runs inside `withOutboundGuard`.
 */
import {
  AuthorizationError,
  authorizationErrorRedirect,
  type AuthRequest,
  CimdFetchError,
  type GrantSummary,
  OAuthAuthorizationServer,
  OAuthError,
} from "@cloudflare/workers-oauth-provider";
import { Data, Effect, Predicate } from "effect";
import { type InvocationContext, type OutboundPolicy, withOutboundGuard } from "@commissary/core";
import { AUTHORIZE_PATH, type McpOAuthConfig, REGISTER_PATH, TOKEN_PATH } from "./config.ts";

/** What the library reads of its `env`, and how the token endpoint asks whether a key is live. */
interface OAuthEnv {
  readonly OAUTH_KV: McpOAuthConfig["kv"];
  /**
   * Whether the API key a grant carries is still live (rejects when it cannot tell); without it, a refresh is refused.
   */
  readonly keyIsLive?: (key: string) => Promise<boolean>;
}

/** What a grant's tokens carry (encrypted by the library with key material only a token unwraps): the API key. */
interface SignInProps {
  readonly key: string;
}

/**
 * What a grant says in clear (the library stores it unencrypted): the id of its API key and the redirect URI it was
 * issued for, so the next sign-in of the client from there revokes the key it replaces.
 */
interface SignInMetadata {
  readonly keyId: string;
  readonly redirectUri: string;
}

const isSignInProps = (props: unknown): props is SignInProps =>
  Predicate.hasProperty(props, "key") && Predicate.isString(props.key);

const isSignInMetadata = (metadata: unknown): metadata is SignInMetadata =>
  Predicate.hasProperty(metadata, "keyId") &&
  Predicate.isString(metadata.keyId) &&
  Predicate.hasProperty(metadata, "redirectUri") &&
  Predicate.isString(metadata.redirectUri);

/** A refresh (or a code exchange) whose API key is gone: the grant is revoked with its tokens (`invalid_grant`). */
const keyGone = () =>
  new OAuthError("invalid_grant", {
    description: "The API key this sign-in issued was revoked; sign in again.",
  });

/** One authorization server per isolate and configuration. */
const servers = new Map<string, OAuthAuthorizationServer<OAuthEnv>>();

const serverOf = (config: McpOAuthConfig): OAuthAuthorizationServer<OAuthEnv> => {
  const name = `${config.issuer} ${config.resource}`;
  const known = servers.get(name);

  if (known !== undefined) return known;

  const server = new OAuthAuthorizationServer<OAuthEnv>({
    issuer: config.issuer,
    resources: [config.resource],
    authorizeEndpoint: AUTHORIZE_PATH,
    tokenEndpoint: TOKEN_PATH,
    clientRegistrationEndpoint: REGISTER_PATH,
    clientIdMetadataDocumentEnabled: true,
    // Every token request of a grant (the code, each refresh) checks that its key is still live. A check that fails
    // (the directory could not be asked) is transient: the grant stays.
    tokenExchangeCallback: async ({ props, env }) => {
      if (!isSignInProps(props) || env.keyIsLive === undefined) throw keyGone();

      const live = await env.keyIsLive(props.key).catch(() => undefined);

      if (live === undefined)
        throw new OAuthError("temporarily_unavailable", {
          description: "Commissary could not check this sign-in's API key; try again.",
          statusCode: 503,
        });

      if (!live) throw keyGone();

      return undefined;
    },
  });

  servers.set(name, server);

  return server;
};

const envOf = (
  config: McpOAuthConfig,
  keyIsLive?: (key: string) => Promise<boolean>,
): OAuthEnv => ({
  OAUTH_KV: config.kv,
  ...(keyIsLive === undefined ? {} : { keyIsLive }),
});

/** The library's helpers over `config`'s KV (exported for `@commissary/tools/testing`'s grant store). */
export const helpersOf = (config: McpOAuthConfig) => serverOf(config).getOAuthApi(envOf(config));

/** The library's user of a sign-in: the member in their org, `<org>/<member id>` (an org id has no `/` and no `:`). */
export const signInUserId = (org: string, memberId: string): string => `${org}/${memberId}`;

/**
 * Serves the library's own endpoints: RFC 8414 metadata, the token endpoint (codes, refreshes, RFC 7009 revocation)
 * and dynamic registration, behind the outbound guard. `keyIsLive` answers whether a grant's API key is live.
 */
export const serveAuthorizationServer = (
  config: McpOAuthConfig,
  request: Request,
  ctx: InvocationContext,
  policy: OutboundPolicy,
  keyIsLive: (key: string) => Promise<boolean>,
): Effect.Effect<Response> =>
  Effect.promise(() =>
    withOutboundGuard(policy, () =>
      serverOf(config).fetch(
        request,
        envOf(config, keyIsLive),
        // SAFETY: the library hands `ctx` only to an API or default handler, and this server has neither.
        ctx as ExecutionContext,
      ),
    ),
  );

/** What the consent page shows of the client (escaped by the panel: every string here is the client's own). */
export interface ConsentClient {
  readonly clientId: string;
  /** Self-asserted, unless `clientDomain` is set. */
  readonly clientName: string;
  /** A CIMD client's domain: its client id is a URL on it, which the client controls. */
  readonly clientDomain?: string;
  /** Where the tokens go: the redirect URI's host (a private-use URI whole). */
  readonly redirectHost: string;
  /** The redirect goes to an app on the member's own computer, whatever its name says. */
  readonly redirectIsLoopback: boolean;
}

/** The start of a sign-in: the consent page to show, an answer the client hears, or a refusal shown on the page. */
export type SignInStart =
  | {
      readonly kind: "consent";
      /** Posted back to approve or deny; works once, for ten minutes, in this browser. */
      readonly handle: string;
      /** `Set-Cookie` values that bind the handle to the browser. */
      readonly cookies: ReadonlyArray<string>;
      readonly client: ConsentClient;
    }
  | { readonly kind: "redirect"; readonly to: string }
  | { readonly kind: "refused"; readonly message: string };

/** A decision on the consent page: where the browser goes now, or why it cannot (shown on the page). */
export type SignInEnd =
  | { readonly kind: "redirect"; readonly to: string; readonly cookies: ReadonlyArray<string> }
  | { readonly kind: "refused"; readonly message: string };

const CIMD_FAILED = "The app's client metadata document could not be fetched, or is not valid.";

const EXPIRED =
  "This sign-in has expired, was already answered, or was opened in another browser. Start it again from the app.";

/**
 * `run`'s answer, or the refusal a validation failure is: one the page shows or the client hears. Anything else is a
 * defect (a KV outage, a bug) and is thrown on.
 */
const recovered = async (run: () => Promise<SignInStart>): Promise<SignInStart> => {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AuthorizationError)
      return error.redirectTo === undefined
        ? { kind: "refused", message: error.description }
        : { kind: "redirect", to: error.redirectTo };

    if (error instanceof CimdFetchError) return { kind: "refused", message: CIMD_FAILED };

    throw error;
  }
};

const clientOf = async (
  helpers: ReturnType<typeof helpersOf>,
  request: AuthRequest,
): Promise<ConsentClient> => {
  const described = await helpers.describeConsent(request);

  return {
    clientId: described.clientId,
    clientName: described.clientName,
    ...(described.clientDomain === undefined ? {} : { clientDomain: described.clientDomain }),
    redirectHost: described.redirectHost,
    redirectIsLoopback: described.redirectIsLoopback,
  };
};

/**
 * Validates an authorization request (`search`, the query the client sent to the authorization endpoint) and keeps it
 * server-side for the consent page: the client (registered, or its CIMD document fetched behind the guard), its exact
 * redirect URI, `resource`, and PKCE, which Commissary requires of every client. A request whose redirect URI was
 * validated is answered to the client (an OAuth error redirect); any other failure is shown on the page.
 */
export const beginSignIn = (
  config: McpOAuthConfig,
  search: string,
  policy: OutboundPolicy,
): Effect.Effect<SignInStart> =>
  Effect.promise(() =>
    recovered(async (): Promise<SignInStart> => {
      const helpers = helpersOf(config);
      const authorize = new Request(`${config.issuer}${AUTHORIZE_PATH}${search}`);

      const request = await withOutboundGuard(policy, () => helpers.parseAuthRequest(authorize));

      if (request.codeChallenge === undefined || request.codeChallenge === "")
        return {
          kind: "redirect",
          to: authorizationErrorRedirect(
            request,
            "invalid_request",
            "PKCE is required: send a code_challenge with code_challenge_method=S256",
          ),
        };

      const client = await withOutboundGuard(policy, () => clientOf(helpers, request));
      const consent = await helpers.beginConsent(request);

      return {
        kind: "consent",
        handle: consent.handle,
        cookies: consent.headers.getSetCookie(),
        client,
      };
    }),
  );

/** The grants `userId` holds, every page. */
const grantsOf = async (
  helpers: ReturnType<typeof helpersOf>,
  userId: string,
): Promise<ReadonlyArray<GrantSummary>> => {
  const grants: Array<GrantSummary> = [];
  let cursor: string | undefined;

  do {
    const page = await helpers.listUserGrants(userId, cursor === undefined ? {} : { cursor });

    grants.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined);

  return grants;
};

/** What the app Worker does for a sign-in: issue the client's API key, revoke keys it replaces. */
export interface SignInKeys {
  /** Issues the member's API key named after the client, with the tool scope they chose; or why it cannot. */
  readonly issue: (
    clientName: string,
  ) => Promise<{ readonly key: string; readonly keyId: string } | { readonly refused: string }>;
  /** Revokes keys an earlier sign-in of the same client issued (and a key whose grant could not be stored). */
  readonly revoke: (keyIds: ReadonlyArray<string>) => Promise<void>;
}

/**
 * The member approved the consent page (`request`: the page's call, which carries the browser's binding cookie):
 * issues the client's API key and completes the authorization, which answers the redirect with the code. `userId`
 * names the member in their org ({@link signInUserId}). The member's earlier sign-in of the client (of a CIMD client:
 * from the same redirect URI) is replaced, as the library replaces its grant: its key is revoked too, best-effort (the
 * library has deleted the grant's tokens already, and no one else holds the key, so a revocation that fails is logged
 * and leaves an unusable key in the member's list).
 */
export const approveSignIn = (
  config: McpOAuthConfig,
  request: Request,
  handle: string,
  userId: string,
  policy: OutboundPolicy,
  keys: SignInKeys,
): Effect.Effect<SignInEnd> =>
  Effect.gen(function* () {
    const { end, replaced } = yield* Effect.promise(
      async (): Promise<{ readonly end: SignInEnd; readonly replaced: ReadonlyArray<string> }> => {
        const helpers = helpersOf(config);
        let approved: Awaited<ReturnType<typeof helpers.approveConsent>>;

        try {
          approved = await helpers.approveConsent(request, handle);
        } catch (error) {
          if (error instanceof AuthorizationError)
            return { end: { kind: "refused", message: EXPIRED }, replaced: [] };

          throw error;
        }

        const authRequest = approved.request;
        let client: ConsentClient;

        try {
          client = await withOutboundGuard(policy, () => clientOf(helpers, authRequest));
        } catch (error) {
          if (error instanceof CimdFetchError)
            return { end: { kind: "refused", message: CIMD_FAILED }, replaced: [] };

          throw error;
        }

        // The grants the library replaces (`completeAuthorization`): the client's, and for a CIMD client only those
        // from the same redirect URI. Read before the key is issued, so a failure here leaves no key behind.
        const replacedKeys = (await grantsOf(helpers, userId)).flatMap((grant) =>
          grant.clientId === authRequest.clientId &&
          isSignInMetadata(grant.metadata) &&
          (client.clientDomain === undefined ||
            grant.metadata.redirectUri === authRequest.redirectUri)
            ? [grant.metadata.keyId]
            : [],
        );

        const issued = await keys.issue(client.clientName);

        if ("refused" in issued)
          return { end: { kind: "refused", message: issued.refused }, replaced: [] };

        const metadata: SignInMetadata = {
          keyId: issued.keyId,
          redirectUri: authRequest.redirectUri,
        };

        const props: SignInProps = { key: issued.key };
        let redirectTo: string;

        try {
          ({ redirectTo } = await helpers.completeAuthorization({
            request: authRequest,
            userId,
            metadata,
            scope: authRequest.scope,
            props,
          }));
        } catch (error) {
          await keys.revoke([issued.keyId]);

          throw error;
        }

        return {
          end: { kind: "redirect", to: redirectTo, cookies: approved.headers.getSetCookie() },
          replaced: replacedKeys,
        };
      },
    );

    if (replaced.length > 0)
      yield* Effect.tryPromise({
        try: () => keys.revoke(replaced),
        catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("replaced MCP sign-in keys were not revoked").pipe(
            Effect.annotateLogs({ keys: replaced.length, error }),
          ),
        ),
      );

    return end;
  });

/** The member denied the consent page: the client hears `access_denied`, with its `state` and `iss`. */
export const denySignIn = (
  config: McpOAuthConfig,
  request: Request,
  handle: string,
): Effect.Effect<SignInEnd> =>
  Effect.promise(async (): Promise<SignInEnd> => {
    try {
      const denied = await helpersOf(config).denyConsent(request, handle);

      return { kind: "redirect", to: denied.redirectTo, cookies: denied.headers.getSetCookie() };
    } catch (error) {
      if (error instanceof AuthorizationError) return { kind: "refused", message: EXPIRED };

      throw error;
    }
  });

/** The OAuth server's store could not be read: whether a token is live is unknown (a `503`, not a `401`). */
export class McpTokenUnavailable extends Data.TaggedError("McpTokenUnavailable")<{
  readonly message: string;
}> {}

/**
 * The API key an access token stands for, `undefined` for a token that is not one of this server's live tokens for the
 * MCP endpoint (another resource's or audience's, expired, revoked, or no token of ours at all); fails when the store
 * cannot be read.
 */
export const resolveAccessToken = (
  config: McpOAuthConfig,
  token: string,
): Effect.Effect<string | undefined, McpTokenUnavailable> =>
  Effect.tryPromise({
    try: () => serverOf(config).validateToken(config.resource, token, envOf(config)),
    catch: (cause) =>
      new McpTokenUnavailable({ message: cause instanceof Error ? cause.message : String(cause) }),
  }).pipe(
    Effect.map((validated) =>
      validated !== null && isSignInProps(validated.props) ? validated.props.key : undefined,
    ),
  );
