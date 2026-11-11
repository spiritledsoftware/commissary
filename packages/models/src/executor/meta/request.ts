/**
 * Meta `/responses` request shaping.
 *
 * Go source: internal/runtime/executor/meta_executor_execute.go (`prepareResponsesRequest`),
 * helps/meta_tools.go (`SanitizeMetaWebSearchTools`), helps/meta_muse_tools.go
 * (`EnsureMetaMuseToolNamespace`, run before the payload rules). The shared Responses shaping (translate -> thinking ->
 * model/stream fields -> instructions -> reasoning sanitising -> tool sanitising -> payload rules) lives in
 * `helps/responses-request.ts`; Meta adds its web-search tool sanitising and passes its executor identifier as the
 * payload-rule protocol (as Go does).
 */
import { get, isJsonArray, isJsonObject, type Json } from "@commissary/json";
import type { TranslatorRegistry } from "@commissary/translation";
import { ensureMetaMuseToolNamespace } from "./muse-tools.ts";
import { prepareResponsesRequest, type ResponsesPrepared } from "../helps/responses-request.ts";
import {
  reasoningOptionsForMeta,
  resolveMetaSignatureTargetModel,
} from "../helps/responses-signature.ts";
import { metaCreds } from "./credentials.ts";
import type { ExecutionContext, ExecutorOptions, ExecutorRequest } from "../types.ts";

/** `SanitizeMetaWebSearchTools`: Meta rejects `search_content_types` on `web_search` tools (also inside namespaces). */
export const sanitizeMetaWebSearchTools = (body: Json): Json => {
  const tools = get(body, "tools");

  if (!isJsonArray(tools)) return body;

  const strip = (tool: Json): void => {
    if (isJsonObject(tool) && tool["type"] === "web_search") delete tool["search_content_types"];
  };

  for (const tool of tools) {
    strip(tool);

    if (isJsonObject(tool) && tool["type"] === "namespace" && isJsonArray(tool["tools"]))
      tool["tools"].forEach(strip);
  }

  return body;
};

export type MetaPrepared = ResponsesPrepared;

/**
 * Meta's tool preparation: the `web_search` sanitising, then the `muse` namespace append (before the payload rules).
 * Local token counting counts the namespace too, like Go.
 */
const prepareMetaTools = (body: Json): Json =>
  ensureMetaMuseToolNamespace(sanitizeMetaWebSearchTools(body));

export const prepareMetaRequest = (
  registry: TranslatorRegistry,
  context: ExecutionContext,
  request: ExecutorRequest,
  options: ExecutorOptions,
  provider: string,
  /** `false` only for local token counting (Go `prepareResponsesRequest(..., false)`); upstream calls always stream. */
  stream = true,
) =>
  prepareResponsesRequest(
    registry,
    context,
    request,
    options,
    {
      provider,
      payloadProtocol: provider,
      prepareTools: prepareMetaTools,
      signatureTargetModel: resolveMetaSignatureTargetModel,
      reasoning: (ctx) => reasoningOptionsForMeta(metaCreds(ctx.credential).baseUrl),
    },
    stream,
  );
