/**
 * Executor-facing request/response types and the provider executor interface.
 *
 * Go source: sdk/cliproxy/executor/types.go (Request, Options, Response, StreamResult, metadata keys),
 * sdk/cliproxy/auth/conductor.go (ProviderExecutor). Executors own the canonical per-attempt pipeline:
 * translate request (client -> provider format) -> upstream model -> thinking -> provider shaping -> payload rules
 * (always last) -> upstream fetch -> translate response (provider -> client format, one SSE line at a time).
 */
import type { Effect, Stream } from "effect";
import type { HttpClient } from "effect/http";
import type { Config } from "../config/schema.ts";
import type { Json } from "@commissary/json";
import type { ModelInfoLookup, ThinkingModelInfo } from "@commissary/translation/thinking";
import type { Format } from "@commissary/translation/formats";
import type { UsageReporter } from "../usage/reporter.ts";
import type { ExecutionError } from "./errors.ts";
import type { CredentialSnapshot } from "./picker.ts";
import type { Thinking } from "./thinking.ts";

/** Go `executor.Request`. */
export interface ExecutorRequest {
  /** Model to execute for this credential (prefix stripped, alias resolved, `(suffix)` kept). */
  readonly model: string;
  /** Client body (entry-protocol format); executors must not mutate it. */
  readonly payload: Json;
  /**
   * Capabilities of the selected model as resolved for this credential (Go `attachResolvedExecutionModelInfo`).
   * Executors pass it to `Thinking.apply`; `undefined` = unknown model (no validation).
   */
  readonly modelInfo?: ThinkingModelInfo | undefined;
  /** Registry lookup (`registry.LookupModelInfo`) for models other than the selected one; pass to `Thinking.apply`. */
  readonly modelLookup?: ModelInfoLookup | undefined;
}

/**
 * Go `WithWebsocketInput` / `WithWebsocketAuthCheck`: the single downstream reader of a Responses WebSocket, handed to a
 * Codex executor that runs the socket full duplex (`upstream.codex.response-steering`).
 */
export interface WebsocketDuplex {
  /**
   * The next client frame; `undefined` once the downstream socket is gone. Fails with a read error. Only one consumer may
   * wait at a time.
   */
  readonly next: Effect.Effect<string | undefined, ExecutionError>;
  /** Whether the credential may still carry traffic (Go: the credential exists and is not disabled). Defaults to true. */
  readonly authEnabled?: (credentialId: string) => boolean;
}

/** Go `WithDownstreamWebsocket` / `ExecutionSessionMetadataKey` / `WithRequiredUpstreamWebsocket`. */
export interface WebsocketExecution {
  /** Id of the downstream socket: the execution session that owns the upstream sockets. */
  readonly sessionId: string;
  /** The request continues a response and needs the live upstream socket (else: replay with full input). */
  readonly requireUpstream: boolean;
  /** Present when the handler lets the Codex executor own the socket (response steering). */
  readonly duplex?: WebsocketDuplex;
}

/** Typed subset of Go `Options.Metadata` (sdk/api/handlers/handlers.go requestExecutionMetadata). */
export interface ExecutionMetadata {
  /** Inbound route path, e.g. `/v1/chat/completions` (payload rules, image endpoints). */
  readonly requestPath: string;
  /** Model string exactly as the client sent it (suffix/prefix included). */
  readonly requestedModel: string;
  readonly idempotencyKey?: string;
  /** Client-requested reasoning effort (usage logs). */
  readonly reasoningEffort?: string;
  /** Body `service_tier`, else `auto`. */
  readonly serviceTier: string;
  /** `false` only when the client sent `generate: false`. */
  readonly generate: boolean;
  /** Caller isolation scope (Access principal). */
  readonly callerScope: string;
  /** Session identity for affinity/prompt caching, when known. */
  readonly sessionId?: string;
  /**
   * Context-derived identity (`ctx:v1:<sha256>`, Go `derived_session_id`): only present when the request carries no
   * explicit session marker. Provider prompt-cache keys hash it (`DerivedSessionUUID`).
   */
  readonly derivedSessionId?: string;
  /** Set for requests that arrive over the Responses WebSocket (`handlers/responses/websocket`). */
  readonly websocket?: WebsocketExecution;
  /**
   * Antigravity credits fallback round: the attempt asks for `enabledCreditTypes: ["GOOGLE_ONE_AI"]`
   * (Go `cliproxyauth.WithAntigravityCredits`).
   */
  readonly antigravityCredits?: boolean;
}

/** Go `executor.Options`. */
export interface ExecutorOptions {
  readonly stream: boolean;
  /** Gemini `alt` (`""` = SSE) or an internal route tag such as `responses/compact`. */
  readonly alt: string;
  /** Inbound request headers (payload rule header conditions, `$Header` custom header expansion). */
  readonly headers: Headers;
  readonly query: URLSearchParams;
  /** Client body before any handler-level rewrite (baseline for `default` payload rules). */
  readonly originalRequest: Json | undefined;
  /** Entry protocol of the request. */
  readonly sourceFormat: Format;
  /** Protocol of the response the client expects (defaults to `sourceFormat`). */
  readonly responseFormat?: Format;
  readonly metadata: ExecutionMetadata;
  /**
   * The file parts of a multipart System One request (`systemone` source format, ADR 0032), by part name; the JSON
   * `request` part is the payload. Each attempt reads them afresh (a `File` can be read again), so retries and failover
   * resend the same bytes.
   */
  readonly systemOneParts?: ReadonlyMap<string, File>;
}

/** Go `ResponseFormatOrSource`. */
export const responseFormatOf = (options: ExecutorOptions): Format =>
  options.responseFormat ?? options.sourceFormat;

/** Everything an attempt needs besides the request: credential, config snapshot and usage collector. */
export interface ExecutionContext {
  readonly credential: CredentialSnapshot;
  readonly config: Config;
  readonly usage: UsageReporter;
}

export interface ExecutorResponse {
  /** Client-format body. */
  readonly payload: string;
  /** Binary body (audio); when set, `payload` is empty and handlers write these bytes verbatim. */
  readonly bytes?: Uint8Array | undefined;
  /** Upstream response headers (forwarded only with `passthrough-headers`). */
  readonly headers: Headers;
}

export interface StreamResult {
  readonly headers: Headers;
  /**
   * Complete client-format chunks: bare JSON for OpenAI/Gemini, `event:`/`data:` framed text for Claude, Responses
   * and Interactions. Failures after the first chunk end the stream with an `ExecutionError`.
   */
  readonly chunks: Stream.Stream<string, ExecutionError>;
}

/** Services available to executors. */
export type ExecutorServices = HttpClient.HttpClient | Thinking;

/** Go `ProviderExecutor` (Refresh lives in the credential refresh slice). */
export interface ProviderExecutor {
  /** Provider key handled by this executor. */
  readonly identifier: string;
  readonly execute: (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) => Effect.Effect<ExecutorResponse, ExecutionError, ExecutorServices>;
  readonly executeStream: (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) => Effect.Effect<StreamResult, ExecutionError, ExecutorServices>;
  readonly countTokens: (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) => Effect.Effect<ExecutorResponse, ExecutionError, ExecutorServices>;
}
