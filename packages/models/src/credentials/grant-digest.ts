/**
 * The digest of a credential's refresh token that a reported result carries (`ReportResult.grantDigest`): an
 * account-wide signal reported against an older credential version still applies when the refresh token is the same
 * (Go `isStaleResultForCurrentAuth` compares the refresh tokens themselves; the report carries only a digest).
 */
import { sha256Hex } from "@commissary/core";
import type { Json } from "@commissary/json";

/**
 * A short digest of a token (the first 16 hex digits of its trimmed SHA-256): enough to tell two grants apart in a key
 * or a report without carrying the token.
 */
export const shortDigest = (token: string): string => sha256Hex(token.trim()).slice(0, 16);

/** {@link shortDigest} of the refresh token, `undefined` without one. */
export const grantDigestOf = (metadata: Readonly<Record<string, Json>>): string | undefined => {
  const token = metadata["refresh_token"];

  return typeof token === "string" && token.trim() !== "" ? shortDigest(token) : undefined;
};
