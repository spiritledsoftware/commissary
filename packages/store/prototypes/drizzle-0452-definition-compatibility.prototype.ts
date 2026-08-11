/*
 * Published-artifact compatibility prototype for issue #83.
 *
 * This file intentionally imports the exact development dependencies named in
 * docs/specs/drizzle-store.md. It verifies the public behavior that constrains
 * the connection-free Drizzle definition contract.
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";
import { getTableColumns, sql } from "drizzle-orm";
import {
  getTableConfig as getPgTableConfig,
  integer,
  pgEnum,
  pgSchema,
  pgTable,
  text,
  type PgEnum,
} from "drizzle-orm/pg-core";
import {
  customType as mysqlCustomType,
  datetime,
  mysqlTable,
  timestamp,
} from "drizzle-orm/mysql-core";
import {
  createInsertSchema as createValibotInsertSchema,
  createSelectSchema as createValibotSelectSchema,
  createUpdateSchema as createValibotUpdateSchema,
} from "drizzle-valibot";
import {
  createInsertSchema as createZodInsertSchema,
  createSelectSchema as createZodSelectSchema,
  createUpdateSchema as createZodUpdateSchema,
} from "drizzle-zod";

import { pg as commissaryPg, type PostgresEnum } from "../src/sql/postgres/index.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function sortedKeys(value: Readonly<Record<string, unknown>>): readonly string[] {
  return Object.keys(value).sort();
}

function assertKeys(
  actual: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  message: string,
): void {
  assert(
    JSON.stringify(sortedKeys(actual)) === JSON.stringify([...expected].sort()),
    `${message}: expected ${expected.join(", ")}; received ${Object.keys(actual).join(", ")}`,
  );
}

const jobStatusEnum = pgEnum("job_status", ["pending", "done"]);
const qualifiedJobStatusEnum = pgSchema("jobs").enum("job_status", ["pending", "done"]);

const jobs = pgTable("jobs", {
  id: integer("id").generatedAlwaysAsIdentity(),
  suppliedId: integer("supplied_id").generatedByDefaultAsIdentity(),
  computedLabel: text("computed_label").generatedAlwaysAs(sql`upper('generated')`),
  status: jobStatusEnum("status").notNull(),
  qualifiedStatus: qualifiedJobStatusEnum("qualified_status").notNull(),
  title: text("title").notNull(),
});

const zodSelect = createZodSelectSchema(jobs);
const zodInsert = createZodInsertSchema(jobs);
const zodUpdate = createZodUpdateSchema(jobs);
const valibotSelect = createValibotSelectSchema(jobs);
const valibotInsert = createValibotInsertSchema(jobs);
const valibotUpdate = createValibotUpdateSchema(jobs);

for (const [family, selectShape, insertShape, updateShape] of [
  ["zod", zodSelect.shape, zodInsert.shape, zodUpdate.shape],
  ["valibot", valibotSelect.entries, valibotInsert.entries, valibotUpdate.entries],
] as const) {
  assertKeys(
    selectShape,
    ["id", "suppliedId", "computedLabel", "status", "qualifiedStatus", "title"],
    `${family} select keys`,
  );
  assertKeys(
    insertShape,
    ["suppliedId", "status", "qualifiedStatus", "title"],
    `${family} insert keys`,
  );
  assertKeys(
    updateShape,
    ["suppliedId", "status", "qualifiedStatus", "title"],
    `${family} update keys`,
  );
}

// Drizzle Valibot 0.4.2 omits this runtime entry from its declared select type.
// @ts-expect-error The compatibility layer restores this field from the validated table type.
void valibotSelect.entries.id;
assert(
  "id" in valibotSelect.entries,
  "Valibot select must contain the generated identity at runtime",
);

const omittedWriteSchema = {
  "~standard": {
    version: 1,
    vendor: "@commissary/drizzle",
    validate(value: unknown) {
      return value === undefined
        ? { value: undefined }
        : { issues: [{ message: "Generated field must be omitted" }] };
    },
  },
} as const satisfies StandardSchemaV1<undefined, undefined>;

assert(
  "value" in omittedWriteSchema["~standard"].validate(undefined),
  "The package omission schema must accept undefined",
);
assert(
  "issues" in omittedWriteSchema["~standard"].validate(1),
  "The package omission schema must reject defined values",
);

function postgresEnumSchemaKey<const Values extends [string, ...string[]]>(
  enumValue: PgEnum<Values>,
): string {
  return enumValue.schema === undefined
    ? enumValue.enumName
    : `${enumValue.schema}.${enumValue.enumName}`;
}

const suppliedPostgresEnums = {
  job_status: jobStatusEnum,
  "jobs.job_status": qualifiedJobStatusEnum,
};

const referencedPostgresEnums = new Set(
  Object.values(getTableColumns(jobs)).flatMap((column) => {
    const enumValue = Reflect.get(column, "enum");
    return typeof enumValue === "function" ? [enumValue] : [];
  }),
);

for (const [key, enumValue] of Object.entries(suppliedPostgresEnums)) {
  assert(key === postgresEnumSchemaKey(enumValue), `PostgreSQL enum map key ${key} is invalid`);
  assert(referencedPostgresEnums.has(enumValue), `PostgreSQL enum map key ${key} is unreferenced`);
}
assert(
  referencedPostgresEnums.size === Object.keys(suppliedPostgresEnums).length,
  "Every referenced host PostgreSQL enum must have one map entry",
);

const postgresDefinitionSchema = {
  jobs,
  ...suppliedPostgresEnums,
};

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;

const suppliedEnumKeysAreExact: Equal<
  keyof typeof suppliedPostgresEnums,
  "job_status" | "jobs.job_status"
> = true;

assert(suppliedEnumKeysAreExact, "Supplied PostgreSQL enum keys must remain exact");
assertKeys(
  postgresDefinitionSchema,
  ["jobs", "job_status", "jobs.job_status"],
  "PostgreSQL flat schema keys",
);

const commissaryUnqualifiedEnum = commissaryPg.enum({
  name: "job_status",
  values: ["pending", "done"],
});
const commissaryQualifiedEnum = commissaryPg.enum({
  schema: "jobs",
  name: "job_status",
  values: ["pending", "done"],
});

type PostgresEnumSchemaKey<Enum> =
  Enum extends PostgresEnum<infer _Values, infer Name, infer Schema>
    ? Schema extends string
      ? `${Schema}.${Name}`
      : Name
    : never;

const inferredUnqualifiedEnumKey: PostgresEnumSchemaKey<typeof commissaryUnqualifiedEnum> =
  "job_status";
const inferredQualifiedEnumKey: PostgresEnumSchemaKey<typeof commissaryQualifiedEnum> =
  "jobs.job_status";

const identityTable = pgSchema("app").table("identity_jobs", {
  id: integer("id").generatedAlwaysAsIdentity({ name: "identity_jobs_id_seq" }),
});
const identityConfig = getPgTableConfig(identityTable);
const identityColumn = identityConfig.columns[0];
assert(identityConfig.schema === "app", "Identity table schema must remain app");
assert(
  identityColumn?.generatedIdentity?.sequenceName === "identity_jobs_id_seq",
  "Drizzle must retain the identity sequence name",
);
assert(
  !("schema" in (identityColumn?.generatedIdentity?.sequenceOptions ?? {})),
  "Drizzle identity options must not expose an independent sequence schema",
);

function unsupportedPostgresIdentitySequenceSchema(): unknown {
  return integer("id").generatedAlwaysAsIdentity({
    name: "identity_jobs_id_seq",
    // @ts-expect-error Drizzle ORM 0.45.2 accepts no independent identity sequence schema.
    schema: "shared",
  });
}

function unsupportedMysqlDatetimeAutomaticUpdate(): unknown {
  // @ts-expect-error Drizzle ORM 0.45.2 exposes onUpdateNow only on timestamp builders.
  return datetime("updated_at").onUpdateNow();
}

const mysqlCustomDatetime = mysqlCustomType<{ data: string; driverData: string }>({
  dataType: () => "datetime",
});

function unsupportedMysqlCustomDatetimeAutomaticUpdate(): unknown {
  // @ts-expect-error Drizzle customType cannot emit automatic-update metadata.
  return mysqlCustomDatetime("updated_at").onUpdateNow();
}

void unsupportedPostgresIdentitySequenceSchema;
void unsupportedMysqlDatetimeAutomaticUpdate;
void unsupportedMysqlCustomDatetimeAutomaticUpdate;

const mysqlCustomDatetimeTable = mysqlTable("custom_datetime_jobs", {
  updatedAt: mysqlCustomDatetime("updated_at"),
});
const mysqlCustomDatetimeColumn = getTableColumns(mysqlCustomDatetimeTable).updatedAt;
assert(
  Reflect.get(mysqlCustomDatetimeColumn, "hasOnUpdateNow") !== true,
  "MySQL customType must not claim automatic-update metadata",
);

const mysqlTimestampTable = mysqlTable("timestamp_jobs", {
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow(),
});
const mysqlTimestampColumn = getTableColumns(mysqlTimestampTable).updatedAt;
const mysqlTimestampOnUpdate = Reflect.get(mysqlTimestampColumn, "hasOnUpdateNow");
assert(
  mysqlTimestampOnUpdate === true,
  "MySQL TIMESTAMP automatic update must remain representable",
);

const generatedColumnNames = Object.entries(getTableColumns(jobs))
  .filter(
    ([, column]) =>
      column.generated?.type === "always" || column.generatedIdentity?.type === "always",
  )
  .map(([name]) => name);

console.log(
  JSON.stringify({
    drizzleOrm: "0.45.2",
    drizzleZod: "0.8.3",
    drizzleValibot: "0.4.2",
    generatedColumnNames,
    zodKeys: {
      select: sortedKeys(zodSelect.shape),
      insert: sortedKeys(zodInsert.shape),
      update: sortedKeys(zodUpdate.shape),
    },
    valibotKeys: {
      select: sortedKeys(valibotSelect.entries),
      insert: sortedKeys(valibotInsert.entries),
      update: sortedKeys(valibotUpdate.entries),
    },
    postgresSchemaKeys: Object.keys(postgresDefinitionSchema),
    inferredUnqualifiedEnumKey,
    inferredQualifiedEnumKey,
    mysqlTimestampOnUpdate,
  }),
);
