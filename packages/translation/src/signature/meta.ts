/**
 * Meta Muse reasoning `encrypted_content` validation.
 *
 * Go source: internal/signature/meta_validation.go (`InspectMetaReasoningSignature`, `IsValidMetaReasoningSignature`).
 * A transport-shape check only: canonical unpadded base64url, the fixed five-byte header observed on every captured value
 * (api.meta.ai, 2026-10-15), and a decoded length of exactly 45 + 1024 * 2^k bytes. A future header rotation falls back to
 * unknown rather than being claimed on weaker evidence. A router such as OpenRouter may append one `.` and a short
 * alphanumeric suffix; it is reported here and the full value replays verbatim. Cache-prefixed forms (`meta#...`) are not
 * recognised: no producer emits them.
 */
import { decodeBase64Std } from "./base64.ts";
import { splitRouterSuffix } from "./router-suffix.ts";

export { isValidRouterSuffix, stripRouterSuffix } from "./router-suffix.ts";

const MAX_META_REASONING_SIGNATURE_LEN = 32 * 1024 * 1024;

const OVERHEAD_LEN = 45;

const MIN_PAYLOAD = 1024;

const HEADER = [0x43, 0xe3, 0xda, 0x0e, 0x01] as const;

const BASE64_URL_UNPADDED = /^[A-Za-z0-9_-]+$/;

export interface MetaReasoningSignatureInfo {
  readonly decodedLen: number;
  /** `decodedLen` minus the fixed overhead: the power-of-two padded region, not a proven plaintext length. */
  readonly payloadLen: number;
  readonly bucketExponent: number;
  /** The router suffix, `""` for a native value. */
  readonly routerSuffix: string;
}

const inspectNative = (
  sig: string,
): Omit<MetaReasoningSignatureInfo, "routerSuffix"> | undefined => {
  // The literal prefix is the cheapest discriminator; probing this validator is on the hot path for every provider.
  if (!sig.startsWith("Q-PaDg")) return undefined;

  // Reject by encoded length before scanning or decoding: only bucket-sized candidates reach the decoder.
  if (sig.length % 4 === 1) return undefined;
  let decodedLen = Math.floor(sig.length / 4) * 3;

  if (sig.length % 4 === 2) decodedLen += 1;
  else if (sig.length % 4 === 3) decodedLen += 2;
  const payloadLen = decodedLen - OVERHEAD_LEN;

  if (payloadLen < MIN_PAYLOAD || (payloadLen & (payloadLen - 1)) !== 0) return undefined;

  if (!BASE64_URL_UNPADDED.test(sig)) return undefined;

  // Strict decoding rejects non-canonical trailing bits.
  const std = sig.replace(/-/g, "+").replace(/_/g, "/");
  const decoded = decodeBase64Std(std + "=".repeat((4 - (std.length % 4)) % 4), true);

  if (decoded === undefined || !HEADER.every((byte, i) => decoded[i] === byte)) return undefined;
  let bucketExponent = 0;

  for (let p = payloadLen; p > MIN_PAYLOAD; p >>= 1) bucketExponent++;

  return { decodedLen: decoded.length, payloadLen, bucketExponent };
};

/** `InspectMetaReasoningSignature`: the envelope description, or `undefined` when `raw` is not a Meta Muse envelope. */
export const inspectMetaReasoningSignature = (
  raw: string,
): MetaReasoningSignatureInfo | undefined => {
  const sig = raw.trim();

  if (sig === "" || sig.length > MAX_META_REASONING_SIGNATURE_LEN) return undefined;

  // Reject other providers' signatures before scanning for a router suffix.
  if (!sig.startsWith("Q-PaDg")) return undefined;
  const split = splitRouterSuffix(sig);

  if (split === undefined) return undefined;
  const native = inspectNative(split.native);

  return native === undefined ? undefined : { ...native, routerSuffix: split.routerSuffix };
};

/** `IsValidMetaReasoningSignature`. */
export const isValidMetaReasoningSignature = (raw: string): boolean =>
  inspectMetaReasoningSignature(raw) !== undefined;
