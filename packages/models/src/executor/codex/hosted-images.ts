/**
 * Hosted `image_generation` handling on Codex `/responses` (Responses-Lite routes).
 *
 * Go source: internal/runtime/executor/helps/codex_hosted_images.go (CodexModelUsesResponsesLite,
 * CodexRequestHasReasoningForHostedImageDoc, ValidateCodexHostedImageGenerationDoc, codexRequestForcesImageGenerationDoc),
 * codex_executor_request.go (normalizeCodexImageGenerationToolsDoc). Commits 714f0526, 8fb60326, d1e5cc60.
 */
import {
  asString,
  cloneJson,
  del,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
} from "@commissary/json";
import { parseSuffix } from "@commissary/translation/thinking";
import { ExecutionError } from "../errors.ts";
import { codexClientModelUsesResponsesLite } from "../../registry/catalog.ts";
import { customHeaders } from "../helps/custom-headers.ts";
import type { CredentialSnapshot } from "../picker.ts";
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

const LITE_HEADER = "x-openai-internal-codex-responses-lite";

/** What decides whether a request reaches Codex as Responses-Lite besides its body. */
export interface LiteRouteInput {
  readonly credential: CredentialSnapshot;
  /** The client's request headers. */
  readonly headers: Headers;
  readonly sessionId?: string | undefined;
  /** models.json `override_header` of the model. */
  readonly overrideHeaders?: Readonly<Record<string, string>> | undefined;
}

/**
 * `CodexResponsesLiteRequestForAuthDoc`: the `client_metadata` mirror, else the client header, overridden by the
 * credential's `header:` attributes and then by the model's `override_header`.
 */
export const responsesLiteRequestForAuth = (body: Json, route: LiteRouteInput): boolean => {
  if (isCodexResponsesLiteRequest(body, new Headers())) return true;
  let effective = (route.headers.get(LITE_HEADER) ?? "").trim();

  for (const [name, value] of customHeaders(route.credential, route.headers, route.sessionId)) {
    if (name.trim().toLowerCase() === LITE_HEADER && value.trim() !== "") effective = value.trim();
  }

  for (const [name, value] of Object.entries(route.overrideHeaders ?? {})) {
    if (name.trim().toLowerCase() === LITE_HEADER) effective = value.trim();
  }

  return effective.toLowerCase() === "true";
};

/** `docToolChoiceSelectsImageGeneration`. */
const toolChoiceSelectsImageGeneration = (choice: Json | undefined): boolean => {
  if (typeof choice === "string") return choice.trim().toLowerCase() === "image_generation";

  if (!isJsonObject(choice)) return false;

  switch (asString(get(choice, "type")).trim().toLowerCase()) {
    case "image_generation":
      return true;
    case "tool":
      return asString(get(choice, "name")).trim().toLowerCase() === "image_generation";
    case "allowed_tools": {
      const allowed = get(choice, "tools");

      return (
        isJsonArray(allowed) &&
        allowed.some(
          (tool) => asString(get(tool, "type")).trim().toLowerCase() === "image_generation",
        )
      );
    }

    default:
      return false;
  }
};

const lastHostedToolIndex = (body: Json): number => {
  const tools = get(body, "tools");

  return isJsonArray(tools) ? tools.findLastIndex(isHostedImageTool) : -1;
};

/** The auto-injected tool as it was before the payload rules ran. */
export interface AutoInjection {
  readonly tool: Json;
  readonly toolChoice: Json | undefined;
  readonly hadEmptyTools: boolean;
}

/** What the body looked like before auto-injection, to tell an injected tool from the client's own. */
export interface InjectionBaseline {
  readonly hadHostedTool: boolean;
  readonly hadEmptyTools: boolean;
}

export const injectionBaseline = (body: Json): InjectionBaseline => {
  const tools = get(body, "tools");

  return {
    hadHostedTool: lastHostedToolIndex(body) >= 0,
    hadEmptyTools: isJsonArray(tools) && tools.length === 0,
  };
};

/** `autoInjectedToolIdx`: the injected tool after `ensureImageGenerationTool` ran; `undefined` when none was added. */
export const recordAutoInjection = (
  baseline: InjectionBaseline,
  body: Json,
): AutoInjection | undefined => {
  const index = lastHostedToolIndex(body);

  if (baseline.hadHostedTool || index < 0) return undefined;
  const tool = get(body, `tools.${index}`);
  const choice = get(body, "tool_choice");

  if (tool === undefined) return undefined;

  return {
    tool: cloneJson(tool),
    toolChoice: choice === undefined ? undefined : cloneJson(choice),
    hadEmptyTools: baseline.hadEmptyTools,
  };
};

/**
 * 714f0526 (`codexConfiguredPayloadIncompatibleWithAutoImageGenDoc`, retract): after the payload rules, an untouched
 * auto-injected hosted tool is removed again when the configured payload is lite-routed, targets a `spark` model or
 * sets reasoning on a lite model. A rule that rewrote `tool_choice` to select the hosted tool keeps it.
 */
export const retractAutoInjectedImageGeneration = (
  body: Json,
  injection: AutoInjection | undefined,
  fallbackModel: string,
  route: LiteRouteInput,
): Json => {
  if (injection === undefined) return body;
  const index = lastHostedToolIndex(body);

  if (index < 0 || JSON.stringify(get(body, `tools.${index}`)) !== JSON.stringify(injection.tool))
    return body;
  const choice = get(body, "tool_choice");

  if (
    JSON.stringify(choice) !== JSON.stringify(injection.toolChoice) &&
    toolChoiceSelectsImageGeneration(choice)
  )
    return body;
  const configuredModel = asString(get(body, "model")).trim() || fallbackModel.trim();
  const modelName = parseSuffix(configuredModel).modelName.trim();

  const incompatible =
    responsesLiteRequestForAuth(body, route) ||
    modelName.toLowerCase().endsWith("spark") ||
    (codexModelUsesResponsesLite(modelName) &&
      requestHasReasoningForHostedImage(body, configuredModel));

  if (!incompatible) return body;
  const tools = get(body, "tools");

  if (isJsonArray(tools) && tools.length === 1 && !injection.hadEmptyTools)
    return del(body, "tools");

  return del(body, `tools.${index}`);
};
