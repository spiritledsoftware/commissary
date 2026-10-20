/**
 * The hash a pending approval matches its repeated call by (#201, ADR 0038): the SHA-256 (hex) of the call's arguments
 * in a canonical JSON form, so the same arguments hash alike whatever order their keys came in. Absent arguments are
 * `{}`, as a call without them means.
 *
 * The canonical form is the JSON Canonicalization Scheme's (RFC 8785) for what a call's arguments can hold: object keys
 * sorted by their UTF-16 code units at every depth, array order kept, no whitespace, strings and numbers as
 * `JSON.stringify` writes them (ECMAScript's number form, which RFC 8785 adopts).
 */
import type { Schema } from "effect";
import { sha256Hex } from "@commissary/core";

/** `value` as canonical JSON text. */
export const canonicalJson = (value: Schema.Json): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);

  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;

  // The default sort compares strings by their UTF-16 code units, as RFC 8785 orders keys.
  const keys = Object.keys(value).toSorted();

  return `{${keys
    .map((key) => {
      // SAFETY: `key` is one of the object's own keys, read just above.
      const field = (value as Readonly<Record<string, Schema.Json>>)[key] as Schema.Json;

      return `${JSON.stringify(key)}:${canonicalJson(field)}`;
    })
    .join(",")}}`;
};

/** The hash of a call's arguments: hex SHA-256 of their canonical JSON (`{}` when there are none). */
export const argumentsHash = (args: Schema.JsonObject | undefined): string =>
  sha256Hex(canonicalJson(args ?? {}));
