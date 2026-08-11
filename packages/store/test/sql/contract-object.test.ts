import { expect, it } from "vitest";

import {
  hasOnlySqlContractKeys,
  isSqlContractObject,
  snapshotSqlContractValue,
} from "../../src/sql/contract-object.js";

it("recognizes non-null non-array SQL contract objects", () => {
  expect(isSqlContractObject({})).toBe(true);
  expect(isSqlContractObject(Object.create(null))).toBe(true);

  for (const value of [null, undefined, [], "object", 1, true, () => undefined]) {
    expect(isSqlContractObject(value)).toBe(false);
  }
});

it("validates every own key as an allowed string key", () => {
  const allowedKeys = new Set(["format", "kind"]);
  const inheritedUnknownKey = Object.assign(
    Object.create({ unexpected: true }) as Record<PropertyKey, unknown>,
    { format: "test@1", kind: "value" },
  );
  expect(hasOnlySqlContractKeys(inheritedUnknownKey, allowedKeys)).toBe(true);

  expect(
    hasOnlySqlContractKeys({ format: "test@1", kind: "value", unexpected: true }, allowedKeys),
  ).toBe(false);

  const nonEnumerableUnknownKey: Record<PropertyKey, unknown> = {
    format: "test@1",
    kind: "value",
  };
  Object.defineProperty(nonEnumerableUnknownKey, "unexpected", { value: true });
  expect(hasOnlySqlContractKeys(nonEnumerableUnknownKey, allowedKeys)).toBe(false);

  const privateKey = Symbol("private");
  expect(
    hasOnlySqlContractKeys({ format: "test@1", kind: "value", [privateKey]: true }, allowedKeys),
  ).toBe(false);
});

it("recursively copies and freezes caller containers while retaining scalar and function values", () => {
  const retainedScalar = Symbol("retained scalar");
  const retainedFunction = () => "retained function";
  const nested = { status: "queued" };
  const item = { priority: 1 };
  const items = [item];
  const source = {
    nested,
    items,
    retainedScalar,
    retainedFunction,
  };

  const snapshot = snapshotSqlContractValue(source) as typeof source;

  expect(snapshot).not.toBe(source);
  expect(snapshot.nested).not.toBe(nested);
  expect(snapshot.items).not.toBe(items);
  expect(snapshot.items[0]).not.toBe(item);
  expect(snapshot.retainedScalar).toBe(retainedScalar);
  expect(snapshot.retainedFunction).toBe(retainedFunction);
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot.nested)).toBe(true);
  expect(Object.isFrozen(snapshot.items)).toBe(true);
  expect(Object.isFrozen(snapshot.items[0])).toBe(true);

  nested.status = "running";
  item.priority = 9;
  items.push({ priority: 2 });

  expect(snapshot.nested).toEqual({ status: "queued" });
  expect(snapshot.items).toEqual([{ priority: 1 }]);
});
