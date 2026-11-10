/**
 * Responses tools -> Gemini function declarations, tool choice and reverse identity mapping.
 *
 * Go source: internal/util/responses_tools.go (BuildGeminiFunctionDeclarations, ResponsesToolReverseIdentityMap,
 * MapResponsesToolName, MapResponsesClientToolSearchName, ConvertResponsesToolChoiceToGemini,
 * UnwrapResponsesCustomToolInput).
 */
import { sha256Hex } from "../../../../hash.ts";
import {
  asString,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  set,
} from "@commissary/json";
import {
  applyPatchDescription,
  applyPatchParameters,
  isApplyPatchCustomTool,
} from "../../../common/apply-patch.ts";
import {
  collectResponsesToolDescriptors,
  isResponsesClientToolSearchItem,
  qualifyResponsesNamespaceToolName,
  RESPONSES_CLIENT_TOOL_SEARCH_KEY,
  RESPONSES_TOOL_SEARCH_CALL_TYPE,
  RESPONSES_TOOL_SEARCH_FUNCTION_NAME,
  RESPONSES_TOOL_SEARCH_OUTPUT_TYPE,
  responsesToolDescriptorPrecedes,
  type ResponsesToolDescriptor,
  type ResponsesToolIdentity,
} from "../../../common/responses-tools.ts";
import { sanitizeFunctionName } from "../../util/claude.ts";
import { cleanJsonSchemaForGeminiJsonSchema } from "../../util/json-schema.ts";

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const disambiguateSanitizedName = (
  base: string,
  original: string,
  used: ReadonlyMap<string, string>,
): string => {
  for (let attempt = 0; ; attempt++) {
    const suffix = `_${sha256Hex(`${original}\u0000${attempt}`).slice(0, 12)}`;
    const maxPrefix = 64 - suffix.length;
    const prefix = base.length > maxPrefix ? base.slice(0, maxPrefix) : base;
    const candidate = prefix + suffix;

    if (!used.has(candidate)) return candidate;
  }
};

/** `sanitizeResponsesToolNames`. */
const sanitizeResponsesToolNames = (names: readonly string[]): Map<string, string> => {
  const unique = new Set<string>();
  const baseCounts = new Map<string, number>();

  for (const name of names) {
    if (name === "" || unique.has(name)) continue;
    unique.add(name);
    const base = sanitizeFunctionName(name);
    baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
  }

  const out = new Map<string, string>();
  const used = new Map<string, string>();

  for (const name of [...unique].toSorted(compareStrings)) {
    const base = sanitizeFunctionName(name);

    const mapped =
      (baseCounts.get(base) ?? 0) > 1 || used.has(base)
        ? disambiguateSanitizedName(base, name, used)
        : base;

    out.set(name, mapped);
    used.set(mapped, name);
  }

  return out;
};

const toolDescription = (tool: Json | undefined): string => {
  const description = asString(get(tool, "description"));

  return description !== "" ? description : asString(get(tool, "function.description"));
};

const toolParameters = (tool: Json | undefined): Json | undefined => {
  for (const path of [
    "parameters",
    "parametersJsonSchema",
    "input_schema",
    "function.parameters",
    "function.parametersJsonSchema",
  ]) {
    const parameters = get(tool, path);

    if (parameters !== undefined) return parameters;
  }

  return undefined;
};

export interface GeminiFunctionDeclarations {
  readonly declarations: Json[];
  readonly forwardMap: Map<string, string>;
  readonly reverseMap: Map<string, ResponsesToolIdentity>;
}

/** The default parameters of the client `tool_search` shim (Go `responsesToolSearchDefaultParameters`). */
const toolSearchDefaultParameters = (): JsonObject => ({
  type: "object",
  properties: {
    query: { type: "string", description: "Search query for deferred tools." },
    limit: { type: "number", description: "Maximum number of tools to return." },
  },
  required: ["query"],
  additionalProperties: false,
});

/** `buildGeminiToolSearchParametersSchema`: the declared schema when it is an object, else the default. */
const toolSearchParameters = (tool: Json | undefined): Json => {
  const params = toolParameters(tool);

  if (isJsonObject(params)) {
    const cleaned = cleanJsonSchemaForGeminiJsonSchema(params);

    if (isJsonObject(cleaned)) return cleaned;
  }

  return toolSearchDefaultParameters();
};

interface WinnerKey {
  readonly name: string;
  readonly clientSearch: boolean;
}

const winnerKey = ({ name, clientSearch }: WinnerKey): string =>
  `${clientSearch ? "s" : "t"}\u0000${name}`;

const hasClientSearchHistory = (root: Json | undefined): boolean => {
  const input = get(root, "input");

  return (
    isJsonArray(input) &&
    input.some((item) => {
      const type = asString(get(item, "type"));

      return (
        (type === RESPONSES_TOOL_SEARCH_CALL_TYPE || type === RESPONSES_TOOL_SEARCH_OUTPUT_TYPE) &&
        isResponsesClientToolSearchItem(item)
      );
    })
  );
};

/**
 * `BuildGeminiFunctionDeclarations`. A client-executed `tool_search` is exposed as the function `tool_search` (the
 * shim; renamed with a hash suffix when the user declares a function of that name), tools a search loaded are
 * declared, and `defer_loading` tools stay hidden until then (77fd91e8).
 */
export const buildGeminiFunctionDeclarations = (
  root: Json | undefined,
): GeminiFunctionDeclarations => {
  const descriptors = collectResponsesToolDescriptors(root, true);
  const winners = new Map<string, ResponsesToolDescriptor>();

  for (const descriptor of descriptors) {
    const key = winnerKey(descriptor);
    const current = winners.get(key);

    if (current === undefined || responsesToolDescriptorPrecedes(descriptor, current))
      winners.set(key, descriptor);
  }

  const seen = new Set<string>();
  const winning: ResponsesToolDescriptor[] = [];

  for (const descriptor of descriptors) {
    const key = winnerKey(descriptor);
    const winner = winners.get(key);

    if (winner === undefined || winner.order !== descriptor.order) continue;

    if (seen.has(key)) continue;
    seen.add(key);
    winning.push(descriptor);
  }

  const forwardMap = new Map<string, string>();
  const reverseMap = new Map<string, ResponsesToolIdentity>();
  const declarations: Json[] = [];
  const history = hasClientSearchHistory(root);

  if (winning.length === 0) {
    if (!history) return { declarations, forwardMap, reverseMap };
    // Replayed search history without a declaration still needs the shim's name.
    forwardMap.set(RESPONSES_CLIENT_TOOL_SEARCH_KEY, RESPONSES_TOOL_SEARCH_FUNCTION_NAME);
    forwardMap.set(RESPONSES_TOOL_SEARCH_FUNCTION_NAME, RESPONSES_TOOL_SEARCH_FUNCTION_NAME);
    reverseMap.set(RESPONSES_TOOL_SEARCH_FUNCTION_NAME, {
      name: RESPONSES_TOOL_SEARCH_FUNCTION_NAME,
      namespace: "",
      custom: false,
      applyPatch: false,
      toolSearch: true,
    });

    return { declarations, forwardMap, reverseMap };
  }

  let hasClientSearch = false;
  let userOwnsExactToolSearch = false;
  const qualifiedNames: string[] = [];

  for (const descriptor of winning) {
    if (descriptor.clientSearch) {
      hasClientSearch = true;
      continue;
    }

    if (descriptor.name === RESPONSES_TOOL_SEARCH_FUNCTION_NAME) userOwnsExactToolSearch = true;
    qualifiedNames.push(descriptor.name);
  }

  const sanitized = sanitizeResponsesToolNames(qualifiedNames);
  let clientSearchGeminiName = "";

  if (hasClientSearch || history) {
    const used = new Map<string, string>();

    for (const [original, mapped] of sanitized) used.set(mapped, original);

    if (!userOwnsExactToolSearch) {
      // Reserve `tool_search` for the shim and rename any other tool (e.g. `tool.search`) that sanitised to it.
      const colliding = used.get(RESPONSES_TOOL_SEARCH_FUNCTION_NAME);

      if (colliding !== undefined && colliding !== RESPONSES_TOOL_SEARCH_FUNCTION_NAME) {
        used.set(RESPONSES_TOOL_SEARCH_FUNCTION_NAME, RESPONSES_CLIENT_TOOL_SEARCH_KEY);

        const renamed = disambiguateSanitizedName(
          RESPONSES_TOOL_SEARCH_FUNCTION_NAME,
          colliding,
          used,
        );

        sanitized.set(colliding, renamed);
        used.set(renamed, colliding);
      } else {
        used.set(RESPONSES_TOOL_SEARCH_FUNCTION_NAME, RESPONSES_CLIENT_TOOL_SEARCH_KEY);
      }

      clientSearchGeminiName = RESPONSES_TOOL_SEARCH_FUNCTION_NAME;
    } else {
      clientSearchGeminiName = disambiguateSanitizedName(
        RESPONSES_TOOL_SEARCH_FUNCTION_NAME,
        RESPONSES_CLIENT_TOOL_SEARCH_KEY,
        used,
      );
      used.set(clientSearchGeminiName, RESPONSES_CLIENT_TOOL_SEARCH_KEY);
    }
  }

  if (clientSearchGeminiName !== "") {
    forwardMap.set(RESPONSES_CLIENT_TOOL_SEARCH_KEY, clientSearchGeminiName);
    forwardMap.set(clientSearchGeminiName, clientSearchGeminiName);

    if (!userOwnsExactToolSearch)
      forwardMap.set(RESPONSES_TOOL_SEARCH_FUNCTION_NAME, clientSearchGeminiName);
    reverseMap.set(clientSearchGeminiName, {
      name: RESPONSES_TOOL_SEARCH_FUNCTION_NAME,
      namespace: "",
      custom: false,
      applyPatch: false,
      toolSearch: true,
    });
  }

  for (const descriptor of winning) {
    let geminiName: string;

    if (descriptor.clientSearch) {
      geminiName = clientSearchGeminiName;
    } else {
      const mapped = sanitized.get(descriptor.name);

      geminiName =
        mapped !== undefined && mapped !== "" ? mapped : sanitizeFunctionName(descriptor.name);
    }

    if (!descriptor.clientSearch) forwardMap.set(descriptor.name, geminiName);
    forwardMap.set(geminiName, geminiName);

    const applyPatch = isApplyPatchCustomTool(descriptor.tool);

    const identity: ResponsesToolIdentity = {
      name: descriptor.localName,
      namespace: descriptor.namespace,
      custom: descriptor.toolType === "custom",
      applyPatch,
      ...(descriptor.clientSearch ? { toolSearch: true } : {}),
    };

    reverseMap.set(geminiName, identity);

    if (!descriptor.clientSearch && descriptor.name !== geminiName)
      reverseMap.set(descriptor.name, identity);

    const declaration: JsonObject = { name: geminiName, description: "", parametersJsonSchema: {} };
    const description = toolDescription(descriptor.tool);

    if (description !== "") declaration["description"] = description;

    if (applyPatch) {
      declaration["description"] = applyPatchDescription(descriptor.tool);
      declaration["parametersJsonSchema"] = applyPatchParameters();
    } else if (descriptor.toolType === "custom") {
      declaration["parametersJsonSchema"] = {
        type: "object",
        properties: { input: { type: "string" } },
        required: ["input"],
      };
    } else if (descriptor.clientSearch) {
      declaration["parametersJsonSchema"] = toolSearchParameters(descriptor.tool);
    } else {
      const params = toolParameters(descriptor.tool);

      if (params !== undefined)
        declaration["parametersJsonSchema"] = cleanJsonSchemaForGeminiJsonSchema(params);
    }

    declarations.push(declaration);
  }

  // Local-name aliases come last so a namespace child's local name never shadows a direct tool or the search shim.
  for (const descriptor of winning) {
    if (
      !descriptor.clientSearch &&
      descriptor.localName !== "" &&
      descriptor.localName !== descriptor.name &&
      !forwardMap.has(descriptor.localName)
    ) {
      const target = forwardMap.get(descriptor.name);

      if (target !== undefined) forwardMap.set(descriptor.localName, target);
    }
  }

  return { declarations, forwardMap, reverseMap };
};

/** `MapResponsesClientToolSearchName`: the Gemini function name of the client `tool_search` shim. */
export const mapResponsesClientToolSearchName = (
  forwardMap: ReadonlyMap<string, string> | undefined,
): string => {
  const mapped = forwardMap?.get(RESPONSES_CLIENT_TOOL_SEARCH_KEY);

  return mapped !== undefined && mapped !== "" ? mapped : RESPONSES_TOOL_SEARCH_FUNCTION_NAME;
};

/** `ResponsesToolReverseIdentityMap`: Gemini function name -> Responses identity (empty for unusable input). */
export const responsesToolReverseIdentityMap = (
  request: Json | undefined,
): Map<string, ResponsesToolIdentity> => {
  if (request === undefined) return new Map();
  let root: Json | undefined = request;
  const nested = get(request, "request");

  if (
    nested !== undefined &&
    (get(nested, "model") !== undefined ||
      get(nested, "input") !== undefined ||
      get(nested, "tools") !== undefined)
  ) {
    root = nested;
  }

  return buildGeminiFunctionDeclarations(root).reverseMap;
};

/** `MapResponsesToolName`. */
export const mapResponsesToolName = (
  forwardMap: ReadonlyMap<string, string> | undefined,
  name: string,
): string => {
  const mapped = forwardMap?.get(name);

  return mapped !== undefined && mapped !== "" ? mapped : sanitizeFunctionName(name);
};

/** `ConvertResponsesToolChoiceToGemini`: the `functionCallingConfig` object, or `undefined`. */
export const convertResponsesToolChoiceToGemini = (
  toolChoice: Json | undefined,
  forwardMap: ReadonlyMap<string, string> | undefined,
): JsonObject | undefined => {
  if (toolChoice === undefined) return undefined;
  let mode = "";
  const allowed: string[] = [];

  const modeOf = (value: string): string => {
    switch (value) {
      case "none":
        return "NONE";
      case "auto":
        return "AUTO";
      case "required":
      case "any":
        return "ANY";
      default:
        return "";
    }
  };

  if (typeof toolChoice === "string") {
    mode = modeOf(toolChoice.trim().toLowerCase());
  } else if (isJsonObject(toolChoice)) {
    const toolType = asString(toolChoice["type"]).trim().toLowerCase();
    mode = modeOf(toolType);

    if (["function", "custom", "tool", ""].includes(toolType)) {
      mode = "ANY";
      const trimmed = (path: string): string => asString(get(toolChoice, path)).trim();
      let name = trimmed("name") || trimmed("function.name") || trimmed("custom.name");

      const namespace =
        trimmed("namespace") || trimmed("function.namespace") || trimmed("custom.namespace");

      if (namespace !== "") name = qualifyResponsesNamespaceToolName(namespace, name);

      if (name !== "") allowed.push(mapResponsesToolName(forwardMap, name));
    }
  }

  if (mode === "") return undefined;
  const config: JsonObject = { mode };

  if (allowed.length > 0) set(config, "allowedFunctionNames", allowed);

  return config;
};
