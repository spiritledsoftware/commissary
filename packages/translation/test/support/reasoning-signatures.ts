// Synthetic GPT (Fernet) and Meta Muse reasoning signatures for the signature tests: transport-shape-valid, but no real
// provider payload (Go `testGPTReasoningSignature`, `testMetaReasoningSignature`).

/** Unpadded base64url of `bytes`. */
export const rawUrl = (bytes: ReadonlyArray<number>): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** A GPT/Codex `encrypted_content`: version 0x80, timestamp, IV, 48 ciphertext bytes, HMAC (`gAAAA…`). */
export const fernetReasoningSignature = (): string => {
  const bytes = [0x80, 0, 0, 0];

  while (bytes.length < 105) bytes.push((bytes.length * 37 + 11) & 0xff);

  return rawUrl(bytes);
};

const META_HEADER = [0x43, 0xe3, 0xda, 0x0e, 0x01];

/** The decoded bytes of a Meta envelope: the fixed header, then deterministic filler up to 45 + `payloadLen`. */
export const metaSignatureBytes = (
  payloadLen: number,
  mutate?: (bytes: Array<number>) => void,
): Array<number> => {
  const bytes = [...META_HEADER];

  while (bytes.length < 45 + payloadLen) bytes.push((bytes.length * 31 + 7) & 0xff);
  mutate?.(bytes);

  return bytes;
};

/** A Meta Muse reasoning `encrypted_content` with a `payloadLen` byte payload bucket. */
export const metaSignature = (payloadLen: number): string => rawUrl(metaSignatureBytes(payloadLen));
