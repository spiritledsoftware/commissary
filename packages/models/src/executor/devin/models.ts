/**
 * Devin chat model UID resolution.
 *
 * Go source: internal/runtime/executor/helps/devin_models.go (`ResolveDevinChatModelUID`, `HasDevinEffortSuffix`,
 * `NormalizeThinkingLevel`, `selectDefaultDevinEffort`, `clampEffort`), including the lightning tier and the compound
 * `<level>-fast` variants. The catalog (the Devin additions of the model catalog, model
 * `thinking.levels`) is reached through a lookup so the executor can use the live registry snapshot with the embedded
 * catalog as fallback.
 */
import { Match } from "effect";
import { parseSuffix } from "@commissary/translation/thinking";

/** Exact model UID suffixes that mean "already resolved". */
const KNOWN_SUFFIXES = [
  "-none",
  "-low",
  "-medium",
  "-high",
  "-xhigh",
  "-max",
  "-fast",
  "-slow",
  "-priority",
  "-low-priority",
  "-medium-priority",
  "-high-priority",
  "-xhigh-priority",
  "-max-priority",
  "-low-fast",
  "-medium-fast",
  "-high-fast",
  "-xhigh-fast",
  "-max-fast",
  "-none-fast",
  "-thinking-1m",
  "-thinking",
  "-max-1m",
  "-none-1m",
  "-minimal-lightning",
  "-low-lightning",
  "-medium-lightning",
  "-high-lightning",
  "-xhigh-lightning",
  "-max-lightning",
  "-none-lightning",
  "_none",
  "_minimal",
  "_low",
  "_medium",
  "_high",
  "_xhigh",
  "_max",
  "_thinking",
];

const SPECIAL_ALIASES = new Map([
  ["claude-haiku-4-5", "MODEL_PRIVATE_11"],
  ["gpt-4-1", "MODEL_CHAT_GPT_4_1_2025_04_14"],
]);

/** The GLM 5.2 variants: `none` and `max` efforts have their own models, everything else is the base one. */
const glmEffortModel = (effort: string, base: string, tail = ""): string =>
  Match.value(effort).pipe(
    Match.when("none", () => `${base}-none${tail}`),
    Match.when("max", () => `${base}-max${tail}`),
    Match.orElse(() => `${base}${tail}`),
  );

export const hasDevinEffortSuffix = (model: string): boolean => {
  const lower = model.trim().toLowerCase();

  return KNOWN_SUFFIXES.some((suffix) => lower.endsWith(suffix));
};

/** `NormalizeThinkingLevel`: loose effort strings or a token budget to a canonical effort. */
export const normalizeDevinThinkingLevel = (level: string, budgetTokens: number): string => {
  const normalized = level.trim().toLowerCase();

  switch (normalized) {
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
    case "fast":
      return normalized;
    case "none":
    case "off":
    case "disabled":
      return "none";
    case "auto":
    case "adaptive":
      return "high";
  }

  if (budgetTokens > 0) {
    if (budgetTokens <= 4096) return "low";

    if (budgetTokens <= 16384) return "medium";

    if (budgetTokens <= 32768) return "high";

    return "max";
  }

  return "";
};

const STANDARD_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];

const levelIndex = (level: string): number => STANDARD_ORDER.indexOf(level.trim().toLowerCase());

/** `clampEffort`: the nearest allowed level; ties go to the higher one. */
const clampEffort = (
  requested: string,
  allowed: ReadonlyArray<string>,
  defaultEffort: string,
): string => {
  if (requested === "") return defaultEffort;
  const wanted = requested.trim().toLowerCase();
  const exact = allowed.find((candidate) => candidate.trim().toLowerCase() === wanted);

  if (exact !== undefined) return exact;

  if (wanted === "none") return defaultEffort;
  const wantedIndex = levelIndex(wanted);

  if (wantedIndex === -1) return defaultEffort;
  let best = defaultEffort;
  let bestDistance = 999;
  let bestIndex = -1;

  for (const candidate of allowed) {
    const index = levelIndex(candidate);

    if (index === -1) continue;
    const distance = Math.abs(wantedIndex - index);

    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
      bestIndex = index;
    } else if (distance === bestDistance && index > bestIndex) {
      best = candidate;
      bestIndex = index;
    }
  }

  return best;
};

const defaultEffortFor = (baseModel: string, levels: ReadonlyArray<string>): string => {
  if (baseModel.includes("swe-2")) return "high";
  const has = (level: string): boolean => levels.includes(level);

  if (has("none") && has("low") && baseModel.startsWith("gpt-5")) return "low";

  if (
    has("high") &&
    ["gemini", "grok", "glm", "deepseek", "kimi", "nemotron"].some((family) =>
      baseModel.includes(family),
    )
  ) {
    return "high";
  }

  if (has("medium")) return "medium";

  if (has("high")) return "high";

  if (has("low")) return "low";

  return levels[0] ?? "";
};

/** Thinking levels of a catalog model (`undefined` = not in the catalog). */
export type DevinLevelLookup = (modelId: string) => ReadonlyArray<string> | undefined;

/** `ResolveDevinChatModelUID`. */
export const resolveDevinChatModelUid = (
  rawModel: string,
  thinkingLevelIn: string,
  budgetTokens: number,
  levelsOf: DevinLevelLookup,
): string => {
  const model = rawModel.trim();

  if (model === "") return "swe-2-high";
  let clean = model;

  if (clean.toLowerCase().startsWith("devin/")) clean = clean.slice(6);

  if (hasDevinEffortSuffix(clean)) return clean;

  let thinkingLevel = thinkingLevelIn;
  const parsed = parseSuffix(clean);
  let baseModel = parsed.modelName.trim();

  if (parsed.hasSuffix) {
    thinkingLevel = parsed.rawSuffix;
  } else {
    const colon = clean.lastIndexOf(":");

    if (colon !== -1) {
      baseModel = clean.slice(0, colon).trim();
      thinkingLevel = clean.slice(colon + 1).trim();
    }
  }

  // A compound `<level>-fast` request selects an upstream fast variant, which the normalised effort cannot express.
  const rawLevel = thinkingLevel.trim().toLowerCase();
  const effort = normalizeDevinThinkingLevel(thinkingLevel, budgetTokens);
  const lowerBase = baseModel.toLowerCase();
  let canonicalBase = lowerBase.replaceAll(".", "-");

  const alias = SPECIAL_ALIASES.get(canonicalBase);

  if (alias !== undefined) return alias;

  if (canonicalBase.includes("sonnet-4-5"))
    return effort !== "" && effort !== "none" ? "MODEL_PRIVATE_3" : "MODEL_PRIVATE_2";

  if (canonicalBase === "gemini-3-flash") canonicalBase = "gemini-3-8-flash";

  switch (canonicalBase.replaceAll("-", "_")) {
    case "model_gpt_5_2":
      return `MODEL_GPT_5_2_${clampEffort(effort, ["none", "low", "medium", "high", "xhigh"], "low").toUpperCase()}`;
    case "model_google_gemini_3_0_flash":
      return `MODEL_GOOGLE_GEMINI_3_0_FLASH_${clampEffort(effort, ["minimal", "low", "medium", "high"], "high").toUpperCase()}`;
    case "model_claude_4_5_opus":
      return effort !== "" && effort !== "none"
        ? "MODEL_CLAUDE_4_5_OPUS_THINKING"
        : "MODEL_CLAUDE_4_5_OPUS";
  }

  const thinks = effort !== "" && effort !== "none";

  switch (canonicalBase) {
    case "swe-1-7":
      return effort === "medium" ? "swe-1-7-medium" : "swe-1-7";
    case "swe-1-6":
      return effort === "fast" ? "swe-1-6-fast" : "swe-1-6";
    case "glm-5-2":
      return glmEffortModel(effort, "glm-5-2");
    case "glm-5-2-1m":
      return glmEffortModel(effort, "glm-5-2", "-1m");
    case "claude-opus-4-6":
    case "claude-sonnet-4-6":
      return thinks ? `${canonicalBase}-thinking` : canonicalBase;
    case "claude-opus-4-6-1m":
      return thinks ? "claude-opus-4-6-thinking-1m" : canonicalBase;
    case "claude-sonnet-4-6-1m":
      return thinks ? "claude-sonnet-4-6-thinking-1m" : canonicalBase;
  }

  const allowed =
    levelsOf(canonicalBase) ??
    (canonicalBase !== lowerBase ? levelsOf(lowerBase) : undefined) ??
    [];

  // The lightning tier keeps the effort before the suffix upstream (`swe-2-high-lightning`).
  if (canonicalBase.endsWith("-lightning")) {
    const stem = canonicalBase.slice(0, -"-lightning".length);

    if (hasDevinEffortSuffix(stem) || allowed.length === 0) return canonicalBase;

    return `${stem}-${clampEffort(effort, allowed, defaultEffortFor(stem, allowed))}-lightning`;
  }

  if (allowed.length === 0) return canonicalBase;

  const defaultEffort = defaultEffortFor(canonicalBase, allowed);

  // A strict `<level>-fast` request keeps its level (clamped to the catalog), never the plain default.
  if (rawLevel.endsWith("-fast")) {
    const level = rawLevel.slice(0, -"-fast".length);

    if (levelIndex(level) !== -1) {
      return `${canonicalBase}-${clampEffort(level, allowed, defaultEffort)}-fast`;
    }
  }

  const clamped = clampEffort(effort, allowed, defaultEffort);

  return effort === "fast" ? `${canonicalBase}-${clamped}-fast` : `${canonicalBase}-${clamped}`;
};
