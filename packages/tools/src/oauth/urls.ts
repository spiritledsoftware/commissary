/**
 * Where Commissary lives as an OAuth client of toolkits' sign-ins (#202): the callback on the app host, the URL of its
 * Client ID Metadata Document (CIMD), the document itself, and the org a callback is for. Pure: no bindings, so the
 * app Worker's gate and the Node.js unit tests read it too.
 */
import {
  isLoopbackHost,
  type OrgId,
  orgOfScopedName,
  TOOLKIT_OAUTH_CLIENT_PATH,
} from "@commissary/core";
import { isSignInState } from "./pkce.ts";

/** The deployment's one redirect URI of toolkits' OAuth sign-ins, on the app host. */
export const SIGN_IN_CALLBACK_PATH = "/oauth/toolkits/callback";

/** Where Commissary's client lives for a sign-in: its callback, and its CIMD document's URL when one is served. */
export interface ClientUrls {
  readonly callback: string;
  /** Undefined where no authorization server could fetch the document (loopback, a preview). */
  readonly clientId: string | undefined;
}

/**
 * Where Commissary's client lives for a sign-in started by a management request to `requestUrl` (the app host): the
 * callback there, and the CIMD document on the API host (`apiDomain`; without one, the app host, whose zone route
 * sends it to the API Worker). No document on a loopback host (`alchemy dev`), which no authorization server reaches,
 * nor on a workers.dev host (a preview), whose API Worker does not know the app host to name, nor over plain `http:`.
 */
export const signInUrls = (requestUrl: string, apiDomain: string | undefined): ClientUrls => {
  const url = new URL(requestUrl, "http://localhost");
  const host = url.hostname;
  const api = (apiDomain ?? "").trim();

  return {
    callback: `${url.origin}${SIGN_IN_CALLBACK_PATH}`,
    clientId:
      isLoopbackHost(host) || host.endsWith(".workers.dev") || url.protocol !== "https:"
        ? undefined
        : `https://${api === "" ? url.host : api}${TOOLKIT_OAUTH_CLIENT_PATH}`,
  };
};

/** Commissary's CIMD document at `clientId`, naming the callback on `appHost`; the same for every request. */
export const clientMetadata = (clientId: string, appHost: string) => ({
  client_id: clientId,
  client_name: "Commissary",
  client_uri: `https://${appHost}`,
  redirect_uris: [`https://${appHost}${SIGN_IN_CALLBACK_PATH}`],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
});

/**
 * The org a sign-in's callback (`requestUrl`) is for: the one its `state` names (`org.<org>.<hex>`, a bare one is
 * `global`'s); undefined for a URL without a state of a sign-in.
 */
export const signInCallbackOrg = (requestUrl: string): OrgId | undefined => {
  const state = new URL(requestUrl, "http://localhost").searchParams.get("state")?.trim() ?? "";

  return isSignInState(state) ? orgOfScopedName(state) : undefined;
};
