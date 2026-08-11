import { expect, it } from "vitest";

import { validateSqlDefinitionStatement } from "../../src/sql/definition-statement.js";
import { sqlOpaqueFormatSymbol } from "../../src/sql/opaque-format.js";
import type { SqlDefinitionIssue } from "../../src/sql/record.js";
import {
  hasSqlStatementStructure,
  sql,
  type SqlStatementFragment,
} from "../../src/sql/statement.js";

it("recognizes identifier and nonempty raw Statement structure", () => {
  const emptyRaw: SqlStatementFragment = { kind: "raw", text: "" };
  const parameter: SqlStatementFragment = { kind: "parameter", value: 1 };

  expect(hasSqlStatementStructure([])).toBe(false);
  expect(hasSqlStatementStructure([emptyRaw])).toBe(false);
  expect(hasSqlStatementStructure([parameter, emptyRaw])).toBe(false);
  expect(hasSqlStatementStructure([{ kind: "raw", text: "CURRENT_TIMESTAMP" }])).toBe(true);
  expect(hasSqlStatementStructure([{ kind: "identifier", name: "created_at" }])).toBe(true);
});

it("rejects empty definition Statements with an exact issue", () => {
  const path = ["records", "jobs", "fields", "createdAt", "column", "generated"] as const;

  for (const statement of [sql``, sql.raw("")]) {
    const issues: SqlDefinitionIssue[] = [];
    expect(
      validateSqlDefinitionStatement(statement, path, issues, "Generated column expression"),
    ).toBeUndefined();
    expect(issues).toEqual([
      {
        code: "invalid-column-default",
        path,
        message: "Generated column expression requires nonempty SQL structure",
      },
    ]);
  }
});

it("accepts parameter-free raw, identifier, and compatible package-copy Statements", () => {
  const path = ["records", "jobs", "fields", "createdAt", "column", "generated"] as const;
  const original = sql.raw("CURRENT_TIMESTAMP");
  const originalFormat = Reflect.get(original, sqlOpaqueFormatSymbol) as Readonly<
    Record<string, unknown>
  >;
  const originalFragments = Reflect.get(originalFormat, "fragments") as readonly object[];
  const copiedFragments = Object.freeze(
    originalFragments.map((fragment) => Object.freeze({ ...fragment })),
  );
  const compatibleCopy = Object.freeze({
    [sqlOpaqueFormatSymbol]: Object.freeze({
      ...originalFormat,
      fragments: copiedFragments,
    }),
  });

  for (const statement of [
    sql.raw("CURRENT_TIMESTAMP"),
    sql.identifier("created_at"),
    compatibleCopy,
  ]) {
    const issues: SqlDefinitionIssue[] = [];
    expect(
      validateSqlDefinitionStatement(statement, path, issues, "Generated column expression"),
    ).toBe(statement);
    expect(issues).toEqual([]);
  }
});

it("rejects definition Statement parameters with an exact requested issue", () => {
  const path = ["records", "jobs", "fields", "createdAt", "column", "generated"] as const;
  const issues: SqlDefinitionIssue[] = [];
  const statement = sql`CURRENT_TIMESTAMP + ${1}`;

  expect(
    validateSqlDefinitionStatement(
      statement,
      path,
      issues,
      "Generated column expression",
      "invalid-database-options",
    ),
  ).toBeUndefined();
  expect(issues).toEqual([
    {
      code: "invalid-database-options",
      path,
      message: "Generated column expression must not contain SQL parameters",
    },
  ]);
});

it("rejects incompatible values with an exact issue", () => {
  const path = ["records", "jobs", "fields", "createdAt", "column", "generated"] as const;
  const issues: SqlDefinitionIssue[] = [];

  expect(
    validateSqlDefinitionStatement(
      Object.freeze({ kind: "statement" }),
      path,
      issues,
      "Generated column expression",
    ),
  ).toBeUndefined();
  expect(issues).toEqual([
    {
      code: "invalid-column-default",
      path,
      message: "Generated column expression requires a compatible SQL Statement",
    },
  ]);
});
