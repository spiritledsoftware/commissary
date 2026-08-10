import { isJsonValue, type JsonValue } from "../../json.js";
import type { RuntimePhysicalType, SqliteDirectTypeName } from "./resolution-types.js";

const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** Reject one invalid direct SQLite codec value. */
export function invalidValue(type: string): never {
  throw new TypeError(`SQLite ${type} codec received an invalid value`);
}

function safeInteger(value: unknown, type: string): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : invalidValue(type);
}

function finiteNumber(value: unknown, type: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return invalidValue(type);
  return Object.is(value, -0) ? 0 : value;
}

function stringValue(
  value: unknown,
  type: string,
  validate: (value: string) => boolean = () => true,
): string {
  return typeof value === "string" && validate(value) ? value : invalidValue(type);
}

function isValidSqliteText(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0 || (codeUnit >= 0xdc00 && codeUnit <= 0xdfff)) return false;
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (!(nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff)) return false;
      index++;
    }
  }
  return true;
}

function decodeBase64(value: string): Uint8Array {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return invalidValue("blob");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const output = new Uint8Array((value.length / 4) * 3 - padding);
  let outputIndex = 0;
  for (let index = 0; index < value.length; index += 4) {
    const a = base64Alphabet.indexOf(value[index] ?? "");
    const b = base64Alphabet.indexOf(value[index + 1] ?? "");
    const c = value[index + 2] === "=" ? 0 : base64Alphabet.indexOf(value[index + 2] ?? "");
    const d = value[index + 3] === "=" ? 0 : base64Alphabet.indexOf(value[index + 3] ?? "");
    const bits = (a << 18) | (b << 12) | (c << 6) | d;
    if (outputIndex < output.length) output[outputIndex++] = (bits >> 16) & 0xff;
    if (outputIndex < output.length) output[outputIndex++] = (bits >> 8) & 0xff;
    if (outputIndex < output.length) output[outputIndex++] = bits & 0xff;
  }
  if (encodeBase64(output) !== value) return invalidValue("blob");
  return output;
}

function encodeBase64(value: Uint8Array): string {
  let output = "";
  for (let index = 0; index < value.length; index += 3) {
    const a = value[index] ?? 0;
    const b = value[index + 1] ?? 0;
    const c = value[index + 2] ?? 0;
    const bits = (a << 16) | (b << 8) | c;
    output += base64Alphabet[(bits >> 18) & 63];
    output += base64Alphabet[(bits >> 12) & 63];
    output += index + 1 < value.length ? base64Alphabet[(bits >> 6) & 63] : "=";
    output += index + 2 < value.length ? base64Alphabet[bits & 63] : "=";
  }
  return output;
}

function decodeUtf8(value: unknown, type: string): string {
  if (!(value instanceof Uint8Array)) return invalidValue(type);
  try {
    return utf8Decoder.decode(value);
  } catch {
    return invalidValue(type);
  }
}

function parseTimestamp(value: string, milliseconds: boolean): number | undefined {
  const pattern = milliseconds
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/
    : /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;
  const match = pattern.exec(value);
  if (match === null) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = milliseconds ? Number(match[7]) : 0;
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) {
    return undefined;
  }
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, fraction);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second ||
    date.getUTCMilliseconds() !== fraction
  ) {
    return undefined;
  }
  const epochMilliseconds = date.getTime();
  return milliseconds ? epochMilliseconds : epochMilliseconds / 1000;
}

function formatTimestamp(value: unknown, milliseconds: boolean, type: string): string {
  const epoch = safeInteger(value, type);
  const epochMilliseconds = milliseconds ? epoch : epoch * 1000;
  const date = new Date(epochMilliseconds);
  const year = date.getUTCFullYear();
  if (!Number.isFinite(date.getTime()) || year < 0 || year > 9999) return invalidValue(type);
  const base = `${String(year).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(
    2,
    "0",
  )}-${String(date.getUTCDate()).padStart(2, "0")}T${String(date.getUTCHours()).padStart(
    2,
    "0",
  )}:${String(date.getUTCMinutes()).padStart(2, "0")}:${String(date.getUTCSeconds()).padStart(
    2,
    "0",
  )}`;
  return milliseconds
    ? `${base}.${String(date.getUTCMilliseconds()).padStart(3, "0")}Z`
    : `${base}Z`;
}

function timestampCodec(
  type: "timestamp-seconds" | "timestamp-milliseconds",
): Pick<RuntimePhysicalType, "application" | "encode" | "decode"> {
  const milliseconds = type === "timestamp-milliseconds";
  return {
    application: "string",
    encode: (value) => {
      const text = stringValue(value, type);
      const encoded = parseTimestamp(text, milliseconds);
      return encoded === undefined ? invalidValue(type) : encoded;
    },
    decode: (value) => formatTimestamp(value, milliseconds, type),
  };
}

function parseJsonText(value: string, type: string): JsonValue {
  try {
    const parsed: unknown = JSON.parse(value);
    return isJsonValue(parsed) ? parsed : invalidValue(type);
  } catch {
    return invalidValue(type);
  }
}

function stringifyJson(value: unknown, type: string): string {
  if (!isJsonValue(value)) return invalidValue(type);
  try {
    return JSON.stringify(value);
  } catch {
    return invalidValue(type);
  }
}

function isCanonicalIntegerText(value: string): boolean {
  return /^-?(?:0|[1-9][0-9]*)$/.test(value) && value !== "-0";
}

function isCanonicalNumericText(value: string): boolean {
  if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?(?:e-?(?:0|[1-9][0-9]*))?$/.test(value)) {
    return false;
  }
  const number = Number(value);
  return Number.isFinite(number) && (number !== 0 || value === "0");
}

function canonicalNumber(value: unknown, type: string): string {
  const number = finiteNumber(value, type);
  return String(number).replace("e+", "e");
}

/** Select the driver-independent codec for one direct SQLite type. */
export function directCodec(
  type: SqliteDirectTypeName,
): Pick<RuntimePhysicalType, "application" | "encode" | "decode"> {
  switch (type) {
    case "integer":
      return {
        application: "integer",
        encode: (value) => safeInteger(value, type),
        decode: (value) => safeInteger(value, type),
      };
    case "boolean":
      return {
        application: "boolean",
        encode: (value) => (typeof value === "boolean" ? (value ? 1 : 0) : invalidValue(type)),
        decode: (value) => (value === 0 ? false : value === 1 ? true : invalidValue(type)),
      };
    case "timestamp-seconds":
    case "timestamp-milliseconds":
      return timestampCodec(type);
    case "real":
    case "numeric-number":
      return {
        application: "number",
        encode: (value) => finiteNumber(value, type),
        decode: (value) => finiteNumber(value, type),
      };
    case "text":
      return {
        application: "string",
        encode: (value) => stringValue(value, type, isValidSqliteText),
        decode: (value) => stringValue(value, type, isValidSqliteText),
      };
    case "json":
      return {
        application: "json",
        encode: (value) => stringifyJson(value, type),
        decode: (value) => parseJsonText(stringValue(value, type), type),
      };
    case "blob":
      return {
        application: "string",
        encode: (value) => decodeBase64(stringValue(value, type)),
        decode: (value) => (value instanceof Uint8Array ? encodeBase64(value) : invalidValue(type)),
      };
    case "json-blob":
      return {
        application: "json",
        encode: (value) => utf8Encoder.encode(stringifyJson(value, type)),
        decode: (value) => parseJsonText(decodeUtf8(value, type), type),
      };
    case "bigint-blob":
      return {
        application: "string",
        encode: (value) => {
          const text = stringValue(value, type, isCanonicalIntegerText);
          return utf8Encoder.encode(text);
        },
        decode: (value) => stringValue(decodeUtf8(value, type), type, isCanonicalIntegerText),
      };
    case "numeric":
      return {
        application: "string",
        encode: (value) => stringValue(value, type, isCanonicalNumericText),
        decode: (value) => {
          const text =
            typeof value === "number"
              ? canonicalNumber(value, type)
              : stringValue(value, type, isCanonicalNumericText);
          return isCanonicalNumericText(text) ? text : invalidValue(type);
        },
      };
  }
}
