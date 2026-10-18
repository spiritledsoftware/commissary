/**
 * `POST /v1/systemone`: TypeSafe's System One API (ADR 0032, https://docs.typesafe.ai/api) for System One models, whichever
 * provider serves them (entry protocol `systemone`). Workers addition, no Go counterpart; see docs/ARCHITECTURE.md
 * "System One".
 *
 * The request is JSON, or `multipart/form-data` whose first part, `request`, holds the JSON and whose other parts are
 * the image files the JSON's `assets.<ref>.part` name (TypeSafe's multipart rules: unique non-empty part names,
 * `request` reserved, every file part used by exactly one asset, image types `image/png`, `image/jpeg`, `image/jpg`,
 * `application/octet-stream` or none). The body is limited to TypeSafe's 32 MiB (413), checked before it is read where
 * `Content-Length` says so, and decoded per `Content-Encoding` (zstd, which TypeSafe's SDK uses for larger bodies).
 * It then takes the normal request path (`execute.ts`): model guard, grants, spend limits, credential selection,
 * failover, usage. The answer is returned as the provider sent it; every error is TypeSafe-shaped
 * (`errorResponse("systemone", …)`). There is no streaming, and no non-stream keep-alive either: a committed 200 would
 * hide the error status TypeSafe's SDKs retry on.
 */
import { Effect, Result } from "effect";
import { HttpRouter, HttpServerRequest, type HttpServerResponse } from "effect/http";
import { isJsonObject, type JsonObject, tryParseJson } from "@commissary/json";
import { routeServices } from "@commissary/core";
import { EntryOnlyFormats } from "@commissary/translation/formats";
import { assetPart, systemOneAssets } from "@commissary/translation/systemone";
import { ExecutionError } from "../../executor/errors.ts";
import { type MultipartPart, parseMultipart } from "../../executor/systemone/multipart.ts";
import {
  decodeRequestBytes,
  MAX_DECODED_BODY_BYTES,
  RequestBodyTooLargeError,
} from "../../http/body.ts";
import { executeNonStream } from "../execute.ts";
import { type ClientApiServices, currentConfig } from "../request.ts";
import { errorResponse, jsonResponse } from "../respond.ts";

/** TypeSafe's request body limit (its API answers 413 above it). */
export const SYSTEM_ONE_MAX_BODY_BYTES = 32 * 1024 * 1024;

/** The multipart part holding the JSON request. */
const REQUEST_PART = "request";

/** Content types TypeSafe accepts on an image part (none at all is accepted too). */
const IMAGE_PART_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "application/octet-stream",
]);

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

const refuse = (status: number, message: string): HttpServerResponse.HttpServerResponse =>
  errorResponse("systemone", new ExecutionError({ status, message }), {
    passthroughHeaders: false,
  });

type Parsed =
  | {
      readonly ok: true;
      readonly body: JsonObject;
      readonly parts?: ReadonlyMap<string, File>;
    }
  | { readonly ok: false; readonly status: number; readonly message: string };

const invalid = (message: string, status = 400): Parsed => ({ ok: false, status, message });

/** The JSON request of a body or part: a JSON object (UTF-8). */
const jsonObject = (bytes: Uint8Array): JsonObject | undefined => {
  try {
    const parsed = tryParseJson(decoder.decode(bytes));

    return isJsonObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/** A multipart request: the `request` part's JSON and the file parts, checked against TypeSafe's rules. */
const parseMultipartRequest = (bytes: Uint8Array, contentType: string): Parsed => {
  const split = parseMultipart(bytes, contentType);

  if (!split.ok) return invalid(split.error);
  const [first, ...files] = split.parts;

  if (first?.name !== REQUEST_PART)
    return invalid(`the first multipart part must be named "${REQUEST_PART}"`);
  const body = jsonObject(first.body);

  if (body === undefined) return invalid(`the "${REQUEST_PART}" part must be a JSON object`);
  const byName = new Map<string, MultipartPart>();

  for (const part of files) {
    if (part.name === "") return invalid("multipart part names must not be empty");

    if (part.name === REQUEST_PART || byName.has(part.name))
      return invalid(`multipart part name "${part.name}" is used more than once`);
    const type = (part.contentType ?? "").split(";")[0]?.trim() ?? "";

    if (type !== "" && !IMAGE_PART_TYPES.has(type))
      return invalid(`multipart part "${part.name}" has unsupported content type "${type}"`, 415);
    byName.set(part.name, part);
  }

  const used = new Set<string>();

  for (const { ref, asset } of systemOneAssets(body)) {
    const name = assetPart(asset);

    if (name === undefined) continue;

    if (!byName.has(name))
      return invalid(`asset "${ref}" names multipart part "${name}", which was not sent`);

    if (used.has(name)) return invalid(`multipart part "${name}" is used by more than one asset`);
    used.add(name);
  }

  for (const name of byName.keys())
    if (!used.has(name)) return invalid(`multipart part "${name}" is not used by any asset`);

  const parts = new Map(
    [...byName].map(([name, part]) => [
      name,
      new File([part.body], part.filename ?? name, {
        type: (part.contentType ?? "").split(";")[0]?.trim() ?? "",
      }),
    ]),
  );

  return { ok: true, body, ...(parts.size === 0 ? {} : { parts }) };
};

/** Reads, decodes and splits the request body. */
const parseRequest = Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
  const tooLarge = invalid(`request body exceeds ${SYSTEM_ONE_MAX_BODY_BYTES} bytes`, 413);
  const declared = Number(request.headers["content-length"] ?? "");

  if (Number.isFinite(declared) && declared > SYSTEM_ONE_MAX_BODY_BYTES) return tooLarge;
  const raw = yield* Effect.result(request.arrayBuffer);

  if (Result.isFailure(raw)) return invalid(raw.failure.message);

  if (raw.success.byteLength > SYSTEM_ONE_MAX_BODY_BYTES) return tooLarge;
  let bytes: Uint8Array;

  try {
    bytes = decodeRequestBytes(
      new Uint8Array(raw.success),
      request.headers["content-encoding"],
      Math.min(SYSTEM_ONE_MAX_BODY_BYTES, MAX_DECODED_BODY_BYTES),
    );
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return tooLarge;
    const message = error instanceof Error ? error.message : String(error);

    // TypeSafe answers 415 for an encoding it does not support.
    return invalid(message, message.startsWith("unsupported request content encoding") ? 415 : 400);
  }

  const contentType = (request.headers["content-type"] ?? "").trim();
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";

  if (mediaType === "multipart/form-data") return parseMultipartRequest(bytes, contentType);

  if (mediaType !== "" && mediaType !== "application/json")
    return invalid(`unsupported Content-Type "${mediaType}"`, 415);
  const body = jsonObject(bytes);

  return body === undefined
    ? invalid("request body must be a JSON object")
    : ({ ok: true, body } satisfies Parsed);
});

const handle = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const configResult = yield* Effect.result(currentConfig);

  if (Result.isFailure(configResult))
    return errorResponse("systemone", configResult.failure, { passthroughHeaders: false });
  const config = configResult.success;
  const parsed = yield* parseRequest(request);

  if (!parsed.ok) return refuse(parsed.status, parsed.message);
  const model = parsed.body["model"];

  if (typeof model !== "string" || model.trim() === "") return refuse(422, "model is required");

  const result = yield* Effect.result(
    executeNonStream({
      entryProtocol: EntryOnlyFormats.SystemOne,
      model: model.trim(),
      body: parsed.body,
      alt: "",
      request,
      ...(parsed.parts === undefined ? {} : { systemOneParts: parsed.parts }),
    }),
  );

  if (Result.isFailure(result))
    return errorResponse("systemone", result.failure, {
      passthroughHeaders: config.requests["passthrough-headers"],
    });

  return jsonResponse(result.success.payload, result.success.headers);
});

/** Route layer; requires the {@link ClientApiServices} and `AccessPrincipal`. */
export const SystemOneRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const services = yield* routeServices<ClientApiServices>();
    yield* router.add("POST", "/v1/systemone", Effect.provide(handle, services));
  }),
);
