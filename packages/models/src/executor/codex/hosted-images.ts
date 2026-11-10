/**
 * Hosted `image_generation` handling on Codex `/responses` (Responses-Lite routes).
 *
 * Go source: internal/runtime/executor/helps/codex_hosted_images.go (CodexModelUsesResponsesLite,
 * CodexRequestHasReasoningForHostedImageDoc, ValidateCodexHostedImageGenerationDoc, codexRequestForcesImageGenerationDoc),
 * codex_executor_request.go (normalizeCodexImageGenerationToolsDoc). Commits 714f0526, 8fb60326, d1e5cc60.
 *
 * Differences from Go: Commissary has no SIWC route, so "native Codex" is every non-provider-key credential; the lite
 * route is read from the model, the client header/metadata mirror and the outbound headers, not from credential
 * `header:` attributes or models.json `override_header` (the outbound headers already carry both).
 */
import { asString, del, get, isJsonArray, isJsonObject, type Json } from "@commissary/json";
import { parseSuffix } from "@commissary/translation/thinking";
import { ExecutionError } from "../errors.ts";
import { codexClientModelUsesResponsesLite } from "../../registry/catalog.ts";
import { isCodexResponsesLiteRequest } from "./headers.ts";

/** `CodexModelUsesResponsesLite`: GPT-6 models and catalog models marked `use_responses_lite`. */
export const codexModelUsesResponsesLite = (model: string): boolean => {
  let slug = parseSuffix(model).modelName.trim().toLowerCase();
  const slash = slug.lastIndexOf("/");

  if (slash >= 0) slug = slug.slice(slash + 1).trim();

  return slug !== "" && (slug.startsWith("gpt-6") || codexClientModelUsesResponsesLite(slug));
};

const hasEffort = (value: Json | undefined): boolean =>
  value !== undefined && value !== null && asString(value).trim() !== "";

/**
 * `CodexRequestHasReasoningForHostedImageDoc`: a model thinking suffix, `reasoning.effort` (or a bare `reasoning`
 * string) or a `configuration_update` input item carrying `reasoning.effort`.
 */
export const requestHasReasoningForHostedImage = (body: Json, model: string): boolean => {
  if (parseSuffix(model).hasSuffix || parseSuffix(asString(get(body, "model"))).hasSuffix)
    return true;
  const reasoning = get(body, "reasoning");

  if (reasoning !== undefined && reasoning !== null) {
    if (isJsonObject(reasoning)) {
      if (hasEffort(get(reasoning, "effort"))) return true;
    } else if (asString(reasoning).trim() !== "") return true;
  }

  const input = get(body, "input");

  return (
    isJsonArray(input) &&
    input.some(
      (item) =>
        asString(get(item, "type")).trim() === "configuration_update" &&
        hasEffort(get(item, "reasoning.effort")),
    )
  );
};

/** `codexCollectDeclaredToolsDoc`: top-level tools plus those of `additional_tools` input items. */
const declaredTools = (body: Json): Json[] => {
  const tools: Json[] = [];
  const declared = get(body, "tools");

  if (isJsonArray(declared)) tools.push(...declared);
  const input = get(body, "input");

  if (isJsonArray(input)) {
    for (const item of input) {
      if (asString(get(item, "type")).trim() !== "additional_tools") continue;
      const extra = get(item, "tools");

      if (isJsonArray(extra)) tools.push(...extra);
    }
  }

  return tools;
};

const isHostedImageTool = (tool: Json): boolean =>
  asString(get(tool, "type")).trim() === "image_generation";

/** `codexRequestForcesImageGenerationDoc`: the turn can only be answered by the hosted image tool. */
export const requestForcesImageGeneration = (body: Json): boolean => {
  const tools = declaredTools(body);

  if (!tools.some(isHostedImageTool)) return false;
  const choice = get(body, "tool_choice");

  if (typeof choice === "string")
    return choice.trim().toLowerCase() === "required" && tools.every(isHostedImageTool);

  if (!isJsonObject(choice)) return false;

  switch (asString(get(choice, "type")).trim()) {
    case "image_generation":
      return true;
    case "allowed_tools": {
      if (asString(get(choice, "mode")).trim().toLowerCase() !== "required") return false;
      const allowed = get(choice, "tools");

      return isJsonArray(allowed) && allowed.length > 0 && allowed.every(isHostedImageTool);
    }

    default:
      return false;
  }
};

/**
 * `ValidateCodexHostedImageGenerationDoc`: native Codex Responses-Lite cannot serve a forced hosted image turn. Runs on
 * the final payload and outbound headers. Provider keys, `disable-image-generation: passthrough` and the standalone
 * Images API keep their own contracts. A request-scoped 400 (no cooldown, no failover), or `undefined`.
 */
export const validateHostedImageGeneration = (input: {
  readonly body: Json;
  readonly headers: Headers;
  readonly passthrough: boolean;
  readonly nativeCodex: boolean;
}): ExecutionError | undefined => {
  if (!input.nativeCodex || input.passthrough) return undefined;

  if (
    !codexModelUsesResponsesLite(asString(get(input.body, "model"))) &&
    !isCodexResponsesLiteRequest(input.body, input.headers)
  )
    return undefined;

  if (!requestForcesImageGeneration(input.body)) return undefined;

  return new ExecutionError({
    status: 400,
    message:
      "Hosted image_generation cannot be forced on this Codex Responses-Lite route. Use /v1/images/generations or /v1/images/edits instead.",
    requestScoped: true,
  });
};

/**
 * 8fb60326: an `image_generation_user_error` about `complexity` gets remediation guidance appended (Go
 * `codexTerminalErrorBody` and `responsesAnnotateImageGenerationComplexityPayload`). Returns the new message, or
 * `undefined` when the error needs none.
 */
export const annotateImageGenerationError = (error: Json | undefined): string | undefined => {
  if (asString(get(error, "type")).trim().toLowerCase() !== "image_generation_user_error")
    return undefined;
  const message = asString(get(error, "message")).trim();
  const param = asString(get(error, "param")).trim().toLowerCase();

  if (
    (param !== "complexity" && !message.toLowerCase().includes("complexity")) ||
    message.includes("/v1/images/generations")
  )
    return undefined;

  return `${message} (Set tool_choice to {"type":"image_generation"}, use a compatible Responses model such as gpt-5.4-mini, or call /v1/images/generations directly.)`;
};

/**
 * `normalizeCodexImageGenerationToolsDoc`: `/responses` binds the hosted tool to gpt-image-2-codex, which rejects the
 * `complexity` parameter; it is removed from declared image_generation tools.
 */
export const stripHostedImageComplexity = (body: Json): Json => {
  const strip = (toolsPath: string): void => {
    const tools = get(body, toolsPath);

    if (!isJsonArray(tools)) return;

    for (const [index, tool] of tools.entries()) {
      if (isHostedImageTool(tool) && get(tool, "complexity") !== undefined)
        del(body, `${toolsPath}.${index}.complexity`);
    }
  };

  strip("tools");
  const input = get(body, "input");

  if (isJsonArray(input)) {
    for (const [index, item] of input.entries()) {
      if (asString(get(item, "type")).trim() === "additional_tools") strip(`input.${index}.tools`);
    }
  }

  return body;
};
