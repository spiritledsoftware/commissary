/**
 * The System One executor (ADR 0032): `systemone` requests (TypeSafe's System One API, `POST /v1/systemone`) to a
 * System One provider, TypeSafe or SubQ, described by a {@link SystemOneSpec} (`specs.ts`). Workers addition, no Go
 * counterpart; see docs/ARCHITECTURE.md "System One".
 *
 * Per attempt: the local refusals (`capabilities.ts`) -> the provider's body (`spec.buildBody`, from the client's
 * TypeSafe JSON with the upstream model and its file parts) -> payload rules on the JSON only (protocol `systemone`,
 * the final mutation; file parts are never touched) -> POST `{base}/systemone` as JSON, or as multipart when the body
 * keeps file parts (`request` part first) -> usage from the answer's `usage`. There is no streaming and no token count.
 *
 * {@link postSystemOne}, {@link prepareSystemOneBody} and {@link typeSafeBody} are shared with executors that serve
 * System One models through another gateway (OpenCode Zen).
 */
import { Clock, Effect } from "effect";
import {
  HttpBody,
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/http";
import { cloneJson, isJsonObject, type Json, type JsonObject } from "@commissary/json";
import { EntryOnlyFormats } from "@commissary/translation/formats";
import { parseSuffix } from "@commissary/translation/thinking";
import { ExecutionError, notImplemented } from "../errors.ts";
import { applyCustomHeaders } from "../helps/custom-headers.ts";
import { finalizePayload } from "../helps/payload.ts";
import type {
  ExecutionContext,
  ExecutorOptions,
  ExecutorRequest,
  ExecutorResponse,
  ProviderExecutor,
} from "../types.ts";
import { systemOneRefusal } from "./capabilities.ts";
import type { SystemOneErrorInput } from "./errors.ts";
import { encodeMultipart } from "./multipart.ts";
import type { SystemOneProvider } from "./providers.ts";
import { publishSystemOneUsage } from "./usage.ts";

/**
 * A provider's request body: JSON, plus the file parts to upload with it (multipart, the JSON as the `request` part)
 * when there are any.
 */
export interface SystemOneBody {
  readonly json: Json;
  readonly files?: ReadonlyArray<readonly [name: string, file: File]>;
}

/** Everything that differs between System One providers. */
export interface SystemOneSpec {
  readonly provider: SystemOneProvider;
  /** Names the provider in local refusals and errors. */
  readonly displayName: string;
  /** Used when the credential has no `base_url`; requests go to `{base}/systemone`. */
  readonly baseUrl: string;
  /** Client request headers sent on unchanged when present (TypeSafe's `TypeSafe-Danger-Zone-*` opt-ins). */
  readonly forwardHeaders: ReadonlyArray<string>;
  /**
   * The provider's body from the client's TypeSafe request (`model` already the upstream model, a copy the hook may
   * change) and its multipart file parts. Fails with a request-scoped error for what the provider cannot take.
   */
  readonly buildBody: (
    body: JsonObject,
    parts: ReadonlyMap<string, File> | undefined,
  ) => Effect.Effect<SystemOneBody, ExecutionError>;
  /** A non-2xx answer as an `ExecutionError` (`errors.ts`). */
  readonly classifyError: (input: SystemOneErrorInput) => ExecutionError;
}

/** TypeSafe's own body: the JSON as it is, the client's file parts uploaded with it unchanged and in order. */
export const typeSafeBody = (
  body: JsonObject,
  parts: ReadonlyMap<string, File> | undefined,
): Effect.Effect<SystemOneBody, ExecutionError> =>
  Effect.succeed(
    parts === undefined || parts.size === 0 ? { json: body } : { json: body, files: [...parts] },
  );

/** `fetch` failures carry no HTTP answer: the conductor treats them as transient transport errors (no cooldown). */
const transportError = (error: HttpClientError.HttpClientError) =>
  new ExecutionError({
    status: 500,
    code: "transient_transport",
    message: `upstream request failed: ${error.reason._tag}`,
    cause: error,
  });

/** The credential's endpoint (`base_url`, else `defaultBaseUrl`, no trailing slash) and key; a key is required. */
export const systemOneEndpoint = (
  context: ExecutionContext,
  defaultBaseUrl: string,
  displayName: string,
): Effect.Effect<{ readonly baseUrl: string; readonly providerKey: string }, ExecutionError> => {
  const providerKey = (context.credential.attributes["api_key"] ?? "").trim();
  const configured = (context.credential.attributes["base_url"] ?? "").trim();
  const baseUrl = (configured === "" ? defaultBaseUrl : configured).replace(/\/+$/, "");

  return providerKey === ""
    ? Effect.fail(
        new ExecutionError({ status: 401, message: `${displayName} credential has no api key` }),
      )
    : Effect.succeed({ baseUrl, providerKey });
};

/**
 * The provider body of an attempt: the client's request with the upstream model (suffix dropped), through `buildBody`,
 * then the payload rules (protocol `systemone`) on the JSON only, as the final mutation.
 */
export const prepareSystemOneBody = Effect.fnUntraced(function* (input: {
  readonly provider: string;
  readonly context: ExecutionContext;
  readonly request: ExecutorRequest;
  readonly options: ExecutorOptions;
  readonly buildBody: SystemOneSpec["buildBody"];
}) {
  const { context, request, options } = input;
  const model = parseSuffix(request.model).modelName;

  if (!isJsonObject(request.payload))
    return yield* new ExecutionError({
      status: 400,
      message: "System One request body must be a JSON object",
      requestScoped: true,
    });

  // SAFETY: a copy of a JSON object is a JSON object.
  const copy = cloneJson(request.payload) as JsonObject;
  const built = yield* input.buildBody({ ...copy, model }, options.systemOneParts);

  const json = finalizePayload(
    context.config,
    input.provider,
    {
      model,
      requestedModel:
        options.metadata.requestedModel !== "" ? options.metadata.requestedModel : request.model,
      protocol: EntryOnlyFormats.SystemOne,
      fromProtocol: options.sourceFormat,
      requestPath: options.metadata.requestPath,
      headers: options.headers,
      original: cloneJson(built.json),
    },
    built.json,
  );

  return { ...built, json } satisfies SystemOneBody;
});

/**
 * Upstream headers: Bearer key, JSON accept, the client headers `forward` names (when sent), then the credential's
 * custom headers.
 */
export const systemOneHeaders = (
  context: ExecutionContext,
  options: ExecutorOptions,
  providerKey: string,
  forward: ReadonlyArray<string>,
): Record<string, string> => {
  const headers: Record<string, string> = {};

  headers.authorization = `Bearer ${providerKey}`;
  headers.accept = "application/json";

  for (const name of forward) {
    const value = options.headers.get(name);

    if (value !== null) headers[name.toLowerCase()] = value;
  }

  return applyCustomHeaders(headers, context.credential, options.headers, undefined);
};

/** One System One exchange to post. */
export interface SystemOnePost {
  readonly context: ExecutionContext;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: SystemOneBody;
  readonly classifyError: (input: SystemOneErrorInput) => ExecutionError;
}

/**
 * POSTs a System One body (JSON, or multipart with the JSON as the first part, `request`) and returns the answer
 * unchanged as the client payload, its usage published. A non-2xx answer is classified by `classifyError`; its body
 * stays the message and only its type and code reach the usage record (ADR 0027).
 */
export const postSystemOne = Effect.fnUntraced(function* (
  post: SystemOnePost,
): Effect.fn.Return<ExecutorResponse, ExecutionError, HttpClient.HttpClient> {
  const client = yield* HttpClient.HttpClient;
  const { usage } = post.context;
  const json = JSON.stringify(post.body.json);
  const files = post.body.files ?? [];

  const multipart =
    files.length === 0
      ? undefined
      : encodeMultipart([
          { name: "request", value: { json } },
          ...files.map(([name, file]) => ({ name, value: { file } })),
        ]);

  const request = HttpClientRequest.post(post.url).pipe(
    HttpClientRequest.setHeaders(post.headers),
    multipart === undefined
      ? HttpClientRequest.bodyText(json, "application/json")
      : HttpClientRequest.setBody(
          HttpBody.raw(multipart.body, {
            contentType: multipart.contentType,
            contentLength: multipart.body.size,
          }),
        ),
  );

  const response: HttpClientResponse.HttpClientResponse = yield* client
    .execute(request)
    .pipe(
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.mapError(transportError),
    );

  usage.markFirstByte(yield* Clock.currentTimeMillis);
  const headers = new Headers(response.headers);

  if (response.status < 200 || response.status >= 300) {
    const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    usage.fail(response.status, text);

    return yield* post.classifyError({
      status: response.status,
      body: text,
      headers,
      nowMs: yield* Clock.currentTimeMillis,
    });
  }

  const text = yield* response.text.pipe(Effect.mapError(transportError));
  publishSystemOneUsage(usage, text);

  return { payload: text, headers } satisfies ExecutorResponse;
});

/** The executor of one System One provider. */
export const makeSystemOneExecutor = (spec: SystemOneSpec): ProviderExecutor => {
  const execute = Effect.fnUntraced(function* (
    context: ExecutionContext,
    request: ExecutorRequest,
    options: ExecutorOptions,
  ) {
    if (options.sourceFormat !== EntryOnlyFormats.SystemOne)
      return yield* notImplemented(
        `${spec.displayName} only serves System One requests (/v1/systemone)`,
      );

    const refusal = systemOneRefusal({
      provider: spec.provider,
      displayName: spec.displayName,
      model: request.model,
      body: request.payload,
    });

    if (refusal !== undefined) return yield* refusal;
    const endpoint = yield* systemOneEndpoint(context, spec.baseUrl, spec.displayName);

    const body = yield* prepareSystemOneBody({
      provider: spec.provider,
      context,
      request,
      options,
      buildBody: spec.buildBody,
    });

    return yield* postSystemOne({
      context,
      url: `${endpoint.baseUrl}/systemone`,
      headers: systemOneHeaders(context, options, endpoint.providerKey, spec.forwardHeaders),
      body,
      classifyError: spec.classifyError,
    });
  });

  const unsupported = () =>
    Effect.fail(notImplemented(`${spec.displayName}: System One requests have no streaming`));

  return {
    identifier: spec.provider,
    execute,
    executeStream: unsupported,
    countTokens: () =>
      Effect.fail(notImplemented(`${spec.displayName}: System One requests have no token count`)),
  };
};
