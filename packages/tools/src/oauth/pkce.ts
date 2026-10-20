/**
 * The random values of a toolkit's OAuth 2 sign-in (#202): the `state` that names the sign-in, and the PKCE S256 pair
 * (RFC 7636). WebCrypto only, never `Math.random`.
 */
import { orgScopedName, type OrgId } from "@commissary/core";

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const randomBytes = (length: number): Uint8Array => crypto.getRandomValues(new Uint8Array(length));

/** Base64url without padding (RFC 7636, Appendix A). */
const base64Url = (bytes: Uint8Array): string => {
  let binary = "";

  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/**
 * A new sign-in's state: 128 random bits as hex, named by its org (`orgScopedName`: `org.<org>.<hex>`, a bare one is
 * `global`'s), so the callback asks only that org's ControlPlane.
 */
export const newSignInState = (org: OrgId): string => orgScopedName(org, toHex(randomBytes(16)));

/** A state as a sign-in's: at most 128 characters of `[A-Za-z0-9._-]`. */
export const isSignInState = (state: string): boolean =>
  state.length > 0 && state.length <= 128 && /^[A-Za-z0-9._-]+$/.test(state);

export interface Pkce {
  readonly verifier: string;
  readonly challenge: string;
}

/** A PKCE S256 pair: a 43-character verifier (32 random bytes) and its challenge. */
export const newPkce = async (): Promise<Pkce> => {
  const verifier = base64Url(randomBytes(32));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));

  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
};
