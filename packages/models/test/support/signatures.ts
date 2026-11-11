/** Synthetic provider signatures that satisfy the strict validators of `@commissary/translation/signature`. */

const field = (num: number, bytes: number[]): number[] => [(num << 3) | 2, bytes.length, ...bytes];

const zeros = (length: number): number[] => Array.from({ length }, () => 0);

/** A strict-valid single-layer (`E…`) Claude signature: protobuf field 2 -> container(field 1 channel, field 2). */
export const claudeSignature = (): string => {
  const channel = [(1 << 3) | 0, 11, (3 << 3) | 0, 2, ...field(5, zeros(64))];
  const container = [...field(1, channel), ...field(2, zeros(12))];

  return btoa(String.fromCharCode(...field(2, container)));
};

/** A shape-valid synthetic Meta Muse envelope (Go `validMetaReasoningEncryptedContentForTest`): header 43e3da0e01, 1 KiB bucket. */
export const metaSignature = (): string => `Q-PaDgE${"A".repeat(1419)}`;

/** An OpenRouter-style router suffix on `signature`: one `.` and 67 alphanumeric characters. */
export const routerSuffixed = (signature: string, length = 67): string =>
  `${signature}.${"Ab3".repeat(30).slice(0, length)}`;

/** A GPT/Codex Fernet-shaped `encrypted_content` (Go `validOpenAIResponsesReasoningEncryptedContentForTest`). */
export const gptSignature = (): string => {
  const bytes = Array.from({ length: 73 }, (_, i) => (i >= 9 ? i : 0));

  bytes[0] = 0x80;

  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};
