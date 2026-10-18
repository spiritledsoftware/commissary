// Port of sdk/translator/formats.go and the entry-protocol tags used by the Go handlers (sdk/api/handlers/*).

/** Protocol formats known to the translator registry. Clients use the first five; executors target the others too. */
export const Formats = {
  OpenAI: "openai",
  OpenAIResponse: "openai-response",
  Claude: "claude",
  Gemini: "gemini",
  Interactions: "interactions",
  Codex: "codex",
  Antigravity: "antigravity",
} as const;

/**
 * Entry protocols without translators: the handler passes them as `sourceFormat` and the executor handles them
 * natively (images, videos, speech, Codex alpha search, System One). `systemone` (TypeSafe's System One API, ADR 0032) is
 * also the registry type of System One models and the payload-rule protocol of their requests.
 */
export const EntryOnlyFormats = {
  OpenAIImage: "openai-image",
  OpenAIVideo: "openai-video",
  OpenAISpeech: "openai-speech",
  CodexAlphaSearch: "codex-alpha-search",
  SystemOne: "systemone",
} as const;

/** Any format id; unknown ids are allowed (the registry falls back to passthrough). */
export type Format = string;
