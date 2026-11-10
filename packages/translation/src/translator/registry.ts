/**
 * Translator registry keyed by (client format, provider format).
 *
 * Go source: sdk/translator/registry.go, sdk/translator/types.go. Differences from Go:
 *  - Both maps are keyed by `(client, provider)` and every method takes named `client`/`provider` arguments, so the
 *    inverted argument order of Go's `TranslateStream(ctx, from=provider, to=client, ...)` does not leak into callers.
 *  - Request transforms work on parsed JSON (`Json`) and receive a private deep copy of the body. Response transforms
 *    work on raw text (one upstream SSE line, or the whole non-stream body) and return complete client-protocol
 *    chunks as text: OpenAI/Gemini chunks are bare JSON, Claude/Responses/Interactions chunks carry their own
 *    `event:`/`data:` framing (see `sse.ts`).
 *  - Go's `param *any` per-request state is {@link TranslationState}; each translator lazily initialises
 *    `state.value` on its first call. A translator that retains a tool-input failure sets `state.toolInputError`,
 *    which suppresses the raw fallback (executors then answer 502).
 *  - Plugin hooks are not ported. The thinking summary hooks (`ExtractTranslatedSummaryConfig` /
 *    `ApplySummaryConfigForModel`) are injected through {@link SummaryHooks} so the thinking slice owns them.
 */
import { cloneJson, get, type Json, set } from "@commissary/json";
import { applyClaudeInputTokens, type ClaudeInputTokenState } from "../tokenizer/claude-input.ts";
import type { SummaryConfig } from "../thinking/index.ts";
import { restoreCodexCommentaryMarkers } from "../signature/claude-messages.ts";
import { Formats, type Format } from "./formats.ts";
import type { ThinkingModelInfo } from "../thinking/types.ts";

/** A request translator refused the request (Go `RequestEnvelope.Err`); maps to a request-scoped 400. */
export class TranslationError extends Error {
  override readonly name = "TranslationError";
  constructor(
    message: string,
    readonly status = 400,
    /** The translated body produced alongside the refusal (Go returns both); never to be sent upstream. */
    readonly body?: Json,
  ) {
    super(message);
  }
}

export interface RequestEnvelope {
  readonly format: Format;
  /** Upstream base model (suffix stripped). */
  readonly model: string;
  readonly stream: boolean;
  readonly body: Json;
  /** Resolved model info for envelope transforms that need it (Go `RequestEnvelope.ModelInfo`). */
  readonly modelInfo?: ThinkingModelInfo | undefined;
  /** Set by translators/normalisers that changed Responses `configuration_update` items. */
  readonly configurationUpdatesChanged?: boolean;
  /** Request-scoped refusal raised by the transform. */
  readonly error?: TranslationError;
}

/** What the caller of {@link TranslatorRegistry.translateRequest} decided about this attempt, for transforms that care. */
export interface TranslateRequestOptions {
  /** The executed model has `is-compat`: selects the registered compat variant of the transform. */
  readonly compat?: boolean;
  /**
   * Responses -> Claude: every system-level input item becomes a top-level system block (`true`, and the default when
   * absent) instead of mid-session text-only items staying in place as `role: "system"` turns (`false`). The Claude
   * executor decides it per attempt (Go `WithTopLevelSystemItems`).
   */
  readonly topLevelSystemItems?: boolean;
}

/**
 * Client body -> provider body. May throw {@link TranslationError}. The body is a private copy and may be mutated.
 * `options` are the request's, for the few transforms that read them.
 */
export type RequestTransform = (
  model: string,
  body: Json,
  stream: boolean,
  options?: TranslateRequestOptions,
) => Json;

/** Envelope-aware variant (Go `RequestEnvelopeTransform`). */
export type RequestEnvelopeTransform = (
  envelope: RequestEnvelope,
  options?: TranslateRequestOptions,
) => RequestEnvelope;

/** Per-request mutable translator state (Go `param *any`). Allocate one per upstream attempt. */
export interface TranslationState extends ClaudeInputTokenState {
  value: unknown;
  /** A retained tool-input translation failure; suppresses raw fallbacks (Go `ToolInputError()`). */
  toolInputError?: string;
  /**
   * Set by Responses translators that can synthesise a terminal event when the upstream closes without `[DONE]`
   * (Go `CanFinalizeResponseStream()`).
   */
  canFinalize?: boolean;
  /**
   * Go `FinalizeToolInput()`: called when the upstream transport ends. A translator with a patch-enabled stream that
   * has not completed returns the terminal failure frames (and retains `toolInputError`); it never fabricates success.
   */
  finalizeToolInput?: () => ReadonlyArray<string>;
}

export const makeTranslationState = (): TranslationState => ({ value: undefined });

export interface ResponseContext {
  /** Model the client asked for (Go `req.Model`, suffix kept). */
  readonly model: string;
  /** The client's original request body. */
  readonly originalRequest: Json | undefined;
  /** The translated (provider-format) request body. */
  readonly translatedRequest: Json | undefined;
  readonly state: TranslationState;
  /**
   * The Gemini `alt` request option (Go `ctx.Value("alt")`): `""` = SSE, another value = raw chunks, `undefined` =
   * not a Gemini-entry request. Only the Antigravity Gemini response translator reads it.
   */
  readonly alt?: string;
}

/** One upstream line -> zero or more complete client chunks. */
export type ResponseStreamTransform = (
  context: ResponseContext,
  line: string,
) => ReadonlyArray<string>;

/** Whole upstream body -> client body; `undefined` signals a translation failure (Go `nil`). */
export type ResponseNonStreamTransform = (
  context: ResponseContext,
  body: string,
) => string | undefined;

/** Locally computed token count -> client body. */
export type ResponseTokenCountTransform = (count: number) => string;

export interface ResponseTransform {
  readonly stream?: ResponseStreamTransform;
  readonly nonStream?: ResponseNonStreamTransform;
  readonly tokenCount?: ResponseTokenCountTransform;
}

/** Opaque summary intent handed from `extract` to `apply` (a thinking `SummaryConfig`, or a plain JSON value in tests). */
export type SummaryIntent = Json | SummaryConfig | undefined;

/** Reasoning-summary visibility hooks applied around request transforms (owned by the thinking pipeline). */
export interface SummaryHooks {
  /** Reads the client's summary intent from the source body (`thinking.ExtractTranslatedSummaryConfig`). */
  readonly extract: (body: Json, client: Format, provider: Format) => SummaryIntent;
  /** Writes it into the translated body (`thinking.ApplySummaryConfigForModel`); may mutate and return `body`. */
  readonly apply: (body: Json, provider: Format, model: string, summary: SummaryIntent) => Json;
}

export const noopSummaryHooks: SummaryHooks = { extract: () => undefined, apply: (body) => body };

const key = (client: Format, provider: Format) => `${client}\u0000${provider}`;

const wrapRequestTransform =
  (request: RequestTransform): RequestEnvelopeTransform =>
  (envelope, options) => {
    try {
      return {
        ...envelope,
        body: request(envelope.model, envelope.body, envelope.stream, options),
      };
    } catch (error) {
      if (error instanceof TranslationError) {
        return { ...envelope, ...(error.body !== undefined ? { body: error.body } : {}), error };
      }

      throw error;
    }
  };

const hasAny = (transform: ResponseTransform | undefined): boolean =>
  transform !== undefined &&
  (transform.stream !== undefined ||
    transform.nonStream !== undefined ||
    transform.tokenCount !== undefined);

export class TranslatorRegistry {
  readonly #requests = new Map<string, RequestEnvelopeTransform>();
  readonly #responses = new Map<string, ResponseTransform>();
  /** Compat-model variants of request transforms (`*WithCompat`), used when the executed model has `is-compat`. */
  readonly #compatRequests = new Map<string, RequestEnvelopeTransform>();

  /** `Register(from=client, to=provider, request, response)`. */
  register(
    client: Format,
    provider: Format,
    request: RequestTransform | undefined,
    response: ResponseTransform,
  ): this {
    if (request !== undefined)
      this.#requests.set(key(client, provider), wrapRequestTransform(request));
    this.#responses.set(key(client, provider), response);

    return this;
  }

  /**
   * Registers the compat variant of a request transform (`ConvertClaudeRequestToGeminiWithCompat`, ...). Go selects
   * these in `helps.TranslateRequestWithAPIKeyModelCompatibility` for models configured `is-compat`; responses use
   * the normal transforms.
   */
  registerCompatRequest(client: Format, provider: Format, request: RequestTransform): this {
    this.#compatRequests.set(key(client, provider), wrapRequestTransform(request));

    return this;
  }

  registerRequestEnvelope(
    client: Format,
    provider: Format,
    request: RequestEnvelopeTransform,
  ): this {
    this.#requests.set(key(client, provider), request);

    return this;
  }

  unregister(client: Format, provider: Format): this {
    this.#requests.delete(key(client, provider));
    this.#responses.delete(key(client, provider));

    return this;
  }

  hasCompatRequestTransformer(client: Format, provider: Format): boolean {
    return this.#compatRequests.has(key(client, provider));
  }

  hasRequestTransformer(client: Format, provider: Format): boolean {
    return this.#requests.has(key(client, provider));
  }

  hasResponseTransformer(client: Format, provider: Format): boolean {
    return hasAny(this.#responses.get(key(client, provider)));
  }

  hasStreamResponseTransformer(client: Format, provider: Format): boolean {
    return this.#responses.get(key(client, provider))?.stream !== undefined;
  }

  hasNonStreamResponseTransformer(client: Format, provider: Format): boolean {
    return this.#responses.get(key(client, provider))?.nonStream !== undefined;
  }

  /**
   * `TranslateRequestEnvelope`: runs the registered transform on a copy of the body, wrapped in the summary hooks.
   * Without a transform the body is only copied and its `model` forced to `envelope.model` (so client-side prefixes
   * such as `team/gpt-5` never reach the upstream).
   */
  translateRequest(
    client: Format,
    provider: Format,
    envelope: RequestEnvelope,
    hooks: SummaryHooks = noopSummaryHooks,
    options: TranslateRequestOptions = {},
  ): RequestEnvelope {
    // The internal Codex commentary marker is restored as assistant text before any thinking handling, for every
    // Claude-source request whose target is not Codex (which restores it as a commentary message itself); this also
    // covers Claude -> Claude, which has no transform and no signature sanitising.
    const cloned = cloneJson(envelope.body);

    const input: RequestEnvelope = {
      ...envelope,
      body:
        client === Formats.Claude && provider !== Formats.Codex
          ? restoreCodexCommentaryMarkers(cloned).payload
          : cloned,
    };

    const transform =
      (options.compat === true ? this.#compatRequests.get(key(client, provider)) : undefined) ??
      this.#requests.get(key(client, provider));

    if (transform !== undefined) {
      const summary = hooks.extract(input.body, client, provider);
      const out = transform(input, options);

      if (out.error !== undefined) return { ...out, format: provider };

      return {
        ...out,
        body: hooks.apply(out.body, provider, out.model, summary),
        format: provider,
      };
    }

    let body = input.body;

    if (envelope.model !== "") {
      const current = get(body, "model");

      if (typeof current !== "string" || current !== envelope.model) {
        try {
          body = set(body, "model", envelope.model);
        } catch {
          // Go logs a warning and keeps the body when sjson cannot set the field (e.g. non-object bodies).
        }
      }
    }

    return { ...input, body, format: provider };
  }

  /**
   * `TranslateStream`: without a stream transform the upstream line is passed through unchanged. Claude clients served
   * by another protocol get the estimated input tokens in `message_start` (Go `TranslateStreamWithClaudeInputTokens`).
   */
  translateStream(
    client: Format,
    provider: Format,
    context: ResponseContext,
    line: string,
  ): ReadonlyArray<string> {
    const transform = this.#responses.get(key(client, provider))?.stream;
    const chunks = transform === undefined ? [line] : transform(context, line);

    return client === Formats.Claude && provider !== Formats.Claude
      ? applyClaudeInputTokens(context.state, context.originalRequest, chunks)
      : chunks;
  }

  /** `TranslateNonStream`: without a transform the body is returned unchanged; `undefined` on translation failure. */
  translateNonStream(
    client: Format,
    provider: Format,
    context: ResponseContext,
    body: string,
  ): string | undefined {
    const transform = this.#responses.get(key(client, provider))?.nonStream;

    if (transform === undefined)
      return context.state.toolInputError === undefined ? body : undefined;
    const out = transform(context, body);

    if (context.state.toolInputError !== undefined) return undefined;

    return out;
  }

  /** `TranslateTokenCount`: without a transform the provider usage JSON is returned as-is. */
  translateTokenCount(client: Format, provider: Format, count: number, rawJson: string): string {
    const transform = this.#responses.get(key(client, provider))?.tokenCount;

    return transform === undefined ? rawJson : transform(count);
  }
}
