/**
 * The hub API's relayed calls (ADR 0052): the seven provider endpoints an allowance reader such as T3 Code may have
 * Commissary call with an account's token (`POST /v0/management/api-call`), and nothing else. Go's `api-call`
 * (internal/api/handlers/management/api_tools.go) sends a token to any URL; here a call must match an entry's method
 * and URL exactly, and Commissary builds the headers (`probeHeaders`, the quota check's) and the bodies itself: the
 * caller's `header` is never read, and its `data` only for a Codex reset-credit redemption, rebuilt from its two
 * fields. Pure: matching runs before any RPC or fetch.
 */
import { Option, Schema } from "effect";
import { type Json, tryParseJson } from "@commissary/json";
import { ANTIGRAVITY_QUOTA_URLS } from "../quota/antigravity.ts";
import { CLAUDE_USAGE_URL } from "../quota/claude.ts";
import { CODEX_USAGE_URL } from "../quota/codex.ts";
import { XAI_BILLING_WEEKLY_URL } from "../quota/xai.ts";

/** The providers whose accounts the hub API lists (Commissary's executor keys). */
export const HUB_PROVIDERS = ["codex", "claude", "xai", "antigravity"] as const;

export type HubProvider = (typeof HUB_PROVIDERS)[number];

export const isHubProvider = (provider: string): provider is HubProvider =>
  HUB_PROVIDERS.some((hub) => hub === provider);

/** What an entry sends as its body: nothing, the caller's checked JSON, or `{ project }` from the stored account. */
type BodyKind = "none" | "credit" | "project";

export interface HubCall {
  /** Names the entry in logs. */
  readonly id: string;
  readonly provider: HubProvider;
  readonly method: "GET" | "POST";
  /** As `URL.href` writes it. */
  readonly url: string;
  readonly body: BodyKind;
}

const CODEX_RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";

export const HUB_CALLS: ReadonlyArray<HubCall> = [
  { id: "codex-usage", provider: "codex", method: "GET", url: CODEX_USAGE_URL, body: "none" },
  {
    id: "codex-reset-credits",
    provider: "codex",
    method: "GET",
    url: CODEX_RESET_CREDITS_URL,
    body: "none",
  },
  {
    id: "codex-reset-credit-consume",
    provider: "codex",
    method: "POST",
    url: `${CODEX_RESET_CREDITS_URL}/consume`,
    body: "credit",
  },
  { id: "claude-usage", provider: "claude", method: "GET", url: CLAUDE_USAGE_URL, body: "none" },
  { id: "xai-billing", provider: "xai", method: "GET", url: XAI_BILLING_WEEKLY_URL, body: "none" },
  {
    id: "antigravity-quota-summary",
    provider: "antigravity",
    method: "POST",
    // The daily host, first of the quota check's hosts.
    url: ANTIGRAVITY_QUOTA_URLS[0],
    body: "project",
  },
  {
    id: "antigravity-userinfo",
    provider: "antigravity",
    method: "GET",
    url: "https://www.googleapis.com/oauth2/v2/userinfo",
    body: "none",
  },
];

/** The redemption of a Codex reset credit: exactly these two fields. */
const ResetCredit = Schema.Struct({
  redeem_request_id: Schema.String.check(Schema.isUUID()),
  credit_id: Schema.String.check(Schema.isMaxLength(200)),
});

const decodeResetCredit = Schema.decodeUnknownOption(ResetCredit, { onExcessProperty: "error" });

/** The body a matched call sends: none, this JSON, or `{ project }` from the stored account (filled in by the relay). */
export type HubCallBody =
  | { readonly kind: "none" }
  | { readonly kind: "json"; readonly value: typeof ResetCredit.Type }
  | { readonly kind: "project" };

export interface MatchedCall {
  readonly entry: HubCall;
  readonly body: HubCallBody;
}

export type HubCallMatch =
  | { readonly ok: true; readonly call: MatchedCall }
  | { readonly ok: false; readonly error: string };

export const CALL_NOT_ALLOWED = "call not allowed";

const refuse = (error: string): HubCallMatch => ({ ok: false, error });

/** The authority of an absolute URL as written (between `//` and the path), lowercased; `undefined` without one. */
const writtenAuthority = (url: string): string | undefined =>
  /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url)?.[1]?.toLowerCase();

/**
 * The entry `url` names: `https`, no user info, no port (not even `:443`, which `URL` would drop), no fragment, and the
 * same `href` as the entry's (so no other query, no trailing slash).
 */
const entryFor = (url: string): HubCall | undefined => {
  const authority = writtenAuthority(url.trim());

  if (authority === undefined || authority.includes("@") || authority.includes(":"))
    return undefined;

  if (url.includes("#")) return undefined;
  let parsed: URL;

  try {
    parsed = new URL(url.trim());
  } catch {
    return undefined;
  }

  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "")
    return undefined;

  return HUB_CALLS.find((entry) => entry.url === parsed.href);
};

/** `data` as sent: absent for `undefined`, `null` and the empty string. */
const absent = (data: Json | undefined): boolean =>
  data === undefined || data === null || data === "";

/** The JSON value `data` stands for: a JSON text is parsed (Go's `data` is a string), anything else is taken as it is. */
const jsonOf = (data: Json | undefined): Json | undefined =>
  typeof data === "string" ? tryParseJson(data) : data;

/**
 * The relayed call a request names (`method`, `url` and `data` of `POST /v0/management/api-call`), or why it is
 * refused (a 400): `call not allowed` for a method and URL off the list, another message for a body the entry does not
 * take. Which account it is for is checked after the account is resolved.
 */
export const matchHubCall = (method: string, url: string, data: Json | undefined): HubCallMatch => {
  const entry = entryFor(url);

  if (entry === undefined || entry.method !== method.trim().toUpperCase())
    return refuse(CALL_NOT_ALLOWED);

  switch (entry.body) {
    case "none":
      return absent(data)
        ? { ok: true, call: { entry, body: { kind: "none" } } }
        : refuse("this call takes no data");
    case "project":
      return { ok: true, call: { entry, body: { kind: "project" } } };
    case "credit": {
      const credit = decodeResetCredit(jsonOf(data));

      return Option.isSome(credit)
        ? { ok: true, call: { entry, body: { kind: "json", value: credit.value } } }
        : refuse("data must be { redeem_request_id, credit_id }");
    }
  }
};
