/**
 * Zero-output abnormal terminations of Gemini-family responses (Gemini, Vertex; Go also Antigravity and AI Studio).
 *
 * Go source: internal/runtime/executor/helps/gemini_zero_output.go (cf07c78a, f2efe2c4) and `newGeminiZeroOutputStatusErr`,
 * `newGeminiTranslatedClaudeErrorStatusErr` in internal/runtime/executor/openai_compat_executor.go (7e82d0d1).
 *
 * A response that finishes with `MALFORMED_FUNCTION_CALL`, `UNEXPECTED_TOOL_CALL` or `MALFORMED_RESPONSE` before any
 * visible output (non-blank text, a non-empty function call, media, code, grounding) answered nothing: it fails as a
 * 502 the conductor rotates past without cooling the credential (`transient_transport`). A stream withholds its
 * leading contentless frames (role-only shells, signature-only parts), so such a stream fails before its first payload
 * and the handler can still fail over; thought frames are never withheld. A stream that ends holding only candidate or
 * usage shells fails the same way (f2efe2c4).
 */
import {
  asBool,
  asString,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  tryParseJson,
} from "@commissary/json";
import { Formats } from "@commissary/translation/formats";
import { ExecutionError } from "../errors.ts";

/** `GeminiPayloadInspection`. */
export interface GeminiPayloadInspection {
  readonly finishReason: string;
  readonly hasCandidate: boolean;
  readonly hasVisibleOutput: boolean;
  readonly hasThoughtOutput: boolean;
  readonly hasUsageMetadata: boolean;
  readonly hasPromptBlock: boolean;
}

const ABNORMAL_FINISH_REASONS: ReadonlySet<string> = new Set([
  "MALFORMED_FUNCTION_CALL",
  "UNEXPECTED_TOOL_CALL",
  "MALFORMED_RESPONSE",
]);

/** `IsGeminiZeroOutputAbnormalFinishReason`. */
export const isZeroOutputAbnormalFinishReason = (reason: string): boolean =>
  ABNORMAL_FINISH_REASONS.has(reason.trim().toUpperCase());

/**
 * `GeminiZeroOutputErrorMessage`: a Claude error body for Claude clients, plain text otherwise; an empty reason is a
 * stream that closed holding only shells (f2efe2c4).
 */
export const zeroOutputErrorMessage = (responseFormat: string, finishReason: string): string => {
  const reason = finishReason.trim().toUpperCase();

  if (responseFormat === Formats.Claude) {
    const message =
      reason === ""
        ? "Gemini stream closed with zero output"
        : `Gemini response finished with ${reason}`;

    return JSON.stringify({ type: "error", error: { type: "api_error", message } });
  }

  return reason === ""
    ? "upstream stream closed with zero output"
    : `upstream returned zero output with finishReason ${reason}`;
};

/** `newGeminiZeroOutputStatusErr`: a 502 that rotates credentials without cooling them. */
export const zeroOutputError = (message: string): ExecutionError =>
  new ExecutionError({ status: 502, code: "transient_transport", message });

/**
 * `newGeminiTranslatedClaudeErrorStatusErr`: a translated Claude error event is a 502; one about a malformed function
 * call (a zero-output termination the guard did not see, such as one with grounding only) does not cool the credential.
 */
export const translatedClaudeError = (message: string): ExecutionError => {
  const root = tryParseJson(message);

  return asString(get(root, "type")).trim().toLowerCase() === "error" &&
    asString(get(root, "error.message")).includes("MALFORMED_FUNCTION_CALL")
    ? zeroOutputError(message)
    : new ExecutionError({ status: 502, message });
};

const nonBlank = (value: Json | undefined): boolean => asString(value).trim() !== "";

const nonEmptyArray = (value: Json | undefined): boolean => isJsonArray(value) && value.length > 0;

const isFunctionCallPart = (call: Json | undefined): boolean =>
  isJsonObject(call) &&
  (nonBlank(call["name"]) ||
    nonBlank(call["id"]) ||
    nonEmptyArray(call["partialArgs"]) ||
    nonEmptyArray(call["partial_args"]) ||
    (isJsonObject(call["args"]) && Object.keys(call["args"]).length > 0));

const isInlineDataPart = (data: Json | undefined): boolean =>
  isJsonObject(data) && nonBlank(data["data"]);

const isFileDataPart = (data: Json | undefined): boolean =>
  isJsonObject(data) && (nonBlank(data["fileUri"]) || nonBlank(data["file_uri"]));

const isExecutableCodePart = (code: Json | undefined): boolean =>
  isJsonObject(code) && nonBlank(code["code"]);

const isCodeExecutionResultPart = (result: Json | undefined): boolean =>
  isJsonObject(result) && (nonBlank(result["output"]) || nonBlank(result["outcome"]));

const hasMediaOrTool = (part: Json): boolean =>
  isFunctionCallPart(get(part, "functionCall")) ||
  isFunctionCallPart(get(part, "function_call")) ||
  isInlineDataPart(get(part, "inlineData")) ||
  isInlineDataPart(get(part, "inline_data")) ||
  isFileDataPart(get(part, "fileData")) ||
  isFileDataPart(get(part, "file_data")) ||
  isExecutableCodePart(get(part, "executableCode")) ||
  isExecutableCodePart(get(part, "executable_code")) ||
  isCodeExecutionResultPart(get(part, "codeExecutionResult")) ||
  isCodeExecutionResultPart(get(part, "code_execution_result"));

/** The first of `paths` that is present. */
const firstPresent = (root: Json | undefined, paths: ReadonlyArray<string>): Json | undefined => {
  for (const path of paths) {
    const value = get(root, path);

    if (value !== undefined) return value;
  }

  return undefined;
};

/** `InspectGeminiZeroOutputPayload`: the output semantics of one parsed Gemini response or stream frame. */
export const inspectGeminiPayload = (
  root: Json | undefined,
  allowResponseWrapper = false,
): GeminiPayloadInspection => {
  const wrapped = (paths: ReadonlyArray<string>): ReadonlyArray<string> =>
    allowResponseWrapper ? [...paths, ...paths.map((path) => `response.${path}`)] : paths;

  const usage = firstPresent(root, wrapped(["usageMetadata", "usage_metadata"]));
  const prompt = firstPresent(root, wrapped(["promptFeedback"]));
  const candidates = firstPresent(root, wrapped(["candidates"]));
  let finishReason = "";
  let hasVisibleOutput = false;
  let hasThoughtOutput = false;

  for (const candidate of isJsonArray(candidates) ? candidates : []) {
    const reason = asString(get(candidate, "finishReason")).trim();

    if (reason !== "" && finishReason === "") finishReason = reason;

    if (nonEmptyArray(get(candidate, "groundingMetadata.groundingChunks"))) hasVisibleOutput = true;
    const parts = get(candidate, "content.parts");

    for (const part of isJsonArray(parts) ? parts : []) {
      const mediaOrTool = hasMediaOrTool(part);
      const text = asString(get(part, "text"));

      // A signature-only part is neither: it stays buffered until real content arrives (f2efe2c4).
      if (asBool(get(part, "thought"))) {
        if (text !== "" || mediaOrTool) hasThoughtOutput = true;
        continue;
      }

      if (mediaOrTool || text.trim() !== "") hasVisibleOutput = true;
    }
  }

  return {
    finishReason,
    hasCandidate: isJsonArray(candidates) && candidates.length > 0,
    hasVisibleOutput,
    hasThoughtOutput,
    hasUsageMetadata: usage !== undefined,
    hasPromptBlock: nonBlank(get(prompt, "blockReason")),
  };
};

/** `CheckGeminiZeroOutputNonStream`: the abnormal finish reason of a complete zero-output response. */
export const zeroOutputFinishReason = (root: Json | undefined): string | undefined => {
  const inspection = inspectGeminiPayload(root);

  return isZeroOutputAbnormalFinishReason(inspection.finishReason) && !inspection.hasVisibleOutput
    ? inspection.finishReason
    : undefined;
};

/** What the stream does with an observed frame (`GeminiZeroOutputStreamAction`). */
export type ZeroOutputAction =
  /** Absorb the frame (a withheld shell, or waiting for the trailing usage of an abnormal finish). */
  | { readonly kind: "continue" }
  /** Emit the withheld shells, then the frame. */
  | { readonly kind: "emit"; readonly flush: ReadonlyArray<string> }
  /** Fail now with the zero-output 502. */
  | { readonly kind: "fail"; readonly finishReason: string }
  /** Emit the abnormal frame (a Claude client gets its error event after output went out), then fail. */
  | {
      readonly kind: "emit-error-then-fail";
      readonly frame: string;
      readonly finishReason: string;
    };

/**
 * `GeminiZeroOutputStreamGuard`: tracks visible output across the frames of a stream (raw JSON payloads, before the
 * usage filter), withholds leading contentless frames until meaningful content arrives, and latches an abnormal
 * zero-output finish until its trailing usage (or the end of the stream).
 */
export class ZeroOutputStreamGuard {
  readonly #responseFormat: string;
  readonly #allowResponseWrapper: boolean;
  #pendingShells: string[] = [];
  #sawCandidateShell = false;
  #sawVisibleOutput = false;
  #emitted = false;
  #abnormalFinishReason = "";
  #abnormalFrame = "";

  constructor(responseFormat: string, allowResponseWrapper = false) {
    this.#responseFormat = responseFormat;
    this.#allowResponseWrapper = allowResponseWrapper;
  }

  /** Records that a non-empty translated chunk went to the client. */
  markEmitted(): void {
    this.#emitted = true;
  }

  get hasAbnormalFinish(): boolean {
    return this.#abnormalFinishReason !== "";
  }

  #failure(): ZeroOutputAction {
    const finishReason = this.#abnormalFinishReason;

    return this.#emitted &&
      this.#responseFormat === Formats.Claude &&
      finishReason.toUpperCase() === "MALFORMED_FUNCTION_CALL"
      ? { kind: "emit-error-then-fail", frame: this.#abnormalFrame, finishReason }
      : { kind: "fail", finishReason };
  }

  /** `Observe`: decides whether `payload` (a raw JSON frame) is withheld, emitted or ends the stream. */
  observe(payload: string, root: Json | undefined): ZeroOutputAction {
    const inspection = inspectGeminiPayload(root, this.#allowResponseWrapper);

    if (inspection.hasVisibleOutput) this.#sawVisibleOutput = true;

    if (this.#abnormalFinishReason !== "")
      return inspection.hasUsageMetadata ? this.#failure() : { kind: "continue" };

    if (isZeroOutputAbnormalFinishReason(inspection.finishReason) && !this.#sawVisibleOutput) {
      this.#abnormalFinishReason = inspection.finishReason;
      this.#abnormalFrame = payload;
      this.#pendingShells = [];

      return inspection.hasUsageMetadata ? this.#failure() : { kind: "continue" };
    }

    if (
      !this.#emitted &&
      inspection.finishReason === "" &&
      !inspection.hasVisibleOutput &&
      !inspection.hasThoughtOutput &&
      !inspection.hasPromptBlock
    ) {
      if (inspection.hasCandidate || inspection.hasUsageMetadata) this.#sawCandidateShell = true;
      this.#pendingShells.push(payload);

      return { kind: "continue" };
    }

    const flush = this.#pendingShells;
    this.#pendingShells = [];

    return { kind: "emit", flush };
  }

  /**
   * `Finalize`: resolves a latched abnormal finish or the withheld shells at the end of the upstream stream. A stream
   * that sent nothing and withheld candidate or usage shells answered nothing: it fails with an empty finish reason.
   */
  finalize(): ZeroOutputAction {
    if (this.#abnormalFinishReason !== "") return this.#failure();

    if (this.#pendingShells.length > 0 && !this.#emitted && this.#sawCandidateShell) {
      this.#pendingShells = [];

      return { kind: "fail", finishReason: "" };
    }

    const flush = this.#pendingShells;
    this.#pendingShells = [];

    return { kind: "emit", flush };
  }
}
