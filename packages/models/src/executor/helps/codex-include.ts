/**
 * Responses `include` values by upstream backend.
 *
 * Go source: internal/runtime/executor/helps/codex_include.go (7f22743a). The Responses -> Codex translator keeps
 * `reasoning.encrypted_content` and the Codex-verified optional values; an OpenAI Responses upstream that is not the
 * ChatGPT Codex backend (a `codex-api-key` endpoint) also accepts the platform-only values, which the executor restores
 * from the client payload. Meta and xAI, which share the translator, drop the Codex-only values again.
 */
import { get, isJsonArray, isJsonObject, type Json, set } from "@commissary/json";
import { Formats } from "@commissary/translation/formats";

interface IncludeEntry {
  readonly value: string;
  readonly platformOnly: boolean;
}

/**
 * The official OpenAI Responses includables (besides the always-required `reasoning.encrypted_content`) plus Codex's
 * opt-in `output.encrypted_content`, in the translator's relative order for the non-platform-only ones.
 */
const OPTIONAL_INCLUDES: ReadonlyArray<IncludeEntry> = [
  { value: "web_search_call.action.sources", platformOnly: false },
  { value: "web_search_call.results", platformOnly: false },
  { value: "file_search_call.results", platformOnly: true },
  { value: "message.input_image.image_url", platformOnly: true },
  { value: "computer_call_output.output.image_url", platformOnly: true },
  { value: "code_interpreter_call.outputs", platformOnly: true },
  { value: "message.output_text.logprobs", platformOnly: true },
  { value: "output.encrypted_content", platformOnly: false },
];

/** The include values Meta and xAI do not accept although the shared translator keeps them. */
export const CODEX_ONLY_INCLUDES = ["output.encrypted_content", "web_search_call.results"] as const;

/**
 * `IsChatGPTCodexBackendBaseURL`: the base URL is the ChatGPT Codex backend; an empty or unparseable one fails closed to
 * it (the conservative allowlist).
 */
export const isChatGPTCodexBackendBaseUrl = (baseUrl: string): boolean => {
  const trimmed = baseUrl.trim();

  if (trimmed === "") return true;
  let parsed: URL;

  try {
    parsed = new URL(trimmed);
  } catch {
    return true;
  }

  if (parsed.hostname.replace(/\.+$/, "").toLowerCase() !== "chatgpt.com") return false;
  const path = parsed.pathname.replace(/\/+$/, "");

  return path === "/backend-api/codex" || path.startsWith("/backend-api/codex/");
};

/**
 * `PreserveCodexOpenAIResponsesInclude`: the include list of `body` rebuilt from the client's OpenAI Responses `source`
 * when it asks for a platform-only value: `reasoning.encrypted_content` first, then every known value it requested, in
 * canonical order. Unknown and non-string entries stay filtered. `body` is returned unchanged otherwise.
 */
export const preserveCodexOpenAIResponsesInclude = (
  body: Json,
  source: Json | undefined,
  from: string,
): Json => {
  if (!isJsonObject(body) || from.trim().toLowerCase() !== Formats.OpenAIResponse) return body;
  const requested = get(source, "include");

  if (!isJsonArray(requested)) return body;
  const values = new Set(requested.filter((value) => typeof value === "string"));

  if (!OPTIONAL_INCLUDES.some((entry) => entry.platformOnly && values.has(entry.value)))
    return body;

  return set(body, "include", [
    "reasoning.encrypted_content",
    ...OPTIONAL_INCLUDES.flatMap((entry) => (values.has(entry.value) ? [entry.value] : [])),
  ]);
};

/**
 * The body without the include values only Codex accepts, for an upstream (Meta, OpenCode, xAI) that shares the
 * Responses -> Codex translator; each caller decides when it applies.
 */
export const stripCodexOnlyIncludes = (body: Json): Json =>
  stripResponsesIncludeValues(body, CODEX_ONLY_INCLUDES);

/** `StripResponsesIncludeValuesDoc`: `body` without the `blocked` string values in `include` (dropped when emptied). */
export const stripResponsesIncludeValues = (body: Json, blocked: ReadonlyArray<string>): Json => {
  const current = get(body, "include");

  if (!isJsonObject(body) || !isJsonArray(current) || current.length === 0) return body;
  const kept = current.filter((value) => typeof value !== "string" || !blocked.includes(value));

  if (kept.length === current.length) return body;

  if (kept.length > 0) return set(body, "include", kept);
  const { include: _dropped, ...rest } = body;

  return rest;
};
