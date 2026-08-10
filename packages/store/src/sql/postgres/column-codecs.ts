import { isJsonValue, type JsonValue } from "../../json.js";
import { isSqlRecordContainer as isRecordContainer } from "../record-catalog-resolver.js";
import type {
  PostgresArrayDriverValue,
  PostgresDirectTypeName,
  PostgresEncodedValue,
  RuntimePhysicalType,
} from "./resolution-types.js";

export function invalidValue(type: string): never {
  throw new TypeError(`PostgreSQL ${type} codec received an invalid value`);
}

function finiteNumber(value: unknown, type: string): number {
  return typeof value === "number" && Number.isFinite(value) ? value : invalidValue(type);
}

function boundedInteger(value: unknown, type: string, minimum: number, maximum: number): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : invalidValue(type);
}

function isExactIntegerText(value: string, minimum: bigint, maximum: bigint): boolean {
  if (!/^-?(?:0|[1-9]\d*)$/.test(value) || value === "-0") {
    return false;
  }
  const parsed = BigInt(value);
  return parsed >= minimum && parsed <= maximum;
}

export function safeIntegerCodec(): Pick<RuntimePhysicalType, "application" | "encode" | "decode"> {
  return {
    application: "integer",
    encode: (value) =>
      String(boundedInteger(value, "bigint", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)),
    decode: (value) => {
      if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)$/.test(value)) {
        return invalidValue("bigint");
      }
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) ? parsed : invalidValue("bigint");
    },
  };
}

export function stringCodec(
  type: string,
  validate: (value: string) => boolean = () => true,
  decode: (value: string) => string = (value) => value,
): Pick<RuntimePhysicalType, "application" | "encode" | "decode"> {
  return {
    application: "string",
    encode: (value) => (typeof value === "string" && validate(value) ? value : invalidValue(type)),
    decode: (value) => {
      if (typeof value !== "string") return invalidValue(type);
      const decoded = decode(value);
      return validate(decoded) ? decoded : invalidValue(type);
    },
  };
}

function fitsCharacterLength(value: string, maximum: unknown): boolean {
  if (typeof maximum !== "number") return true;
  let length = 0;
  for (const _codePoint of value) {
    length += 1;
    if (length > maximum) return false;
  }
  return true;
}

const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeBase64(value: string): Uint8Array {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return invalidValue("bytea");
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

function leapYear(year: bigint): boolean {
  return year % 4n === 0n && (year % 100n !== 0n || year % 400n === 0n);
}

interface PostgresDateParts {
  readonly year: bigint;
  readonly yearWidth: number;
  readonly forceSign: boolean;
  readonly month: number;
  readonly day: number;
}

interface PostgresTimeParts {
  readonly hour: number;
  readonly minute: number;
  readonly second: string;
  readonly fraction: string;
  readonly offsetMinutes?: number;
}
// ISO 8601 year 0000 represents 1 BC, so PostgreSQL's 4713 BC lower bound is -4712.
const postgresMinimumIsoYear = -4_712n;
const postgresMaximumDateIsoYear = 5_874_897n;
const postgresMaximumTimestampIsoYear = 294_276n;

function postgresDaysInMonth(year: bigint, month: number): number {
  return [31, leapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

function parsePostgresDate(value: string): PostgresDateParts | undefined {
  const match = /^([+-]?)(\d{4,})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return undefined;
  const sign = match[1] ?? "";
  const yearDigits = match[2] ?? "0";
  const year = BigInt(`${sign}${yearDigits}`);
  const month = Number(match[3]);
  const day = Number(match[4]);
  if (month < 1 || month > 12 || day < 1 || day > postgresDaysInMonth(year, month)) {
    return undefined;
  }
  return {
    year,
    yearWidth: yearDigits.length,
    forceSign: sign.length > 0,
    month,
    day,
  };
}
function postgresDateInRange(parts: PostgresDateParts, maximumYear: bigint): boolean {
  return parts.year >= postgresMinimumIsoYear && parts.year <= maximumYear;
}

function validDate(value: string): boolean {
  const parts = parsePostgresDate(value);
  return parts !== undefined && postgresDateInRange(parts, postgresMaximumDateIsoYear);
}

function parsePostgresTimeZone(value: string): number | undefined {
  if (value === "Z") return 0;
  const match = /^([+-])(\d{2})(?::?(\d{2}))?$/.exec(value);
  if (match === null) return undefined;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? "0");
  if (hours > 15 || minutes > 59) return undefined;
  const offset = hours * 60 + minutes;
  return match[1] === "-" ? -offset : offset;
}

function parsePostgresTime(
  value: string,
  withTimezone: boolean,
  allowOffset: boolean,
): PostgresTimeParts | undefined {
  const match = /^(\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(value);
  if (match === null) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3]);
  const zone = match[5];
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  if (!withTimezone && zone !== undefined) return undefined;
  if (withTimezone && (zone === undefined || (!allowOffset && zone !== "Z"))) return undefined;
  const offsetMinutes = zone === undefined ? undefined : parsePostgresTimeZone(zone);
  if (zone !== undefined && offsetMinutes === undefined) return undefined;
  return {
    hour,
    minute,
    second: match[3] ?? "00",
    fraction: match[4] ?? "",
    ...(offsetMinutes === undefined ? {} : { offsetMinutes }),
  };
}

function validTime(value: string, withTimezone: boolean): boolean {
  return parsePostgresTime(value, withTimezone, false) !== undefined;
}

function normalizePostgresClock(parts: PostgresTimeParts): {
  readonly time: string;
  readonly dayOffset: number;
} {
  const shiftedMinutes = parts.hour * 60 + parts.minute - (parts.offsetMinutes ?? 0);
  const dayOffset = Math.floor(shiftedMinutes / (24 * 60));
  const normalizedMinutes = ((shiftedMinutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const hour = Math.floor(normalizedMinutes / 60);
  const minute = normalizedMinutes % 60;
  return {
    time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${parts.second}${parts.fraction}`,
    dayOffset,
  };
}

function formatPostgresDate(parts: PostgresDateParts): string {
  const absoluteYear = parts.year < 0n ? -parts.year : parts.year;
  const digits = absoluteYear.toString().padStart(parts.yearWidth, "0");
  const sign = parts.year < 0n ? "-" : parts.forceSign ? "+" : "";
  return `${sign}${digits}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function shiftPostgresDate(parts: PostgresDateParts, dayOffset: number): PostgresDateParts {
  let { year, month, day } = parts;
  if (dayOffset < 0) {
    day -= 1;
    if (day === 0) {
      month -= 1;
      if (month === 0) {
        year -= 1n;
        month = 12;
      }
      day = postgresDaysInMonth(year, month);
    }
  } else if (dayOffset > 0) {
    day += 1;
    if (day > postgresDaysInMonth(year, month)) {
      day = 1;
      month += 1;
      if (month === 13) {
        year += 1n;
        month = 1;
      }
    }
  }
  return { ...parts, year, month, day };
}

function normalizePostgresTime(value: string, withTimezone: boolean): string | undefined {
  const parts = parsePostgresTime(value, withTimezone, true);
  if (parts === undefined) return undefined;
  if (!withTimezone) return value;
  return `${normalizePostgresClock(parts).time}Z`;
}

function validTimestamp(value: string, withTimezone: boolean): boolean {
  const separator = value.indexOf("T");
  if (separator <= 0) return false;
  const date = parsePostgresDate(value.slice(0, separator));
  return (
    date !== undefined &&
    postgresDateInRange(date, postgresMaximumTimestampIsoYear) &&
    parsePostgresTime(value.slice(separator + 1), withTimezone, false) !== undefined
  );
}

function normalizePostgresTimestamp(value: string, withTimezone: boolean): string | undefined {
  const match = /^(.+?)[T ](.+)$/.exec(value);
  if (match === null) return undefined;
  const dateText = match[1] ?? "";
  const timeText = match[2] ?? "";
  const date = parsePostgresDate(dateText);
  const time = parsePostgresTime(timeText, withTimezone, true);
  if (
    date === undefined ||
    !postgresDateInRange(date, postgresMaximumTimestampIsoYear) ||
    time === undefined
  ) {
    return undefined;
  }
  if (!withTimezone) return `${dateText}T${timeText}`;
  const normalized = normalizePostgresClock(time);
  const normalizedDate = shiftPostgresDate(date, normalized.dayOffset);
  return postgresDateInRange(normalizedDate, postgresMaximumTimestampIsoYear)
    ? `${formatPostgresDate(normalizedDate)}T${normalized.time}Z`
    : undefined;
}

function temporalCodec(
  type: "date" | "time" | "timestamp",
  validateInput: (value: string) => boolean,
  normalizeOutput: (value: string) => string | undefined,
): Pick<RuntimePhysicalType, "application" | "encode" | "decode"> {
  return {
    application: "string",
    encode: (value) =>
      typeof value === "string" && validateInput(value) ? value : invalidValue(type),
    decode: (value) => {
      if (value instanceof Date || typeof value !== "string") return invalidValue(type);
      return normalizeOutput(value) ?? invalidValue(type);
    },
  };
}

function validInterval(value: string): boolean {
  return /^-?P(?=\d|T\d)(?:\d+Y)?(?:\d+M)?(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d{1,6})?S)?)?$/.test(
    value,
  );
}

function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

function validMac(value: string, octets: number): boolean {
  return new RegExp(`^(?:[0-9a-f]{2}:){${octets - 1}}[0-9a-f]{2}$`).test(value);
}

function numericCodec(
  options: Readonly<Record<string, unknown>> | undefined,
): Pick<RuntimePhysicalType, "application" | "encode" | "decode"> {
  const valid = (value: string): boolean => {
    if (value === "NaN" || value === "Infinity" || value === "-Infinity") return true;
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return false;
    const precision = options?.precision;
    if (typeof precision !== "number") return true;
    const scale = typeof options?.scale === "number" ? options.scale : 0;
    const unsigned = value.startsWith("-") ? value.slice(1) : value;
    const [whole = "0"] = unsigned.split(".");
    return whole.replace(/^0+/, "").length <= precision - scale;
  };
  return stringCodec("numeric", valid);
}

function pointCodec(
  type: "point" | "line",
): Pick<RuntimePhysicalType, "application" | "encode" | "decode"> {
  const keys = type === "point" ? (["x", "y"] as const) : (["a", "b", "c"] as const);
  const convert = (value: unknown): JsonValue => {
    if (!isRecordContainer(value) || Reflect.ownKeys(value).length !== keys.length) {
      return invalidValue(type);
    }
    const entries: [string, number][] = [];
    for (const key of keys) {
      const part = Reflect.get(value, key);
      if (typeof part !== "number" || !Number.isFinite(part)) return invalidValue(type);
      entries.push([key, Object.is(part, -0) ? 0 : part]);
    }
    return Object.freeze(Object.fromEntries(entries)) as JsonValue;
  };
  return { application: type, encode: convert, decode: convert };
}

function jsonCodec(
  type: "json" | "jsonb",
): Pick<RuntimePhysicalType, "application" | "encode" | "decode"> {
  const convert = (value: unknown): JsonValue => (isJsonValue(value) ? value : invalidValue(type));
  return { application: "json", encode: convert, decode: convert };
}

export function directCodec(
  type: PostgresDirectTypeName,
  options?: Readonly<Record<string, unknown>>,
): Pick<RuntimePhysicalType, "application" | "encode" | "decode"> {
  switch (type) {
    case "smallint":
      return {
        application: "integer",
        encode: (value) => boundedInteger(value, type, -32_768, 32_767),
        decode: (value) => boundedInteger(value, type, -32_768, 32_767),
      };
    case "integer":
      return {
        application: "integer",
        encode: (value) => boundedInteger(value, type, -2_147_483_648, 2_147_483_647),
        decode: (value) => boundedInteger(value, type, -2_147_483_648, 2_147_483_647),
      };
    case "bigint":
      return stringCodec(type, (value) =>
        isExactIntegerText(value, -9_223_372_036_854_775_808n, 9_223_372_036_854_775_807n),
      );
    case "numeric":
      return numericCodec(options);
    case "real":
    case "double-precision":
      return {
        application: "number",
        encode: (value) => finiteNumber(value, type),
        decode: (value) => {
          const number = finiteNumber(value, type);
          return Object.is(number, -0) ? 0 : number;
        },
      };
    case "boolean":
      return {
        application: "boolean",
        encode: (value) => (typeof value === "boolean" ? value : invalidValue(type)),
        decode: (value) => (typeof value === "boolean" ? value : invalidValue(type)),
      };
    case "char": {
      const maximum = options?.length;
      return stringCodec(
        type,
        (value) => !value.endsWith(" ") && fitsCharacterLength(value, maximum),
        (value) => value.replace(/ +$/, ""),
      );
    }
    case "varchar": {
      const maximum = options?.length;
      return stringCodec(type, (value) => fitsCharacterLength(value, maximum));
    }
    case "text":
      return stringCodec(type);
    case "uuid":
      return stringCodec(type, validUuid);
    case "json":
    case "jsonb":
      return jsonCodec(type);
    case "bytea":
      return {
        application: "string",
        encode: (value) => (typeof value === "string" ? decodeBase64(value) : invalidValue(type)),
        decode: (value) => (value instanceof Uint8Array ? encodeBase64(value) : invalidValue(type)),
      };
    case "date":
      return temporalCodec(type, validDate, (value) => (validDate(value) ? value : undefined));
    case "time": {
      const withTimezone = options?.withTimezone === true;
      return temporalCodec(
        type,
        (value) => validTime(value, withTimezone),
        (value) => normalizePostgresTime(value, withTimezone),
      );
    }
    case "timestamp": {
      const withTimezone = options?.withTimezone === true;
      return temporalCodec(
        type,
        (value) => validTimestamp(value, withTimezone),
        (value) => normalizePostgresTimestamp(value, withTimezone),
      );
    }
    case "interval":
      return stringCodec(type, validInterval);
    case "inet":
    case "cidr":
      return stringCodec(type, (value) => value.length > 0 && !value.includes(" "));
    case "macaddr":
      return stringCodec(type, (value) => validMac(value, 6));
    case "macaddr8":
      return stringCodec(type, (value) => validMac(value, 8));
    case "point":
    case "line":
      return pointCodec(type);
  }
}

function dimensions(value: readonly unknown[], depth = 0): readonly number[] | undefined {
  if (depth >= 6) return undefined;
  const childArrays = value.filter(Array.isArray);
  if (childArrays.length === 0) return Object.freeze([value.length]);
  if (childArrays.length !== value.length) return undefined;
  const first = dimensions(childArrays[0] ?? [], depth + 1);
  if (first === undefined) return undefined;
  for (const child of childArrays.slice(1)) {
    const shape = dimensions(child, depth + 1);
    if (
      shape === undefined ||
      shape.length !== first.length ||
      shape.some((size, index) => size !== first[index])
    ) {
      return undefined;
    }
  }
  return Object.freeze([value.length, ...first]);
}

function isPostgresArrayDriverValue(value: unknown): value is PostgresArrayDriverValue {
  if (!isRecordContainer(value)) return false;
  const values = Reflect.get(value, "values");
  const lowerBounds = Reflect.get(value, "lowerBounds");
  return (
    Array.isArray(values) &&
    Array.isArray(lowerBounds) &&
    lowerBounds.every((bound) => typeof bound === "number")
  );
}

export function arrayCodec(
  element: RuntimePhysicalType,
): Pick<RuntimePhysicalType, "application" | "encode" | "decode"> {
  const readInput = (value: unknown, checkBounds: boolean): readonly unknown[] => {
    const driverValue = checkBounds && isPostgresArrayDriverValue(value) ? value : undefined;
    const input = driverValue === undefined ? value : driverValue.values;
    if (!Array.isArray(input)) return invalidValue("array");
    const shape = dimensions(input);
    if (shape === undefined || shape.length > 6) return invalidValue("array");
    if (
      driverValue !== undefined &&
      (driverValue.lowerBounds.length !== shape.length ||
        driverValue.lowerBounds.some((bound) => bound !== 1))
    ) {
      return invalidValue("array lower bound");
    }
    return input;
  };
  const encodeItems = (items: readonly unknown[]): readonly PostgresEncodedValue[] =>
    Object.freeze(items.map((item) => (item === null ? null : element.encode(item))));
  const decodeItems = (items: readonly unknown[]): readonly JsonValue[] =>
    Object.freeze(items.map((item) => (item === null ? null : element.decode(item))));
  return {
    application: "array",
    encode: (value) => encodeItems(readInput(value, false)),
    decode: (value) => decodeItems(readInput(value, true)),
  };
}
