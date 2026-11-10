/**
 * Contracts of the provider login flows.
 *
 * A flow is the Workers counterpart of one `Request<Provider>Token` management handler: it builds the authorization
 * URL (callback flows) or requests a device code (device flows) and turns the provider's tokens into the auth-file
 * JSON of the Go server. Session bookkeeping, persistence and HTTP routes live in `../service.ts`.
 */
import { Data, type Effect } from "effect";
import type { HttpClient } from "effect/http";
import type { JsonObject } from "@commissary/json";
import type { OAuthProvider } from "../names.ts";

/** A failed step; `message` is what `GET /oauth/status` reports (Go `SetOAuthSessionError` text). */
export class FlowFailure extends Data.TaggedError("FlowFailure")<{ readonly message: string }> {}

export const flowFailure = (message: string): FlowFailure => new FlowFailure({ message });

/** The credential a finished login produces: auth file name and its complete JSON content. */
export interface CredentialRecord {
  readonly fileName: string;
  readonly metadata: JsonObject;
}

export interface CallbackStart {
  readonly url: string;
  /** Secrets needed to finish the login (PKCE verifier); stored in the session row, never returned. */
  readonly data: JsonObject;
}

export interface CallbackFlow {
  readonly kind: "callback";
  readonly provider: OAuthProvider;
  /** Session error when the callback window (5 minutes, like Go) closes without a callback. */
  readonly timeoutMessage: string;
  /** Session error when the provider redirected with an `error` parameter. */
  readonly deniedMessage: string;
  /** Session error when the credential could not be stored. */
  readonly saveMessage: string;
  /** Session state generator; the shared 128-bit hex state when absent. */
  readonly generateState?: () => string;
  readonly start: (input: { readonly state: string }) => Effect.Effect<CallbackStart, FlowFailure>;
  readonly complete: (input: {
    readonly state: string;
    readonly code: string;
    readonly data: JsonObject;
    readonly now: number;
  }) => Effect.Effect<CredentialRecord, FlowFailure, HttpClient.HttpClient>;
}

export interface DeviceStart {
  /** Where the user approves the login (`verification_uri_complete || verification_uri`). */
  readonly url: string;
  readonly userCode?: string;
  /** `expires_in` as reported to the panel (seconds). */
  readonly expiresIn?: number;
  /** Device code and endpoints needed by `poll`; stored in the session row, never returned. */
  readonly data: JsonObject;
  readonly intervalMs: number;
  /** Delay until the first upstream poll (xAI polls immediately, the others wait one interval). */
  readonly firstPollDelayMs: number;
  /** How long the user has to approve. */
  readonly windowMs: number;
}

export type PollOutcome =
  | { readonly _tag: "pending"; readonly intervalMs?: number }
  | { readonly _tag: "done"; readonly record: CredentialRecord };

export interface DeviceFlow {
  readonly kind: "device";
  readonly provider: OAuthProvider;
  /** Session error when the approval window closed. */
  readonly expiredMessage: string;
  readonly saveMessage: string;
  /** Response of `/oauth/auth-url` when the start request itself fails (`500 {"error": ...}`). */
  readonly startFailureMessage: string;
  readonly start: () => Effect.Effect<DeviceStart, FlowFailure, HttpClient.HttpClient>;
  /** One upstream poll. `FlowFailure` ends the login with that message. */
  readonly poll: (input: {
    readonly data: JsonObject;
    readonly now: number;
    /** The current poll interval (it may have grown through `slow_down`). */
    readonly intervalMs: number;
  }) => Effect.Effect<PollOutcome, FlowFailure, HttpClient.HttpClient>;
}

export type Flow = CallbackFlow | DeviceFlow;
