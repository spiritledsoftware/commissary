/**
 * Meta Muse client identity.
 *
 * Go source: internal/runtime/executor/meta_executor_execute.go (`applyMetaClientIdentity`, `isMetaContributorModel`).
 * The headers Muse Code 1.4.14 sends on `/responses`. The session ids are a fresh UUID v7 per request so proxy traffic does
 * not reuse one Muse session across unrelated clients. `X-Tbh-Contributor-Mode` is a training opt-in, sent only for
 * `-contributor` models.
 */
import { parseSuffix } from "@commissary/translation/thinking";
import { META_CLIENT_ID, META_USER_AGENT } from "./credentials.ts";

/** Fresh UUID v7 (RFC 9562): 48-bit millisecond timestamp, then random bits. */
const uuidV7 = (nowMs: number): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const time = BigInt(nowMs);

  for (let i = 0; i < 6; i++) bytes[i] = Number((time >> BigInt(8 * (5 - i))) & 0xffn);
  // SAFETY: indexes 6 and 8 are inside the 16-byte array.
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** The model (thinking suffix removed) ends in `-contributor`. */
const isMetaContributorModel = (model: string): boolean =>
  parseSuffix(model.trim()).modelName.trim().toLowerCase().endsWith("-contributor");

/** `model` is the effective model after the payload rules. */
export const metaIdentityHeaders = (model: string, nowMs: number) => {
  const session = uuidV7(nowMs);

  const headers = {
    "user-agent": META_USER_AGENT,
    "x-client-id": META_CLIENT_ID,
    "x-tbh-session-id": session,
    "x-meta-ai-gateway-session-id": session,
    "x-tbh-thread-id": session,
    "x-tbh-root-session-id": session,
    "x-tbh-agent-role": "main",
  };

  return isMetaContributorModel(model) ? { ...headers, "x-tbh-contributor-mode": "1" } : headers;
};
