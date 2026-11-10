/**
 * Meta (Muse, `api.meta.ai`) credential resolution.
 *
 * Go source: internal/runtime/executor/meta_executor.go (`metaCreds`, `extractDCAToken`, `ensureAuth`). The DCA ->
 * Provider-key mint itself runs in the ControlPlane (`ensureFresh`, credentials/refresh/meta.ts); the conductor wraps every
 * attempt with it, so the executor only reads the minted key. A `dca:` value is never used as a bearer token.
 */
import type { Json } from "@commissary/json";
import { ExecutionError } from "../errors.ts";
import type { CredentialSnapshot } from "../picker.ts";

export const META_DEFAULT_BASE_URL = "https://api.meta.ai/v1";

/**
 * Captured from Muse Code 1.4.14-R7309.1 on linux-x86_64. Subscription keys return 403 `client_attestation_denied`
 * for an older `muse-build` fingerprint. Go reads the host OS/arch; a Worker has none, so the captured platform is fixed.
 */
export const META_USER_AGENT =
  "muse-build/1.4.14 (non-interactive; linux-x86_64; build dec7d7497fecdad135ec5835a8161dbc92e55b58)";

export const META_CLIENT_ID = "tbh:exec";

const text = (value: Json | undefined): string => (typeof value === "string" ? value.trim() : "");

const usableToken = (value: Json | undefined): string => {
  const token = text(value);

  return token !== "" && !token.startsWith("dca:") ? token : "";
};

export interface MetaCreds {
  readonly baseUrl: string;
  readonly token: string;
}

/** `metaCreds`: base URL (attributes, then metadata) and bearer token (attributes, then metadata). */
export const metaCreds = (credential: CredentialSnapshot): MetaCreds => {
  const { attributes, metadata } = credential;
  let baseUrl = text(attributes["base_url"]) || META_DEFAULT_BASE_URL;
  const token = usableToken(attributes["api_key"]) || usableToken(attributes["access_token"]);

  if (baseUrl === META_DEFAULT_BASE_URL) {
    baseUrl = text(metadata["base_url"]) || text(metadata["api_base_url"]) || baseUrl;
  }

  return {
    baseUrl,
    token: token || usableToken(metadata["api_key"]) || usableToken(metadata["access_token"]),
  };
};

/** The credential's token or the Go 401 `ensureAuth` failure (config keys cannot mint from a DCA token). */
export const requireMetaToken = (credential: CredentialSnapshot): MetaCreds => {
  const creds = metaCreds(credential);

  if (creds.token !== "") return creds;

  const message =
    credential.kind === "apikey"
      ? "meta executor: meta-api-key requires a valid provider key (DCA tokens require OAuth storage)"
      : "meta executor: missing provider key or access token";

  throw new ExecutionError({ status: 401, message });
};
