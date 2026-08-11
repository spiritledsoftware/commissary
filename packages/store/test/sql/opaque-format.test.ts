import { expect, it } from "vitest";

import { defineSqlMetadataFormat, sqlOpaqueFormatSymbol } from "../../src/sql/opaque-format.js";

const testMetadataFormatName = "commissary-test-metadata@1";
const testMetadata = defineSqlMetadataFormat({
  format: testMetadataFormatName,
  kinds: new Set(["table", "column"] as const),
  owner: "Test SQL metadata",
});

it("creates readable frozen metadata values", () => {
  const source = { name: "jobs", options: { temporary: false } };
  const value = testMetadata.create("table", source);

  expect(testMetadata.read(value)).toBe("table");
  expect(value).not.toBe(source);
  expect(value.options).not.toBe(source.options);
  expect(Object.isFrozen(value)).toBe(true);
  expect(Object.isFrozen(value.options)).toBe(true);

  source.name = "changed_jobs";
  source.options.temporary = true;
  expect(value).toMatchObject({ name: "jobs", options: { temporary: false } });
});

it("reads a compatible package-copy representation", () => {
  const original = testMetadata.create("column", { name: "job_id" });
  const originalFormat = Reflect.get(original, sqlOpaqueFormatSymbol) as Readonly<
    Record<PropertyKey, unknown>
  >;
  const compatibleCopy = Object.freeze({
    ...original,
    [sqlOpaqueFormatSymbol]: Object.freeze({ ...originalFormat }),
  });

  expect(compatibleCopy).not.toBe(original);
  expect(testMetadata.read(compatibleCopy)).toBe("column");
});

it("rejects caller lookalikes, unknown kinds, and mutable opaque representations", () => {
  const lookalike = Object.freeze({
    name: "jobs",
    format: testMetadataFormatName,
    kind: "table",
  });
  expect(testMetadata.read(lookalike)).toBeUndefined();

  const unknownKind = Object.freeze({
    [sqlOpaqueFormatSymbol]: Object.freeze({
      format: testMetadataFormatName,
      kind: "index",
    }),
  });
  expect(testMetadata.read(unknownKind)).toBeUndefined();

  const mutableValue = {
    [sqlOpaqueFormatSymbol]: Object.freeze({
      format: testMetadataFormatName,
      kind: "table",
    }),
  };
  expect(testMetadata.read(mutableValue)).toBeUndefined();

  const mutableFormat = Object.freeze({
    [sqlOpaqueFormatSymbol]: {
      format: testMetadataFormatName,
      kind: "table",
    },
  });
  expect(testMetadata.read(mutableFormat)).toBeUndefined();
});

it("does not read metadata owned by another format", () => {
  const otherMetadata = defineSqlMetadataFormat({
    format: "commissary-other-test-metadata@1",
    kinds: new Set(["table"] as const),
    owner: "Other SQL metadata",
  });

  expect(testMetadata.read(otherMetadata.create("table", { name: "jobs" }))).toBeUndefined();
  expect(otherMetadata.read(testMetadata.create("table", { name: "jobs" }))).toBeUndefined();
});
