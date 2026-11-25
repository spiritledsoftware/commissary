/**
 * Anthropic server-side fallback: which model served a Claude response, and the ordered fallback hops the OpenAI
 * Chat Completions and Responses translators report (`fallback`, `fallbacks`).
 *
 * Go source: internal/translator/common/claude_native_response.go (ClaudeModelSameOrSnapshot,
 * claudeRequestHasFallbacks, ClaudePreTokenFallbackModels, BuildClaudeFallbackMetadata, ClaudeFallbackChain: fa11a573).
 */
import { cloneJson, get, isJsonObject, type Json, type JsonObject } from "@commissary/json";
import { str } from "./gjson.ts";

const isDatedSnapshotOf = (base: string, candidate: string): boolean =>
  candidate.startsWith(`${base}-`) && /^\d{8}$/.test(candidate.slice(base.length + 1));

/** `ClaudeModelSameOrSnapshot`: the same model, or an 8-digit `YYYYMMDD` snapshot of it. */
export const claudeModelSameOrSnapshot = (primary: string, upstream: string): boolean => {
  const p = primary.trim().toLowerCase();
  const u = upstream.trim().toLowerCase();

  if (p === "" || u === "") return false;

  return p === u || isDatedSnapshotOf(p, u) || isDatedSnapshotOf(u, p);
};

/** `claudeRequestHasFallbacks`. */
const requestHasFallbacks = (request: Json | undefined): boolean => {
  const fallbacks = get(request, "fallbacks");

  if (typeof fallbacks === "string") return fallbacks.trim() !== "";

  if (Array.isArray(fallbacks)) return fallbacks.length > 0;

  return isJsonObject(fallbacks) && Object.keys(fallbacks).length > 0;
};

/** `claudePayloadStringModel`. */
const requestModel = (request: Json | undefined): string => {
  const model = get(request, "model");

  return typeof model === "string" ? model.trim() : "";
};

const isCanonicalClaudeModel = (model: string): boolean =>
  model.trim().toLowerCase().startsWith("claude-");

/**
 * `ClaudePreTokenFallbackModels`: the `message_start` model already differs from the requested one (array
 * fallbacks, `fallbacks: "default"`, sticky routing). Returns the `[from, to]` pair, or `undefined`.
 */
export const claudePreTokenFallbackModels = (
  originalRequest: Json | undefined,
  translatedRequest: Json | undefined,
  requestedModel: string,
  upstreamModel: string,
): readonly [string, string] | undefined => {
  const upstream = upstreamModel.trim();

  if (upstream === "") return undefined;
  let primary = requestModel(translatedRequest);

  if (primary === "") primary = requestModel(originalRequest);

  if (primary === "") primary = requestedModel.trim();

  if (primary !== "" && claudeModelSameOrSnapshot(primary, upstream)) return undefined;

  const hasFallbacks =
    requestHasFallbacks(translatedRequest) || requestHasFallbacks(originalRequest);

  if (!hasFallbacks && !(isCanonicalClaudeModel(primary) && isCanonicalClaudeModel(upstream)))
    return undefined;

  return [primary, upstream];
};

/** The key and value of a hop's boundary (`content_offset`, `output_index`), when the caller reports one. */
export interface FallbackBoundary {
  readonly key: string;
  readonly index: number;
}

/**
 * `BuildClaudeFallbackMetadata`: `from`, `to` and `trigger` of a `fallback` content block (`from`/`to` default to the
 * given models), plus the boundary. `undefined` when there is nothing to report.
 */
export const claudeFallbackMetadata = (
  block: Json | undefined,
  defaultFrom: string,
  defaultTo: string,
  boundary?: FallbackBoundary,
): JsonObject | undefined => {
  const out: JsonObject = {};
  const from = get(block, "from");
  const to = get(block, "to");
  const trigger = get(block, "trigger");

  if (isJsonObject(from)) out.from = cloneJson(from);
  else if (defaultFrom.trim() !== "") out.from = { model: defaultFrom.trim() };

  if (isJsonObject(to)) out.to = cloneJson(to);
  else if (defaultTo.trim() !== "") out.to = { model: defaultTo.trim() };

  if (isJsonObject(trigger)) out.trigger = cloneJson(trigger);

  if (Object.keys(out).length === 0) return undefined;

  if (boundary !== undefined) out[boundary.key] = boundary.index;

  return out;
};

/** What `usage.iterations` reported: the final serving model (`""` when none) and the hops new to the chain. */
export interface FallbackIterations {
  readonly model: string;
  readonly added: ReadonlyArray<JsonObject>;
}

/**
 * `ClaudeFallbackChain`: the ordered fallback hops of one message, from a pre-token `message_start` switch,
 * mid-stream `fallback` content blocks and the `fallback_message` entries of `usage.iterations`.
 */
export class ClaudeFallbackChain {
  entries: JsonObject[] = [];
  #inferredPreTokenSource = "";
  #hasExplicitBlock = false;

  reset(): void {
    this.entries = [];
    this.#inferredPreTokenSource = "";
    this.#hasExplicitBlock = false;
  }

  /** `RecordPreToken`: a switch detected at `message_start`. */
  recordPreToken(from: string, to: string, boundary?: FallbackBoundary): JsonObject | undefined {
    const hop = claudeFallbackMetadata(undefined, from, to, boundary);

    if (hop === undefined) return undefined;
    this.entries = [hop];
    this.#inferredPreTokenSource = from.trim();
    this.#hasExplicitBlock = false;

    return hop;
  }

  /**
   * `RecordBlock`: an explicit `fallback` content block. The first one replaces a pre-token hop describing the same
   * switch (it adds the trigger and boundary); later ones append.
   */
  recordBlock(
    block: Json | undefined,
    defaultFrom: string,
    defaultTo: string,
    boundary?: FallbackBoundary,
  ): JsonObject | undefined {
    const hop = claudeFallbackMetadata(block, defaultFrom, defaultTo, boundary);

    if (hop === undefined) return undefined;
    let blockFrom = str(get(block, "from.model")).trim();

    if (blockFrom === "") blockFrom = defaultFrom.trim();

    if (
      !this.#hasExplicitBlock &&
      this.entries.length === 1 &&
      this.#inferredPreTokenSource !== "" &&
      claudeModelSameOrSnapshot(this.#inferredPreTokenSource, blockFrom)
    ) {
      this.entries = [hop];
    } else {
      this.entries = [...this.entries, hop];
    }

    this.#inferredPreTokenSource = "";
    this.#hasExplicitBlock = true;

    return hop;
  }

  /**
   * `RecordIterations`: the `fallback_message` entries of `usage.iterations`. Returns the final serving model (`""`
   * when none) and the hops new to the chain (only when no explicit block reported them).
   */
  recordIterations(
    iterations: Json | undefined,
    defaultFrom: string,
    boundary?: FallbackBoundary,
  ): FallbackIterations {
    if (!Array.isArray(iterations)) return { model: "", added: [] };
    let from = defaultFrom.trim();
    let model = "";
    const hops: JsonObject[] = [];

    for (const iteration of iterations) {
      const served = str(get(iteration, "model")).trim();

      if (served === "") continue;

      switch (str(get(iteration, "type"))) {
        case "message":
          from = served;
          break;
        case "fallback_message": {
          model = served;

          if (!this.#hasExplicitBlock) {
            const hop = claudeFallbackMetadata(undefined, from, served, boundary);

            if (hop !== undefined) hops.push(hop);
          }

          from = served;
          break;
        }
      }
    }

    if (model === "" || this.#hasExplicitBlock || hops.length === 0) return { model, added: [] };
    const previous = this.entries.length;
    let added: JsonObject[] = [];

    if (hops.length > previous) {
      this.entries = hops;
      added = hops.slice(previous);
    }

    this.#inferredPreTokenSource = "";

    return { model, added };
  }

  /** `Latest`. */
  latest(): JsonObject | undefined {
    return this.entries.at(-1);
  }

  /** `ArrayBytes`: every hop in order, `undefined` when none. */
  all(): JsonObject[] | undefined {
    return this.entries.length === 0 ? undefined : this.entries.map(cloneJson);
  }
}
