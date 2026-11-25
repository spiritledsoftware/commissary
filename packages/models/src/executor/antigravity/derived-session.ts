/**
 * Antigravity `request.sessionId` values: signed 64-bit decimal ids like the ones Antigravity Hub sends, hashed with
 * FNV-1a (CLIProxyAPI 55e5a7ea) and scoped per credential (3a24d03c, 14e12fb5).
 *
 * Go source: internal/runtime/executor/helps/derived_session.go (`HashAntigravitySessionID`,
 * `DerivedAntigravitySessionID`, `AntigravitySessionIDForAuth`, `ScopeAntigravitySessionIDForAuth`).
 */

const encoder = new TextEncoder();

const FNV_OFFSET = 0xcbf29ce484222325n;

const FNV_PRIME = 0x100000001b3n;

const MASK64 = 0xffffffffffffffffn;

/**
 * `HashAntigravitySessionID`: 64-bit FNV-1a of `input`, formatted as a signed int64 (about half the ids are negative).
 */
export const hashAntigravitySessionId = (input: string): string => {
  let hash = FNV_OFFSET;

  for (const byte of encoder.encode(input)) hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & MASK64;

  return BigInt.asIntN(64, hash).toString();
};

/**
 * `DerivedAntigravitySessionID`: the derived session identity as an Antigravity session id. The variable identity goes
 * before the fixed domain suffix so trailing-byte differences still reach the sign bit.
 */
export const derivedAntigravitySessionId = (derivedId: string): string => {
  const id = derivedId.trim();

  if (id === "") return "";

  return hashAntigravitySessionId(`${id}\0cli-proxy-api:antigravity:derived-session`);
};

const formatForCredential = (kind: string, credentialId: string, identity: string): string => {
  const value = identity.trim();

  if (value === "") return "";

  return hashAntigravitySessionId(
    [value, credentialId.trim(), kind, "antigravity", "cli-proxy-api"].join("\0"),
  );
};

/** The request's session identities, most specific first (Go `antigravitySessionIdentity`). */
export interface AntigravitySessionIdentities {
  /** The canonical (explicit) session of the request (`ExecutionMetadata.sessionId`). */
  readonly canonical?: string | undefined;
  /** The long-lived execution session (the downstream WebSocket's id). */
  readonly execution?: string | undefined;
  /** The context-derived identity (`ExecutionMetadata.derivedSessionId`). */
  readonly derived?: string | undefined;
}

/**
 * `AntigravitySessionIDForAuth`: the request's canonical, else execution, else derived, identity scoped to one credential. Empty when
 * the request has neither.
 */
export const antigravitySessionIdForCredential = (
  credentialId: string,
  identities: AntigravitySessionIdentities,
): string => {
  const canonical = identities.canonical?.trim() ?? "";

  if (canonical !== "") return formatForCredential("canonical-session", credentialId, canonical);
  const execution = identities.execution?.trim() ?? "";

  if (execution !== "") return formatForCredential("execution-session", credentialId, execution);
  const derived = identities.derived?.trim() ?? "";

  return derived === "" ? "" : formatForCredential("derived-session", credentialId, derived);
};

/**
 * `ScopeAntigravitySessionIDForAuth`: a client's own `request.sessionId` scoped to one credential, so two credentials
 * never share an upstream session. Without a credential id the trimmed id is returned unchanged.
 */
export const scopeAntigravitySessionIdForCredential = (
  credentialId: string,
  sessionId: string,
): string => {
  const id = sessionId.trim();

  if (id === "") return "";

  return credentialId.trim() === ""
    ? id
    : formatForCredential("explicit-session", credentialId, id);
};
