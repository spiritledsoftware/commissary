/**
 * Antigravity provider -> Gemini client (response).
 *
 * Go source: internal/translator/antigravity/gemini/antigravity_gemini_response.go. The Go `ctx.Value("alt")` is
 * `ResponseContext.alt`: without it (a client that is not a Gemini entry) a stream chunk produces no output.
 */
import { asString, del, get, isJsonArray, type Json, set, tryParseJson } from "@commissary/json";
import type { ResponseContext, ResponseTransform } from "../../registry.ts";
import {
  hasAntigravityResponsePayload as hasResponsePayload,
  USAGE_PATHS,
} from "../common/payload.ts";
import { geminiTokenCountJson } from "../../gemini/common/contents.ts";
import { disambiguatedToolNameMap, restoreSanitizedToolName } from "../../common/tool-names.ts";

interface GeminiStreamState {
  sawResponse: boolean;
  sawFinishReason: boolean;
  modelVersion: string;
  responseId: string;
  usageMetadata: Json | undefined;
}

const stateOf = (context: ResponseContext): GeminiStreamState => {
  if (context.state.value === undefined) {
    const fresh: GeminiStreamState = {
      sawResponse: false,
      sawFinishReason: false,
      modelVersion: "",
      responseId: "",
      usageMetadata: undefined,
    };

    context.state.value = fresh;
  }

  // SAFETY: the stream state slot is only ever written with this type by this translator (initialised just above).
  return context.state.value as GeminiStreamState;
};

const firstString = (raw: Json | undefined, ...paths: string[]): string => {
  for (const path of paths) {
    const value = asString(get(raw, path));

    if (value !== "") return value;
  }

  return "";
};

const observe = (state: GeminiStreamState, raw: Json | undefined): void => {
  if (!state.sawResponse) state.sawResponse = hasResponsePayload(raw);

  if (!state.sawFinishReason) {
    for (const path of ["response.candidates", "candidates"]) {
      const candidates = get(raw, path);

      if (
        isJsonArray(candidates) &&
        candidates.some((candidate) => asString(get(candidate, "finishReason")) !== "")
      ) {
        state.sawFinishReason = true;
        break;
      }
    }
  }

  if (state.modelVersion === "")
    state.modelVersion = firstString(raw, "response.modelVersion", "modelVersion");

  if (state.responseId === "")
    state.responseId = firstString(raw, "response.responseId", "responseId");

  for (const path of USAGE_PATHS) {
    const usage = get(raw, path);

    if (usage !== undefined) {
      state.usageMetadata = structuredClone(usage);
      break;
    }
  }
};

/** `syntheticTerminalChunk`: key order candidates, usageMetadata, modelVersion, responseId. */
const syntheticTerminalChunk = (state: GeminiStreamState): Json => {
  const chunk: Json = {
    candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP" }],
  };

  if (state.usageMetadata !== undefined) set(chunk, "usageMetadata", state.usageMetadata);

  if (state.modelVersion !== "") set(chunk, "modelVersion", state.modelVersion);

  if (state.responseId !== "") set(chunk, "responseId", state.responseId);

  return chunk;
};

/** `restoreUsageMetadata`: `cpaUsageMetadata` back to `usageMetadata`. */
const restoreUsageMetadata = (chunk: Json): Json => {
  const cpa = get(chunk, "cpaUsageMetadata");

  if (cpa !== undefined) {
    set(chunk, "usageMetadata", cpa);
    del(chunk, "cpaUsageMetadata");
  }

  return chunk;
};

const restoreFunctionNames = (chunk: Json, originalRequest: Json | undefined): Json => {
  const nameMap = disambiguatedToolNameMap(originalRequest);

  if (nameMap === undefined) return chunk;
  const candidates = get(chunk, "candidates");

  if (!isJsonArray(candidates)) return chunk;

  for (const candidate of candidates) {
    const parts = get(candidate, "content.parts");

    if (!isJsonArray(parts)) continue;

    for (const part of parts) {
      for (const field of [
        "functionCall",
        "functionResponse",
        "function_call",
        "function_response",
      ]) {
        const nameResult = get(part, `${field}.name`);
        const name = asString(nameResult);

        if (name === "") continue;
        const restored = restoreSanitizedToolName(nameMap, name);

        if (typeof nameResult === "string" && restored === name) continue;
        set(part, `${field}.name`, restored);
      }
    }
  }

  return chunk;
};

/** `ConvertAntigravityResponseToGemini`. */
export const convertAntigravityResponseToGemini = (
  context: ResponseContext,
  line: string,
): ReadonlyArray<string> => {
  let raw = line;

  if (raw.startsWith("data:")) raw = raw.slice(5).trim();
  const state = stateOf(context);

  if (raw === "[DONE]") {
    // Never finalize a stream that produced no response at all.
    if (!state.sawResponse || state.sawFinishReason) return [];
    state.sawFinishReason = true;
    const finalChunk = syntheticTerminalChunk(state);
    const alt = context.alt;

    return [JSON.stringify(alt !== undefined && alt !== "" ? [finalChunk] : finalChunk)];
  }

  const parsed = tryParseJson(raw);
  observe(state, parsed);

  const alt = context.alt;

  if (alt === undefined) return [];

  if (alt === "") {
    const response = get(parsed, "response");

    if (response === undefined) return [""];

    return [
      JSON.stringify(
        restoreFunctionNames(
          restoreUsageMetadata(structuredClone(response)),
          context.originalRequest,
        ),
      ),
    ];
  }

  const items: Json[] = [];

  if (isJsonArray(parsed)) {
    for (const item of parsed) {
      const response = get(item, "response");

      // Every array item gets its usage and tool names back too (CLIProxyAPI a3e75421).
      if (response !== undefined)
        items.push(
          restoreFunctionNames(
            restoreUsageMetadata(structuredClone(response)),
            context.originalRequest,
          ),
        );
    }
  }

  return [JSON.stringify(items)];
};

/** `ConvertAntigravityResponseToGeminiNonStream`. */
export const convertAntigravityResponseToGeminiNonStream = (
  context: ResponseContext,
  body: string,
): string => {
  const parsed = tryParseJson(body);
  const response = get(parsed, "response");
  let chunk: Json;

  if (response !== undefined) {
    chunk = restoreFunctionNames(
      restoreUsageMetadata(structuredClone(response)),
      context.originalRequest,
    );
  } else {
    if (parsed === undefined) return body;
    chunk = restoreFunctionNames(parsed, context.originalRequest);
  }

  const candidates = get(chunk, "candidates");

  if (isJsonArray(candidates)) {
    // Default every candidate so a multi-candidate response cannot leave some of them unterminated.
    candidates.forEach((candidate, index) => {
      if (asString(get(candidate, "finishReason")) === "")
        set(chunk, `candidates.${index}.finishReason`, "STOP");
    });
  }

  return JSON.stringify(chunk);
};

export const antigravityToGeminiResponse: ResponseTransform = {
  stream: convertAntigravityResponseToGemini,
  nonStream: convertAntigravityResponseToGeminiNonStream,
  tokenCount: geminiTokenCountJson,
};
