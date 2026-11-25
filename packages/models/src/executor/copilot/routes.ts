/**
 * GitHub Copilot model routes: which Copilot endpoint (and so which upstream protocol) serves a preset model, and the
 * Copilot CLI's defaults for it.
 *
 * Go source: internal/auth/copilot/catalog.go (`Compatibility`, `Route`, `Model.route` with `cold` set: the preset
 * route a credential uses before discovery), internal/auth/copilot/compat.json (the profiles below). A model routes only
 * when it is one of the Copilot presets of the catalog additions (`copilot` section, `catalog/additions.json`, Go
 * `models.json` `copilot`) and has a profile here; the default effort applies only when the model offers that level,
 * and a default budget only to a budget-only model, clamped to its range.
 *
 * Deliberate difference from Go: Commissary has no per-account `/models` discovery (Go intersects the presets with each
 * account's directory, every 2 hours, in a dedicated worker pool), so every Copilot credential serves every preset
 * through its preset route; an account that lacks a model answers the request with its own error. See
 * docs/ARCHITECTURE.md, "GitHub Copilot".
 */
import type { ThinkingModelInfo } from "@commissary/translation/thinking";
import { Formats } from "@commissary/translation/formats";
import { additionRecord } from "../../registry/catalog-additions.ts";
import { catalogAdditions } from "../../registry/catalog.ts";

export const COPILOT_PROVIDER = "copilot";

/** Go `copilot.ModelPrefix`: a client may name a model `copilot/<id>`; the upstream gets the bare id. */
export const COPILOT_MODEL_PREFIX = `${COPILOT_PROVIDER}/`;

export const COPILOT_CHAT = "/chat/completions";

export const COPILOT_MESSAGES = "/v1/messages";

export const COPILOT_RESPONSES = "/responses";

export type CopilotEndpoint =
  | typeof COPILOT_CHAT
  | typeof COPILOT_MESSAGES
  | typeof COPILOT_RESPONSES;

/** Go `Compatibility`: the official CLI's route and defaults for one model. */
interface CopilotProfile {
  readonly endpoint: CopilotEndpoint;
  /** Responses only: where a leading system prompt goes (`instructions`, or input items with the `system` role). */
  readonly systemPrompt?: "instructions" | "system" | undefined;
  readonly nonStreamingOutput?: number | undefined;
  readonly defaultVerbosity?: string | undefined;
  readonly defaultToolChoice?: string | undefined;
  readonly disableSnippy?: boolean | undefined;
  readonly defaultEffort?: string | undefined;
  readonly defaultBudget?: number | undefined;
  readonly defaultMaxTokens?: number | undefined;
  readonly anthropicBetas?: ReadonlyArray<string> | undefined;
}

const BLOCK_BINDING_BETAS = [
  "thinking-binding-controls-2026-08-01",
  "mid-conversation-output-config-2026-07-01",
] as const;

const claude = (profile: Omit<CopilotProfile, "endpoint">): CopilotProfile => ({
  endpoint: COPILOT_MESSAGES,
  nonStreamingOutput: 16_000,
  ...profile,
});

const gemini = (): CopilotProfile => ({
  endpoint: COPILOT_CHAT,
  defaultEffort: "medium",
  disableSnippy: true,
  defaultToolChoice: "validated",
});

const responses = (
  systemPrompt: "instructions" | "system",
  defaultEffort: string,
  defaultVerbosity?: string,
): CopilotProfile => ({
  endpoint: COPILOT_RESPONSES,
  systemPrompt,
  defaultEffort,
  defaultVerbosity,
});

/** Go `compat.json` at dd543d09 (`adaptive_mode` and `limit_efforts` only shape discovered accounts, not presets). */
const PROFILES = new Map<string, CopilotProfile>(
  Object.entries({
    "claude-fable-5": claude({ defaultMaxTokens: 32_000, defaultEffort: "medium" }),
    "claude-fable-5.1": claude({
      defaultMaxTokens: 32_000,
      anthropicBetas: BLOCK_BINDING_BETAS,
      defaultEffort: "medium",
    }),
    "claude-fable-5.2": claude({
      defaultMaxTokens: 48_000,
      anthropicBetas: BLOCK_BINDING_BETAS,
      defaultEffort: "medium",
    }),
    "claude-haiku-4.5": claude({ defaultMaxTokens: 8192, defaultBudget: 1024 }),
    "claude-haiku-5.5": claude({
      defaultMaxTokens: 128_000,
      anthropicBetas: ["thinking-binding-controls-2026-08-01"],
      defaultEffort: "medium",
    }),
    "claude-opus-4.8-fast": claude({ defaultMaxTokens: 32_000, defaultEffort: "medium" }),
    "claude-opus-5": claude({}),
    "claude-opus-5.5": claude({
      defaultMaxTokens: 48_000,
      anthropicBetas: BLOCK_BINDING_BETAS,
      defaultEffort: "medium",
    }),
    "claude-sonnet-5": claude({ defaultMaxTokens: 64_000, defaultEffort: "medium" }),
    "claude-sonnet-5.5": claude({
      defaultMaxTokens: 64_000,
      anthropicBetas: ["thinking-binding-controls-2026-08-01", "fallback-credit-2026-07-01"],
      defaultEffort: "medium",
    }),
    "gemini-4-argon": gemini(),
    "gemini-4-carbon": gemini(),
    "gemini-4-hydrogen": gemini(),
    "gemini-4-neon": gemini(),
    "kimi-k3": { endpoint: COPILOT_CHAT, defaultEffort: "high", disableSnippy: true },
    "gpt-5.3-codex": responses("instructions", "medium", "low"),
    "gpt-5.6-luna": responses("system", "medium", "low"),
    "gpt-5.6-sol": responses("system", "medium", "low"),
    "gpt-6-astra": responses("system", "medium", "low"),
    "gpt-6-luna": responses("system", "medium", "low"),
    "gpt-6-sol": responses("system", "medium", "low"),
    "gpt-6.1-sol": responses("system", "medium", "low"),
    "gpt-6.1-terra": responses("system", "medium", "low"),
    "gpt-6.2-astra": responses("system", "medium", "low"),
    "gpt-6.2-sol": responses("system", "medium", "low"),
    "grok-4.6": responses("instructions", "medium"),
    "grok-4.7": responses("instructions", "high"),
    "mai-code-1.1-flash": responses("instructions", "medium"),
    "mai-code-2": responses("instructions", "medium", "low"),
    "mai-code-2-flash": responses("instructions", "medium", "low"),
  } satisfies Record<string, CopilotProfile>),
);

const FORMATS = {
  [COPILOT_CHAT]: Formats.OpenAI,
  [COPILOT_MESSAGES]: Formats.Claude,
  [COPILOT_RESPONSES]: Formats.OpenAIResponse,
} as const;

/** Go `Route`: the endpoint, its protocol and the defaults of one model for this attempt. */
export interface CopilotRoute {
  /** The native model id sent upstream. */
  readonly model: string;
  readonly endpoint: CopilotEndpoint;
  readonly format: (typeof FORMATS)[CopilotEndpoint];
  /** Whether the model thinks at all (Go `Info.Thinking != nil`). */
  readonly thinks: boolean;
  /** Cap of `max_tokens` (Go `Info.MaxCompletionTokens`), 0 = none. */
  readonly maxCompletionTokens: number;
  readonly systemPrompt: "instructions" | "system" | undefined;
  readonly nonStreamingOutput: number;
  readonly defaultVerbosity: string | undefined;
  readonly defaultToolChoice: string | undefined;
  readonly disableSnippy: boolean;
  readonly defaultEffort: string | undefined;
  readonly defaultBudget: number;
  readonly defaultMaxTokens: number;
  readonly anthropicBetas: ReadonlyArray<string>;
}

/** The native id of a requested model: `copilot/` dropped (Go `strings.TrimPrefix(..., copilot.ModelPrefix)`). */
export const copilotNativeModel = (model: string): string =>
  model.startsWith(COPILOT_MODEL_PREFIX) ? model.slice(COPILOT_MODEL_PREFIX.length) : model;

/**
 * The route of `model` (native id, no thinking suffix), or `undefined` when no Copilot endpoint serves it. `info` is
 * the model as the registry resolved it for the credential (thinking levels and output limit); without it the preset
 * record of the catalog additions stands in.
 */
export const resolveCopilotRoute = (
  model: string,
  info: ThinkingModelInfo | undefined,
): CopilotRoute | undefined => {
  const profile = PROFILES.get(model);
  const preset = additionRecord(catalogAdditions(), COPILOT_PROVIDER, model);

  if (profile === undefined || preset === undefined) return undefined;
  const thinking = info?.thinking ?? preset.thinking;
  const levels = thinking?.levels ?? [];
  const min = thinking?.min ?? 0;
  const max = thinking?.max ?? 0;
  let defaultEffort: string | undefined;
  let defaultBudget = 0;

  if (thinking !== undefined) {
    if (profile.defaultEffort !== undefined && levels.includes(profile.defaultEffort))
      defaultEffort = profile.defaultEffort;
    else if (levels.length === 0 && (profile.defaultBudget ?? 0) > 0 && max > 0)
      defaultBudget = Math.min(Math.max(profile.defaultBudget ?? 0, min), max);
  }

  return {
    model,
    endpoint: profile.endpoint,
    format: FORMATS[profile.endpoint],
    thinks: thinking !== undefined,
    maxCompletionTokens: info?.maxCompletionTokens ?? preset.maxCompletionTokens ?? 0,
    systemPrompt: profile.systemPrompt,
    nonStreamingOutput: profile.nonStreamingOutput ?? 0,
    defaultVerbosity: profile.defaultVerbosity,
    defaultToolChoice: profile.defaultToolChoice,
    disableSnippy: profile.disableSnippy === true,
    defaultEffort,
    defaultBudget,
    defaultMaxTokens: profile.defaultMaxTokens ?? 0,
    anthropicBetas: profile.anthropicBetas ?? [],
  };
};
