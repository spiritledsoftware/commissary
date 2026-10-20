// Commissary Cloud's OAuth grants for MCP clients (#200) as a store of org data, for the cross-org suite
// (apps/app/test/org-isolation.test.ts): a grant is the library's, kept under the user `signInUserId` names, the member
// in their org, so the same member id in two orgs holds two sets of grants. Writes go through the library's helpers as
// a completed sign-in does (`approveSignIn`), without the consent page. The Worker's tests also take an access token of
// a server they configure themselves (another resource's, say) from it.
import { Effect } from "effect";
import type { InvocationContext } from "@commissary/core";
import type { McpOAuthConfig } from "../../src/oauth/config.ts";
import { helpersOf, serveAuthorizationServer, signInUserId } from "../../src/oauth/server.ts";

const REDIRECT_URI = "https://client.example.com/callback";

/** The PKCE verifier of RFC 7636's example, and its S256 challenge, which the grants are stored with. */
const CODE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

const CODE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

/** No `waitUntil` work outlives the test's token request. */
const context: InvocationContext = {
  waitUntil: () => {},
  passThroughOnException: () => {},
};

/** The grants of the member `memberId` of `org` on the OAuth server `config`: a grant's API key id. */
export const signInGrants = (config: McpOAuthConfig) => {
  const helpers = helpersOf(config);

  /** A completed authorization of a new client for the member, carrying the API key `key` (whose id is `keyId`). */
  const authorize = async (org: string, memberId: string, keyId: string, key = `cms_${keyId}`) => {
    const client = await helpers.createClient({
      redirectUris: [REDIRECT_URI],
      clientName: "Isolation client",
      tokenEndpointAuthMethod: "none",
    });

    const { redirectTo } = await helpers.completeAuthorization({
      request: {
        responseType: "code",
        clientId: client.clientId,
        redirectUri: REDIRECT_URI,
        scope: [],
        state: "isolation",
        codeChallenge: CODE_CHALLENGE,
        codeChallengeMethod: "S256",
        resource: config.resource,
      },
      userId: signInUserId(org, memberId),
      metadata: { keyId, redirectUri: REDIRECT_URI },
      scope: [],
      props: { key },
    });

    return { clientId: client.clientId, redirectTo };
  };

  return {
    /** Stores a grant of the member for a new client, carrying the API key `keyId`. */
    write: async (org: string, memberId: string, keyId: string): Promise<void> => {
      await authorize(org, memberId, keyId);
    },
    /**
     * An access token of a new grant of the member that carries the API key `key`, exchanged at the server's token
     * endpoint (the key counts as live).
     */
    accessToken: async (org: string, memberId: string, key: string): Promise<string> => {
      const { clientId, redirectTo } = await authorize(org, memberId, "token-key", key);
      const code = new URL(redirectTo).searchParams.get("code") ?? "";

      const response = await Effect.runPromise(
        serveAuthorizationServer(
          config,
          new Request(`${config.issuer}/oauth/token`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code,
              redirect_uri: REDIRECT_URI,
              client_id: clientId,
              code_verifier: CODE_VERIFIER,
            }).toString(),
          }),
          context,
          { ownHosts: [], localDevelopment: false },
          async () => true,
        ),
      );

      if (!response.ok) throw new Error(`token request failed: ${await response.text()}`);

      return (await response.json<{ access_token: string }>()).access_token;
    },
    /** The API key ids of the member's grants. */
    keyIds: async (org: string, memberId: string): Promise<ReadonlyArray<string>> => {
      const { items } = await helpers.listUserGrants(signInUserId(org, memberId));

      return items.flatMap((grant) => {
        const metadata: unknown = grant.metadata;

        return typeof metadata === "object" &&
          metadata !== null &&
          "keyId" in metadata &&
          typeof metadata.keyId === "string"
          ? [metadata.keyId]
          : [];
      });
    },
  };
};
