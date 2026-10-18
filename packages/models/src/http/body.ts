/**
 * Request body decoding (Codex CLI sends zstd-compressed bodies).
 *
 * Go source: sdk/api/handlers/request_body.go (ReadRequestBody). `Content-Encoding` lists are decoded right to left;
 * `identity` is skipped; anything other than `zstd` is rejected. When decoding fails but the raw bytes are valid JSON
 * the raw bytes are used. Workers' `DecompressionStream` has no zstd, so the pure-JS `fzstd` decoder is used, bounded
 * to {@link MAX_DECODED_BODY_BYTES} (Workers deviation: Go reads the decoded body without a limit).
 */
import { isValidJson } from "@commissary/json";
import { DecodedBodyTooLargeError, inflateZstd } from "./zstd.ts";

/** Upper bound of a decoded (decompressed) request body; larger bodies answer 413. */
export const MAX_DECODED_BODY_BYTES = 32 * 1024 * 1024;

export class RequestBodyDecodeError extends Error {
  override readonly name: string = "RequestBodyDecodeError";
}

/** The decompressed body exceeds {@link MAX_DECODED_BODY_BYTES} (HTTP 413). */
export class RequestBodyTooLargeError extends RequestBodyDecodeError {
  override readonly name = "RequestBodyTooLargeError";
}

const decoder = new TextDecoder();

const decodeEncodings = (raw: Uint8Array, encoding: string, limit: number): Uint8Array => {
  let body = raw;
  const parts = encoding.split(",");

  for (let i = parts.length - 1; i >= 0; i--) {
    const enc = (parts[i] ?? "").trim().toLowerCase();

    if (enc === "" || enc === "identity") continue;

    if (enc !== "zstd")
      throw new RequestBodyDecodeError(`unsupported request content encoding: ${enc}`);

    try {
      body = inflateZstd(body, limit);
    } catch (cause) {
      if (cause instanceof DecodedBodyTooLargeError) {
        throw new RequestBodyTooLargeError(`decoded request body exceeds ${limit} bytes`);
      }

      throw new RequestBodyDecodeError(`failed to decode zstd request body: ${String(cause)}`);
    }
  }

  return body;
};

/**
 * Decodes a request body according to its `Content-Encoding` header and returns the bytes (a multipart body is not
 * text). Throws like {@link decodeRequestBody}, without its JSON fallback.
 */
export const decodeRequestBytes = (
  raw: Uint8Array,
  contentEncoding: string | undefined,
  limit: number = MAX_DECODED_BODY_BYTES,
): Uint8Array => {
  const encoding = (contentEncoding ?? "").trim();

  return encoding === "" || encoding.toLowerCase() === "identity"
    ? raw
    : decodeEncodings(raw, encoding, limit);
};

/**
 * Decodes a request body according to its `Content-Encoding` header and returns the text.
 * Throws {@link RequestBodyDecodeError} for unsupported encodings or corrupt data (unless the raw body is JSON) and
 * {@link RequestBodyTooLargeError} when the decoded body would exceed `limit` bytes.
 */
export const decodeRequestBody = (
  raw: Uint8Array,
  contentEncoding: string | undefined,
  limit: number = MAX_DECODED_BODY_BYTES,
): string => {
  const encoding = (contentEncoding ?? "").trim();

  if (encoding === "" || encoding.toLowerCase() === "identity") return decoder.decode(raw);

  try {
    return decoder.decode(decodeEncodings(raw, encoding, limit));
  } catch (error) {
    const text = decoder.decode(raw);

    if (isValidJson(text)) return text;
    throw error;
  }
};
