/**
 * `/v9/management/oauth/*`: connecting an account (`packages/models/src/management/oauth-routes.ts`,
 * `packages/models/src/oauth/service.ts`). Shared with the browser: imports `effect` only.
 *
 * Two flows. Callback flows (claude, codex, antigravity, devin) answer an authorize `url`; the provider redirects to
 * a localhost page that does not load, and the operator pastes that address into `POST /oauth/callback`. Device
 * flows (xai, copilot, meta, kimi, kimi-ai, and codex with `flow=device`) answer `flow: "device"` with a `user_code` to enter
 * at `url`. Both finish through `GET /oauth/status`, which the panel polls; for device flows each poll also advances
 * the provider check. Status errors come back as HTTP 200 with `status: "error"`.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { managementErrors } from "./errors.ts";

const optional = Schema.optionalKey;

/** The `provider` values `GET /oauth/auth-url` accepts. */
export const OAuthProvider = Schema.Literals([
  "claude",
  "codex",
  "antigravity",
  "devin",
  "xai",
  "copilot",
  "meta",
  "kimi",
  "kimi-ai",
]);

export type OAuthProvider = typeof OAuthProvider.Type;

export const OAuthStart = Schema.Struct({
  status: Schema.Literal("ok"),
  url: Schema.String,
  state: Schema.String,
  flow: optional(Schema.Literal("device")),
  user_code: optional(Schema.String),
  expires_in: optional(Schema.Number),
});

export type OAuthStart = typeof OAuthStart.Type;

export const OAuthProgress = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ok") }),
  Schema.Struct({ status: Schema.Literal("wait") }),
  Schema.Struct({ status: Schema.Literal("error"), error: Schema.String }),
]);

export type OAuthProgress = typeof OAuthProgress.Type;

/**
 * `POST /oauth/import?provider=vertex` (`packages/models/src/management/oauth-import.ts`): a Google service-account key as
 * multipart field `file`, with an optional `location`. Not an HttpApi endpoint (the generated client sends no
 * multipart); the panel posts a `FormData` and decodes the answer with these.
 */
export const VertexImported = Schema.Struct({
  status: Schema.Literal("ok"),
  "auth-file": optional(Schema.String),
  project_id: optional(Schema.String),
  email: optional(Schema.String),
  location: optional(Schema.String),
});

export const VertexImportFailed = Schema.Struct({
  error: Schema.String,
  message: optional(Schema.String),
});

export class OAuthGroup extends HttpApiGroup.make("oauth").add(
  HttpApiEndpoint.get("start", "/oauth/auth-url", {
    query: {
      provider: OAuthProvider,
      flow: optional(Schema.Literal("device")),
      /** The login connects the caller's private account (ADR 0023); a plain member's always does. */
      private: optional(Schema.Literal("true")),
    },
    success: OAuthStart,
    error: managementErrors,
  }),
  HttpApiEndpoint.get("status", "/oauth/status", {
    query: { state: Schema.String },
    success: OAuthProgress,
    error: managementErrors,
  }),
  HttpApiEndpoint.delete("cancel", "/oauth/session", {
    query: { state: Schema.String },
    success: Schema.Struct({ status: Schema.Literal("ok"), cancelled: Schema.Boolean }),
    error: managementErrors,
  }),
  /** Finish a callback flow with the address the provider redirected to. */
  HttpApiEndpoint.post("callback", "/oauth/callback", {
    payload: Schema.Struct({ provider: OAuthProvider, redirect_url: Schema.String }),
    success: Schema.Struct({ status: Schema.Literal("ok") }),
    error: managementErrors,
  }),
) {}
