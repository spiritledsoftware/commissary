/**
 * The `signature_type` tags Devin puts on thought signatures (wire field 18 of a prompt, `signature_type` of an
 * Interactions thought step).
 */
export const DevinSignatureType = {
  /** Devin-sealed (`sealed.v1.`) signatures. */
  sealed: "sealed",
  anthropic: "anthropic",
  /** GPT reasoning, including Devin's serialized list of reasoning items. */
  openai: "openai",
  gemini: "gemini",
} as const;
