/**
 * Endpoint and credential resolution of the Gemini provider-key and Vertex executors.
 *
 * Go source: internal/runtime/executor/gemini_executor.go (geminiAPIKey, resolveGeminiBaseURL, shouldExecuteNativeInteractions,
 * nativeInteractionsSourceFormat), internal/runtime/executor/gemini_vertex_executor.go (vertexCreds, vertexAPICreds,
 * vertexBaseURL, vertexAPIKeyModelsURL, vertexInteractionsURL, isNativeVertexInteractionsAuth, shouldExecuteVertexInteractions).
 */
import { Effect } from "effect";
import type { JsonObject } from "@commissary/json";
import { Formats } from "@commissary/translation/formats";
import { ExecutionError } from "../errors.ts";

import type { ExecutionContext } from "../types.ts";
import type { GoogleTarget, GoogleVariant } from "./google.ts";

export const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com";

export const GEMINI_API_VERSION = "v1beta";

export const VERTEX_API_VERSION = "v1";

export const VERTEX_DEFAULT_BASE_URL = "https://aiplatform.googleapis.com";

const trimSlash = (value: string): string => value.replace(/\/+$/, "");

// --- Gemini provider key ---------------------------------------------------------------------------------------------------

const NATIVE_INTERACTIONS_SOURCES: ReadonlySet<string> = new Set([
  Formats.Interactions,
  Formats.OpenAI,
  Formats.OpenAIResponse,
  Formats.Claude,
  Formats.Gemini,
]);

/** `resolveGeminiBaseURL`. */
export const geminiBaseUrl = (context: ExecutionContext): string => {
  const custom = (context.credential.attributes["base_url"] ?? "").trim();

  return custom === "" ? GEMINI_ENDPOINT : trimSlash(custom);
};

export const geminiVariant = (identifier: "gemini" | "gemini-interactions"): GoogleVariant => ({
  identifier,
  vertex: false,
  resolveTarget: (context) =>
    Effect.sync((): GoogleTarget => {
      const base = geminiBaseUrl(context);
      const providerKey = context.credential.attributes["api_key"] ?? "";

      return {
        url: (action, model) => `${base}/${GEMINI_API_VERSION}/models/${model}:${action}`,
        interactionsUrl: () => `${base}/${GEMINI_API_VERSION}/interactions`,
        authHeaders: providerKey === "" ? {} : { "x-goog-api-key": providerKey },
      };
    }),
  nativeInteractions: (context, options) =>
    NATIVE_INTERACTIONS_SOURCES.has(options.sourceFormat) &&
    context.credential.provider.trim().toLowerCase() === "gemini-interactions",
});

// --- Vertex -------------------------------------------------------------------------------------------------------------

/**
 * `vertexBaseURL`: `global` uses the bare host, the multi-region locations `us` and `eu` their regional endpoint (REP)
 * host, other locations a regional host.
 */
export const vertexBaseUrl = (location: string): string => {
  const loc = location.trim();
  const lower = loc.toLowerCase();

  if (lower === "global") return VERTEX_DEFAULT_BASE_URL;

  if (lower === "us" || lower === "eu") return `https://aiplatform.${lower}.rep.googleapis.com`;

  return `https://${loc === "" ? "us-central1" : loc}-aiplatform.googleapis.com`;
};

/** `vertexAPIVersionSuffix`: the base already ends in a version segment such as `v1` or `v1beta1`. */
const endsWithApiVersion = (base: string): boolean =>
  /^v[a-z0-9_-]*\d[a-z0-9_-]*$/.test(base.slice(base.lastIndexOf("/") + 1));

/**
 * `vertexAPIKeyModelsURL`: a base that already contains `/publishers/` is the full resource prefix (only
 * `/{model}:{action}` follows); otherwise `/v1` is inserted unless the base ends in a version segment.
 */
export const vertexApiKeyModelsUrl = (baseUrl: string, model: string, action: string): string => {
  let base = trimSlash(baseUrl.trim());

  if (base === "") base = VERTEX_DEFAULT_BASE_URL;

  if (base.includes("/publishers/")) return `${base}/${model}:${action}`;

  if (!endsWithApiVersion(base)) base = `${base}/${VERTEX_API_VERSION}`;

  return `${base}/publishers/google/models/${model}:${action}`;
};

/** `vertexInteractionsURL`. */
export const vertexInteractionsUrl = (
  baseUrl: string,
  projectId: string,
  stream: boolean,
): string => {
  const base = trimSlash(baseUrl.trim() === "" ? VERTEX_DEFAULT_BASE_URL : baseUrl.trim());
  const project = projectId.trim();

  const url =
    project === ""
      ? `${base}/v1beta1/interactions`
      : `${base}/v1beta1/projects/${project}/locations/global/interactions`;

  return stream ? `${url}?alt=sse` : url;
};

/** `isNativeVertexInteractionsAuth`. */
export const isNativeVertexInteractions = (context: ExecutionContext): boolean => {
  const flag = (context.credential.attributes["interactions"] ?? "").trim().toLowerCase();

  if (flag === "true" || flag === "1") return true;
  const { metadata } = context.credential;

  return metadata["interactions"] === true || metadata["native_interactions"] === true;
};

const accessTokenOf = (metadata: JsonObject): string => metadataString(metadata, "access_token");

const metadataString = (metadata: JsonObject, key: string): string => {
  const value = metadata[key];

  return typeof value === "string" ? value.trim() : "";
};

interface VertexApiCreds {
  readonly providerKey: string;
  readonly baseUrl: string;
}

/** `vertexAPICreds`: the `api_key` attribute, else an access token stored on a provider-key style credential. */
const vertexProviderKey = (context: ExecutionContext): VertexApiCreds => {
  const { attributes, metadata } = context.credential;
  let providerKey = attributes["api_key"] ?? "";

  // Service-account credentials carry a minted `access_token` too; that is a bearer token, not a provider key.
  if (providerKey === "" && metadata["service_account"] === undefined)
    providerKey = accessTokenOf(metadata);

  return { providerKey, baseUrl: attributes["base_url"] ?? "" };
};

/** Service-account access token: minted by the ControlPlane before the attempt (`withCredentialRefresh`). */
const serviceAccountToken = (context: ExecutionContext) => {
  const token = accessTokenOf(context.credential.metadata);

  return token === ""
    ? Effect.fail(
        new ExecutionError({
          status: 401,
          message: "missing access token",
          credentialScoped: true,
        }),
      )
    : Effect.succeed(token);
};

export const vertexVariant: GoogleVariant = {
  identifier: "vertex",
  vertex: true,
  resolveTarget: (context: ExecutionContext) =>
    Effect.gen(function* () {
      const { providerKey, baseUrl } = vertexProviderKey(context);
      const { metadata } = context.credential;

      if (providerKey !== "") {
        const project = metadataString(metadata, "project_id");

        return {
          url: (action, model) => vertexApiKeyModelsUrl(baseUrl, model, action),
          interactionsUrl: (stream) => vertexInteractionsUrl(baseUrl, project, stream),
          authHeaders: { "x-goog-api-key": providerKey },
        } satisfies GoogleTarget;
      }

      // Service account.
      let projectId = metadataString(metadata, "project_id");

      if (projectId === "") projectId = metadataString(metadata, "project");

      if (projectId === "") {
        return yield* new ExecutionError({
          status: 500,
          message: "vertex executor: missing project_id in credentials",
        });
      }

      if (metadata["service_account"] === undefined || metadata["service_account"] === null) {
        return yield* new ExecutionError({
          status: 500,
          message: "vertex executor: missing service_account in credentials",
        });
      }

      const location = metadataString(metadata, "location") || "us-central1";
      const token = yield* serviceAccountToken(context);
      const base = vertexBaseUrl(location);

      return {
        url: (action, model) =>
          `${base}/${VERTEX_API_VERSION}/projects/${projectId}/locations/${location}/publishers/google/models/${model}:${action}`,
        interactionsUrl: (stream) =>
          vertexInteractionsUrl(context.credential.attributes["base_url"] ?? "", projectId, stream),
        authHeaders: { authorization: `Bearer ${token}` },
      } satisfies GoogleTarget;
    }),
  nativeInteractions: (context, options) =>
    options.sourceFormat === Formats.Interactions && isNativeVertexInteractions(context),
};
