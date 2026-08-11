import { expect, it } from "vitest";

import { hasOnlySqlContractKeys } from "../../src/sql/contract-object.js";
import { sqlOpaqueValueFormat } from "../../src/sql/opaque-format.js";
import {
  isSqlCustomEncodedValue,
  readSqlPortableTypeName,
  sqlColumnTypeFormatKeys,
  type SqlColumnTypeFormat,
} from "../../src/sql/record.js";

function columnTypeFormat(
  dialect: SqlColumnTypeFormat["dialect"],
  type: string,
): SqlColumnTypeFormat {
  return {
    format: sqlOpaqueValueFormat,
    kind: "column-type",
    dialect,
    type,
  };
}

it("recognizes every and only portable SQL type name", () => {
  const portableTypeNames = ["text", "number", "integer", "boolean", "json"] as const;
  for (const type of portableTypeNames) {
    expect(readSqlPortableTypeName(columnTypeFormat("portable", type))).toBe(type);
  }

  expect(readSqlPortableTypeName(columnTypeFormat("portable", "binary"))).toBeUndefined();
  expect(readSqlPortableTypeName(columnTypeFormat("postgres", "text"))).toBeUndefined();
  expect(readSqlPortableTypeName(columnTypeFormat("mysql", "integer"))).toBeUndefined();
  expect(readSqlPortableTypeName(columnTypeFormat("sqlite", "json"))).toBeUndefined();
});

it("defines the exact own string keys accepted for SQL column-type formats", () => {
  const identity = Symbol("test column type");
  const format = {
    format: sqlOpaqueValueFormat,
    kind: "column-type",
    dialect: "portable",
    type: "text",
    identity,
    options: Object.freeze({ length: 32 }),
  } as const;

  expect(hasOnlySqlContractKeys(format, sqlColumnTypeFormatKeys)).toBe(true);
  expect(hasOnlySqlContractKeys({ ...format, unexpected: true }, sqlColumnTypeFormatKeys)).toBe(
    false,
  );
  expect(
    hasOnlySqlContractKeys({ ...format, [Symbol("private")]: true }, sqlColumnTypeFormatKeys),
  ).toBe(false);
});

it("accepts only driver-independent custom encoded scalar and byte values", () => {
  const accepted = [
    "",
    "encoded",
    false,
    true,
    -0,
    -1.5,
    Number.MAX_VALUE,
    new Uint8Array(),
    Uint8Array.from([0, 127, 255]),
  ];
  for (const value of accepted) {
    expect(isSqlCustomEncodedValue(value)).toBe(true);
  }

  const rejected = [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    null,
    undefined,
    1n,
    Symbol("encoded"),
    {},
    [],
    new Uint16Array([1]),
    () => "encoded",
  ];
  for (const value of rejected) {
    expect(isSqlCustomEncodedValue(value)).toBe(false);
  }
});
