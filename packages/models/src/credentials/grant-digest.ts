/**
 * The digest of a credential's refresh token that a reported result carries (`ReportResult.grantDigest`): an
 * account-wide signal reported against an older credential version still applies when the refresh token is the same
 * (Go `isStaleResultForCurrentAuth` compares the refresh tokens themselves; the report carries only a digest).
 */
import { sha256Hex } from "@commissary/core";
import type { Json } from "@commissary/json";

/** `sha256Hex(refresh_token).slice(0, 16)`, `undefined` without a refresh token. */
export const grantDigestOf = (metadata: Readonly<Record<string, Json>>): string | undefined => {
  const token = metadata["refresh_token"];

  return typeof token === "string" && token.trim() !== ""
    ? sha256Hex(token.trim()).slice(0, 16)
    : undefined;
};
