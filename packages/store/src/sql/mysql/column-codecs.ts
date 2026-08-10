import { isSqlRecordContainer as isRecordContainer } from "../record-catalog-resolver.js";
import { isJsonValue } from "../../json.js";
import type {
  MysqlDirectTypeName,
  MysqlResolvedDirectTypeOptions,
  RuntimePhysicalType,
} from "./resolution-types.js";

export function invalidValue(type: string): never {
  throw new TypeError(`MySQL ${type} codec received an invalid value`);
}

export function boundedInteger(
  value: unknown,
  type: string,
  minimum: number,
  maximum: number,
): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : invalidValue(type);
}

function finiteNumber(value: unknown, type: string, unsigned = false): number {
  return typeof value === "number" && Number.isFinite(value) && (!unsigned || value >= 0)
    ? value
    : invalidValue(type);
}

function isCanonicalIntegerText(value: unknown, minimum: bigint, maximum: bigint): value is string {
  if (typeof value !== "string" || !/^-?(?:0|[1-9][0-9]*)$/.test(value) || value === "-0") {
    return false;
  }
  try {
    const integer = BigInt(value);
    return integer >= minimum && integer <= maximum;
  } catch {
    return false;
  }
}

export function stringCodec(
  type: string,
  validate: (value: string) => boolean = () => true,
  normalize: (value: string) => string | undefined = (value) => value,
): Pick<RuntimePhysicalType, "application" | "encode" | "decode"> {
  return {
    application: "string",
    encode: (value) => (typeof value === "string" && validate(value) ? value : invalidValue(type)),
    decode: (value) => {
      if (typeof value !== "string") return invalidValue(type);
      const normalized = normalize(value);
      return normalized !== undefined && validate(normalized) ? normalized : invalidValue(type);
    },
  };
}

export function jsonCodec(
  type: string,
): Pick<RuntimePhysicalType, "application" | "encode" | "decode"> {
  return {
    application: "json",
    encode: (value) => (isJsonValue(value) ? value : invalidValue(type)),
    decode: (value) => (isJsonValue(value) ? value : invalidValue(type)),
  };
}

const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeBase64(value: string): Uint8Array {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return invalidValue("binary");
  }
  const output = new Uint8Array(
    (value.length / 4) * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0),
  );
  let outputIndex = 0;
  for (let index = 0; index < value.length; index += 4) {
    const a = base64Alphabet.indexOf(value[index] ?? "");
    const b = base64Alphabet.indexOf(value[index + 1] ?? "");
    const c = value[index + 2] === "=" ? 0 : base64Alphabet.indexOf(value[index + 2] ?? "");
    const d = value[index + 3] === "=" ? 0 : base64Alphabet.indexOf(value[index + 3] ?? "");
    if (a < 0 || b < 0 || c < 0 || d < 0) return invalidValue("binary");
    const bits = (a << 18) | (b << 12) | (c << 6) | d;
    if (outputIndex < output.length) output[outputIndex++] = (bits >> 16) & 255;
    if (outputIndex < output.length) output[outputIndex++] = (bits >> 8) & 255;
    if (outputIndex < output.length) output[outputIndex++] = bits & 255;
  }
  if (encodeBase64(output) !== value) return invalidValue("binary");
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

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function validCalendarDate(year: number, month: number, day: number): boolean {
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= (days[month - 1] ?? 0);
}

interface MysqlDateTimeParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly fraction: string;
}

function parseDate(value: string): readonly [number, number, number] | undefined {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(value);
  if (match === null) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return year >= 1000 && year <= 9999 && validCalendarDate(year, month, day)
    ? [year, month, day]
    : undefined;
}

function parseDateTime(value: string, withUtc: boolean): MysqlDateTimeParts | undefined {
  const suffix = withUtc ? "Z" : "";
  const pattern = withUtc
    ? /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,6}))?Z$/
    : /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,6}))?$/;
  const match = pattern.exec(value);
  if (match === null || (withUtc && !value.endsWith(suffix))) return undefined;
  const parts: MysqlDateTimeParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6]),
    fraction: match[7] ?? "",
  };
  return parts.year >= 1000 &&
    parts.year <= 9999 &&
    validCalendarDate(parts.year, parts.month, parts.day) &&
    parts.hour <= 23 &&
    parts.minute <= 59 &&
    parts.second <= 59
    ? parts
    : undefined;
}

function timestampInRange(parts: MysqlDateTimeParts): boolean {
  const second =
    `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}` +
    `T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}:${String(parts.second).padStart(2, "0")}`;
  return second >= "1970-01-01T00:00:01" && second <= "2038-01-19T03:14:07";
}

function normalizeFraction(fraction: string, fsp: number): string | undefined {
  if (fraction.length > fsp && /[1-9]/.test(fraction.slice(fsp))) return undefined;
  return fsp === 0 ? "" : `.${fraction.slice(0, fsp).padEnd(fsp, "0")}`;
}

function normalizeDateTime(value: string, withUtc: boolean, fsp: number): string | undefined {
  const parts = parseDateTime(value, withUtc);
  if (parts === undefined || (withUtc && !timestampInRange(parts))) return undefined;
  const fraction = normalizeFraction(parts.fraction, fsp);
  if (fraction === undefined) return undefined;
  const base = value.slice(0, 19);
  return `${base}${fraction}${withUtc ? "Z" : ""}`;
}

interface MysqlTimeParts {
  readonly negative: boolean;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly fraction: string;
}

function parseTime(value: string): MysqlTimeParts | undefined {
  const match = /^(-)?([0-9]{3}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,6}))?$/.exec(value);
  if (match === null) return undefined;
  const parts: MysqlTimeParts = {
    negative: match[1] === "-",
    hour: Number(match[2]),
    minute: Number(match[3]),
    second: Number(match[4]),
    fraction: match[5] ?? "",
  };
  if (
    parts.hour > 838 ||
    parts.minute > 59 ||
    parts.second > 59 ||
    (parts.hour === 838 && (parts.minute > 59 || parts.second > 59)) ||
    (parts.negative &&
      parts.hour === 0 &&
      parts.minute === 0 &&
      parts.second === 0 &&
      !/[1-9]/.test(parts.fraction))
  ) {
    return undefined;
  }
  return parts;
}

function normalizeTime(value: string, fsp: number): string | undefined {
  const parts = parseTime(value);
  if (parts === undefined) return undefined;
  const fraction = normalizeFraction(parts.fraction, fsp);
  if (fraction === undefined) return undefined;
  return `${parts.negative ? "-" : ""}${String(parts.hour).padStart(3, "0")}:${String(parts.minute).padStart(2, "0")}:${String(parts.second).padStart(2, "0")}${fraction}`;
}

function optionNumber(
  options: Readonly<MysqlResolvedDirectTypeOptions> | undefined,
  key: string,
): number | undefined {
  const value = isRecordContainer(options) ? Reflect.get(options, key) : undefined;
  return typeof value === "number" ? value : undefined;
}

function temporalCodec(
  type: "date" | "datetime" | "time" | "timestamp",
  options?: Readonly<MysqlResolvedDirectTypeOptions>,
): Pick<RuntimePhysicalType, "application" | "encode" | "decode"> {
  if (type === "date") {
    return stringCodec(type, (value) => parseDate(value) !== undefined);
  }
  const fsp = optionNumber(options, "fsp") ?? 0;
  const validate =
    type === "time"
      ? (value: string): boolean => parseTime(value) !== undefined
      : type === "timestamp"
        ? (value: string): boolean => {
            const parts = parseDateTime(value, true);
            return parts !== undefined && timestampInRange(parts);
          }
        : (value: string): boolean => parseDateTime(value, false) !== undefined;
  const normalize =
    type === "time"
      ? (value: string): string | undefined => normalizeTime(value, fsp)
      : type === "timestamp"
        ? (value: string): string | undefined => normalizeDateTime(value, true, fsp)
        : (value: string): string | undefined => normalizeDateTime(value, false, fsp);
  return stringCodec(type, validate, normalize);
}

function binaryCodec(
  type: "binary" | "varbinary",
  length: number,
): Pick<RuntimePhysicalType, "application" | "encode" | "decode"> {
  return {
    application: "string",
    encode: (value) => {
      if (typeof value !== "string") return invalidValue(type);
      const decoded = decodeBase64(value);
      return decoded.length <= length ? decoded : invalidValue(type);
    },
    decode: (value) => {
      if (!(value instanceof Uint8Array) || value.length > length) return invalidValue(type);
      return encodeBase64(value);
    },
  };
}

interface ParsedDecimal {
  readonly negative: boolean;
  readonly integer: string;
  readonly fraction: string;
}

function parseDecimal(value: unknown): ParsedDecimal | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(-)?([0-9]+)(?:\.([0-9]+))?$/.exec(value);
  if (match === null) return undefined;
  return {
    negative: match[1] === "-",
    integer: match[2] ?? "",
    fraction: match[3] ?? "",
  };
}

function decimalFits(
  value: unknown,
  precision: number,
  scale: number,
  unsigned: boolean,
): value is string {
  const parts = parseDecimal(value);
  if (parts === undefined || (unsigned && parts.negative)) return false;
  const significantInteger = parts.integer.replace(/^0+/, "");
  return significantInteger.length <= precision - scale;
}

function normalizeDecimal(
  value: unknown,
  precision: number,
  scale: number,
  unsigned: boolean,
): string {
  if (!decimalFits(value, precision, scale, unsigned)) return invalidValue("decimal");
  const parts = parseDecimal(value);
  if (parts === undefined || parts.fraction.length !== scale) return invalidValue("decimal");
  const integer = parts.integer.replace(/^0+(?=[0-9])/, "");
  const isZero = /^0+$/.test(integer) && (scale === 0 || /^0+$/.test(parts.fraction));
  return `${parts.negative && !isZero ? "-" : ""}${integer}${scale === 0 ? "" : `.${parts.fraction}`}`;
}

function decimalCodec(
  options?: Readonly<MysqlResolvedDirectTypeOptions>,
): Pick<RuntimePhysicalType, "application" | "encode" | "decode"> {
  const precision = optionNumber(options, "precision") ?? 10;
  const scale = optionNumber(options, "scale") ?? 0;
  const unsigned = isRecordContainer(options) && Reflect.get(options, "unsigned") === true;
  return {
    application: "string",
    encode: (value) =>
      decimalFits(value, precision, scale, unsigned) ? value : invalidValue("decimal"),
    decode: (value) => normalizeDecimal(value, precision, scale, unsigned),
  };
}

export function booleanCodec(): Pick<RuntimePhysicalType, "application" | "encode" | "decode"> {
  return {
    application: "boolean",
    encode: (value) => (typeof value === "boolean" ? Number(value) : invalidValue("boolean")),
    decode: (value) =>
      typeof value === "boolean"
        ? value
        : value === 0
          ? false
          : value === 1
            ? true
            : invalidValue("boolean"),
  };
}

function integerCodec(
  type: "tinyint" | "smallint" | "mediumint" | "int",
  unsigned: boolean,
): Pick<RuntimePhysicalType, "application" | "encode" | "decode"> {
  const ranges = {
    tinyint: [-128, 127, 255],
    smallint: [-32_768, 32_767, 65_535],
    mediumint: [-8_388_608, 8_388_607, 16_777_215],
    int: [-2_147_483_648, 2_147_483_647, 4_294_967_295],
  } as const;
  const [signedMinimum, signedMaximum, unsignedMaximum] = ranges[type];
  const minimum = unsigned ? 0 : signedMinimum;
  const maximum = unsigned ? unsignedMaximum : signedMaximum;
  return {
    application: "integer",
    encode: (value) => boundedInteger(value, type, minimum, maximum),
    decode: (value) => boundedInteger(value, type, minimum, maximum),
  };
}

function bigintCodec(
  type: "bigint" | "serial",
  unsigned: boolean,
): Pick<RuntimePhysicalType, "application" | "encode" | "decode"> {
  const minimum = unsigned ? 0n : -9_223_372_036_854_775_808n;
  const maximum = unsigned ? 18_446_744_073_709_551_615n : 9_223_372_036_854_775_807n;
  return stringCodec(
    type,
    (value) =>
      isCanonicalIntegerText(value, minimum, maximum) && (type !== "serial" || value !== "0"),
  );
}

export function directCodec(
  type: MysqlDirectTypeName,
  options?: Readonly<MysqlResolvedDirectTypeOptions>,
): Pick<RuntimePhysicalType, "application" | "encode" | "decode"> {
  const unsigned = isRecordContainer(options) && Reflect.get(options, "unsigned") === true;
  switch (type) {
    case "tinyint":
    case "smallint":
    case "mediumint":
    case "int":
      return integerCodec(type, unsigned);
    case "bigint":
      return bigintCodec(type, unsigned);
    case "serial":
      return bigintCodec(type, true);
    case "decimal":
      return decimalCodec(options);
    case "float":
    case "double":
    case "real":
      return {
        application: "number",
        encode: (value) => finiteNumber(value, type, unsigned),
        decode: (value) => {
          const number = finiteNumber(value, type, unsigned);
          return Object.is(number, -0) ? 0 : number;
        },
      };
    case "boolean":
      return booleanCodec();
    case "char": {
      const length = optionNumber(options, "length") ?? 1;
      const validLength = (value: string): boolean => Array.from(value).length <= length;
      return {
        application: "string",
        encode: (value) =>
          typeof value === "string" && !value.endsWith(" ") && validLength(value)
            ? value
            : invalidValue(type),
        decode: (value) =>
          typeof value === "string" && validLength(value)
            ? value.replace(/ +$/, "")
            : invalidValue(type),
      };
    }
    case "varchar": {
      const length = optionNumber(options, "length") ?? 0;
      return stringCodec(type, (value) => Array.from(value).length <= length);
    }
    case "binary": {
      const length = optionNumber(options, "length") ?? 1;
      return binaryCodec(type, length);
    }
    case "varbinary": {
      const length = optionNumber(options, "length") ?? 0;
      return binaryCodec(type, length);
    }
    case "text":
    case "tinytext":
    case "mediumtext":
    case "longtext":
      return stringCodec(type);
    case "json":
      return jsonCodec(type);
    case "date":
    case "datetime":
    case "time":
    case "timestamp":
      return temporalCodec(type, options);
    case "year":
      return {
        application: "integer",
        encode: (value) => boundedInteger(value, type, 1901, 2155),
        decode: (value) => boundedInteger(value, type, 1901, 2155),
      };
  }
}
