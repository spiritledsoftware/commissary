/**
 * Upstream headers of the OpenCode Zen/Go gateways.
 *
 * Deliberate deviation from Go (no OpenCode provider there; see docs/ARCHITECTURE.md "OpenCode Zen and OpenCode
 * Go"). The gateways want a stable `x-opencode-session` per conversation (OpenCode Go answers 400 `MissingSessionID`
 * without one) and a client of its own (`User-Agent`, `x-opencode-client`). Each protocol authenticates with its SDK's
 * native header: `Authorization: Bearer` for chat, Responses and System One, `x-api-key` (plus `anthropic-version`) for
 * Messages, `x-goog-api-key` for Gemini. Configured custom headers (`header:<Name>` attributes) are applied last and win.
 */
import type { OpenCodeProtocol } from "../../config/schema.ts";
import { normalizeExplicitId } from "../../handlers/session.ts";
import { applyCustomHeaders } from "../helps/custom-headers.ts";
import { providerSessionUuid } from "../helps/uuid.ts";
import type { CredentialSnapshot } from "../picker.ts";
import { forwardedClientHeaders } from "../systemone/executor.ts";
import type { ExecutorOptions } from "../types.ts";
import { isOpenCodeSessionId, openCodeSessionIdOf } from "./session-id.ts";

/**
 * Stable client identity of uncloaked requests. Cloaked requests (OpenCode Zen's free tier, ADR 0033) pose as
 * OpenCode's client on purpose: they keep `commissary` first and add an OpenCode client token after it
 * (`OPENCODE_CLOAKED_USER_AGENT`).
 */
export const OPENCODE_USER_AGENT = "commissary";

/** OpenCode release named in the cloaked User-Agent; raise it when Zen answers 426 `UpgradeRequired`. */
export const OPENCODE_CLOAK_VERSION = "2.0.32";

/** User-Agent of a cloaked request: Commissary first, then the OpenCode client token Zen looks for. */
export const OPENCODE_CLOAKED_USER_AGENT = `commissary opencode/latest/${OPENCODE_CLOAK_VERSION}/commissary`;

/** `x-opencode-client` value. */
export const OPENCODE_CLIENT = "commissary";

/** Header carrying the conversation id. */
export const OPENCODE_SESSION_HEADER = "x-opencode-session";

export const ANTHROPIC_VERSION = "2023-06-01";

/** Namespace of the derived session UUIDs (`providerSessionUuid`). */
const SESSION_NAMESPACE = "opencode";

/**
 * The `x-opencode-session` value of a request: the client's own `x-opencode-session` unchanged; else a stable UUID of
 * the explicit session identity, the WebSocket execution session or the derived conversation identity; else a random
 * UUID. Another client's raw session id is never forwarded.
 *
 * A cloaked request (ADR 0033) needs OpenCode's `ses_` format: the client's own value is kept only when it has that
 * format, and the derived and random ids are converted to it (`openCodeSessionIdOf`).
 */
export const openCodeSessionId = (options: ExecutorOptions, cloaked = false): string => {
  const own = normalizeExplicitId(options.headers.get(OPENCODE_SESSION_HEADER) ?? undefined);

  if (own !== "" && (!cloaked || isOpenCodeSessionId(own))) return own;
  const format = (uuid: string) => (cloaked ? openCodeSessionIdOf(uuid) : uuid);

  const candidates = [
    ["session", options.metadata.sessionId],
    ["execution-session", options.metadata.websocket?.sessionId],
    ["derived-session", options.metadata.derivedSessionId],
  ] as const;

  for (const [kind, identity] of candidates) {
    const uuid = providerSessionUuid(SESSION_NAMESPACE, kind, identity);

    if (uuid !== "") return format(uuid);
  }

  return format(crypto.randomUUID());
};

/** Auth headers of a protocol. */
export const openCodeAuthHeaders = (protocol: OpenCodeProtocol, providerKey: string) => {
  switch (protocol) {
    case "messages":
      return { "x-api-key": providerKey, "anthropic-version": ANTHROPIC_VERSION };
    case "gemini":
      return { "x-goog-api-key": providerKey };
    default:
      return { authorization: `Bearer ${providerKey}` };
  }
};

/** Client identity and session headers shared by every protocol (`cloaked`: the free-tier markers, ADR 0033). */
export const openCodeIdentityHeaders = (options: ExecutorOptions, cloaked = false) => ({
  "user-agent": cloaked ? OPENCODE_CLOAKED_USER_AGENT : OPENCODE_USER_AGENT,
  "x-opencode-client": OPENCODE_CLIENT,
  [OPENCODE_SESSION_HEADER]: openCodeSessionId(options, cloaked),
});

/**
 * Full request headers of a chat, Responses, Messages or System One attempt: the client headers `forward` names, when
 * sent, after the gateway's own; custom headers applied last.
 */
export const openCodeHeaders = (input: {
  readonly credential: CredentialSnapshot;
  readonly options: ExecutorOptions;
  readonly protocol: OpenCodeProtocol;
  readonly providerKey: string;
  readonly stream: boolean;
  readonly forward?: ReadonlyArray<string>;
  /** Free-tier cloak (ADR 0033). */
  readonly cloaked?: boolean;
}): Record<string, string> => {
  const headers = {
    "content-type": "application/json",
    ...openCodeAuthHeaders(input.protocol, input.providerKey),
    ...openCodeIdentityHeaders(input.options, input.cloaked === true),
    ...(input.stream
      ? { accept: "text/event-stream", "cache-control": "no-cache" }
      : { accept: "application/json" }),
    ...forwardedClientHeaders(input.options, input.forward ?? []),
  };

  return applyCustomHeaders(
    headers,
    input.credential,
    input.options.headers,
    input.options.metadata.sessionId,
  );
};
