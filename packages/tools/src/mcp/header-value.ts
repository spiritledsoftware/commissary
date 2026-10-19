/**
 * The value encoding of MCP's request headers that mirror the body (`Mcp-Name`, `Mcp-Param-*`, 2026-07-28): a value
 * that is visible ASCII goes as it is; any other, or one that looks like the sentinel, goes as `=?base64?…?=` over its
 * UTF-8 bytes. The MCP client encodes the headers it sends upstream; the endpoint decodes the ones a client sends.
 */
import { Buffer } from "node:buffer";

const SENTINEL = /^=\?base64\?(.*)\?=$/;

/** Visible ASCII, with spaces and tabs inside only. */
const PLAIN = /^(?:[\x21-\x7e](?:[\x20-\x7e\t]*[\x21-\x7e])?)?$/;

/** `value` as a header carries it: plain, or `=?base64?…?=` when it cannot be. */
export const encodeHeaderValue = (value: string): string =>
  PLAIN.test(value) && !SENTINEL.test(value)
    ? value
    : `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;

/** A header's value: `=?base64?…?=` decoded, anything else as it is. */
export const decodeHeaderValue = (value: string): string => {
  const encoded = SENTINEL.exec(value)?.[1];

  return encoded === undefined ? value : Buffer.from(encoded, "base64").toString("utf8");
};
