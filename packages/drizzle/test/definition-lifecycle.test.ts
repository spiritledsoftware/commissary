import { coreRecordDefinitions } from "@commissary/core";
import type { FieldOutput, SelectFieldSchema } from "@commissary/store";
import { SqlRecord, sql } from "@commissary/store/sql";
import { mysql as storeMysql } from "@commissary/store/sql/mysql";
import { pg as storePostgres } from "@commissary/store/sql/postgres";
import { getTableColumns, is, relations, sql as drizzleSql } from "drizzle-orm";
import {
  PgTable,
  boolean,
  getTableConfig as getPostgresTableConfig,
  pgEnum,
  pgTable,
  text as pgText,
} from "drizzle-orm/pg-core";
import {
  MySqlTable,
  boolean as mysqlBoolean,
  datetime,
  getTableConfig as getMysqlTableConfig,
  mysqlTable,
  text as mysqlText,
} from "drizzle-orm/mysql-core";
import {
  SQLiteTable,
  customType as sqliteCustomType,
  getTableConfig as getSqliteTableConfig,
  integer,
  sqliteTable,
  text as sqliteText,
} from "drizzle-orm/sqlite-core";
import {
  createInsertSchema as createValibotInsertSchema,
  createSelectSchema as createValibotSelectSchema,
  createUpdateSchema as createValibotUpdateSchema,
} from "drizzle-valibot";
import { createInsertSchema, createSelectSchema, createUpdateSchema } from "drizzle-zod";
import { expect, it } from "vitest";
import { z } from "zod";
import { z as zod3 } from "zod3";

import { DrizzleDefinitionError } from "../src/index.js";
import { DrizzleMysqlStore, DrizzleMysqlThreadStore } from "../src/mysql.js";
import { DrizzlePostgresStore, DrizzlePostgresThreadStore } from "../src/postgres.js";
import { DrizzleSqliteStore, DrizzleSqliteThreadStore } from "../src/sqlite.js";
import type { ConcreteDrizzleDefinition } from "../src/definition-state.js";

const schemas = {
  select: createSelectSchema,
  insert: createInsertSchema,
  update: createUpdateSchema,
};

const valibotSchemas = {
  select: createValibotSelectSchema,
  insert: createValibotInsertSchema,
  update: createValibotUpdateSchema,
};

function logicalColumnKeys(
  columns: Readonly<Record<string, unknown>>,
  selected: readonly unknown[],
): readonly string[] {
  return selected.flatMap((column) => {
    const selectedName =
      typeof column === "object" && column !== null ? Reflect.get(column, "name") : undefined;
    const entry = Object.entries(columns).find(
      ([, candidate]) =>
        candidate === column ||
        (typeof candidate === "object" &&
          candidate !== null &&
          Reflect.get(candidate, "name") === selectedName),
    );
    return entry === undefined ? [] : [entry[0]];
  });
}

function captureDrizzleIssueLocations(use: () => unknown) {
  try {
    use();
  } catch (error) {
    if (error instanceof DrizzleDefinitionError) {
      return error.issues.map(({ code, path }) => ({ code, path }));
    }
    throw error;
  }
  throw new TypeError("Expected a Drizzle definition failure");
}

it("defines direct tables and flat relations in every dialect", () => {
  const postgresTable = pgTable("items", {
    id: pgText("id").notNull(),
    active: boolean("active").notNull().default(false),
  });
  const mysqlValue = mysqlTable("items", {
    id: mysqlText("id").notNull(),
    active: mysqlBoolean("active").notNull().default(false),
  });
  const sqliteValue = sqliteTable("items", {
    id: sqliteText("id").notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(false),
  });

  const postgres = DrizzlePostgresStore.define({
    schemas,
    records: { item: postgresTable },
    relations: (tables) => ({
      itemRelations: relations(tables.item, () => ({})),
    }),
  });
  const mysql = DrizzleMysqlStore.define({ schemas, records: { item: mysqlValue } });
  const sqlite = DrizzleSqliteStore.define({ schemas, records: { item: sqliteValue } });

  expect(postgres.schema.item).toBe(postgresTable);
  expect(Object.keys(postgres.schema)).toEqual(["item", "itemRelations"]);
  expect(mysql.schema.item).toBe(mysqlValue);
  expect(sqlite.schema.item).toBe(sqliteValue);
  expect(Object.keys(postgres.records.item.fields)).toEqual(["id", "active"]);
});

it("retains supplied PostgreSQL enum entities under exact flat keys", () => {
  const status = pgEnum("item_status", ["ready", "done"]);
  const table = pgTable("items", {
    id: pgText("id").notNull(),
    status: status("status").notNull(),
  });
  const definition = DrizzlePostgresStore.define({
    schemas,
    records: { item: table },
    enums: { item_status: status },
  });
  expect(definition.schema.item_status).toBe(status);
  expect(Object.keys(definition.schema)).toEqual(["item", "item_status"]);
});

it("rejects missing, unrelated, mismatched, and malformed PostgreSQL enum maps", () => {
  const status = pgEnum("item_status", ["ready", "done"]);
  const unrelated = pgEnum("unrelated_status", ["ready", "done"]);
  const table = pgTable("items", { status: status("status").notNull() });
  expect(
    captureDrizzleIssueLocations(() =>
      DrizzlePostgresStore.define({ schemas, records: { item: table } }),
    ),
  ).toEqual([{ code: "invalid-drizzle-enum", path: ["records", "item", "fields", "status"] }]);
  expect(
    captureDrizzleIssueLocations(() =>
      DrizzlePostgresStore.define({
        schemas,
        records: { item: table },
        enums: { item_status: status, unrelated_status: unrelated },
      }),
    ),
  ).toEqual([{ code: "invalid-drizzle-enum", path: ["enums", "unrelated_status"] }]);
  expect(
    captureDrizzleIssueLocations(() =>
      DrizzlePostgresStore.define({
        schemas,
        records: { item: table },
        enums: { wrong_status: status },
      }),
    ),
  ).toEqual([{ code: "invalid-drizzle-enum", path: ["enums", "wrong_status"] }]);
  expect(
    captureDrizzleIssueLocations(() =>
      DrizzlePostgresStore.define({
        schemas,
        records: { item: table },
        // SAFETY: This test bypasses the public enum-map type to verify malformed runtime input handling.
        enums: { item_status: {} } as never,
      }),
    ),
  ).toEqual([
    { code: "invalid-drizzle-enum", path: ["enums", "item_status"] },
    { code: "invalid-drizzle-enum", path: ["records", "item", "fields", "status"] },
  ]);
});

it("materializes one lower-tier PostgreSQL enum reused by several Records", () => {
  const statusType = storePostgres.enum({
    name: "shared_status",
    values: ["ready", "done"],
  });
  const record = SqlRecord.define({
    fields: {
      status: {
        select: z.enum(["ready", "done"]),
        column: sql.column({ postgres: storePostgres.column({ type: statusType }) }),
      },
    },
  });
  const definition = DrizzlePostgresStore.define({
    records: { first: record, second: record },
  });
  const exactValues: readonly ["ready", "done"] = definition.schema.shared_status.enumValues;
  expect(definition.schema.shared_status.enumName).toBe("shared_status");
  expect(exactValues).toEqual(["ready", "done"]);
  expect(Object.keys(definition.schema)).toEqual(["first", "second", "shared_status"]);
});

it("rejects conflicting lower-tier PostgreSQL enums with one physical key", () => {
  const recordWithStatus = (values: readonly [string, ...string[]]) =>
    SqlRecord.define({
      fields: {
        status: {
          select: z.string(),
          column: sql.column({
            postgres: storePostgres.column({
              type: storePostgres.enum({ name: "conflicting_status", values }),
            }),
          }),
        },
      },
    });
  expect(
    captureDrizzleIssueLocations(() =>
      DrizzlePostgresStore.define({
        records: {
          first: recordWithStatus(["ready", "done"]),
          second: recordWithStatus(["ready", "failed"]),
        },
      }),
    ),
  ).toEqual([{ code: "duplicate-schema-key", path: ["schema", "conflicting_status"] }]);
});

it("infers lower-tier PostgreSQL enum keys contributed by overrides", () => {
  const record = SqlRecord.define({
    fields: {
      id: { select: z.string(), column: sql.column({ type: sql.text() }) },
    },
  });
  const status = storePostgres.enum({
    name: "override_status",
    values: ["ready", "done"],
  });
  const definition = DrizzlePostgresStore.define({
    records: { item: record },
    overrides: {
      item: {
        fields: {
          status: {
            select: z.enum(["ready", "done"]),
            column: sql.column({ postgres: storePostgres.column({ type: status }) }),
          },
        },
      },
    },
  });
  expect(definition.schema.override_status.enumName).toBe("override_status");
});

it("accepts the host-supplied Drizzle Valibot generator family", () => {
  const table = sqliteTable("generated_items", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    label: sqliteText("label").notNull(),
  });
  const definition = DrizzleSqliteStore.define({
    schemas: valibotSchemas,
    records: { item: table },
  });
  expect(definition.schema.item).toBe(table);
});

it("accepts the supported Zod 3.25 Standard Schema object shape", () => {
  const table = sqliteTable("zod3_items", { id: sqliteText("id").notNull() });
  const schema = zod3.object({ id: zod3.string() });
  const definition = DrizzleSqliteStore.define({
    records: { item: table },
    schemas: {
      select: () => schema,
      insert: () => schema,
      update: () => schema,
    },
  });
  expect(definition.schema.item).toBe(table);
});

it("reports unsupported generator families as definition issues", () => {
  const table = sqliteTable("items", { id: sqliteText("id").notNull() });
  const unsupported = {
    select: () => ({
      "~standard": { version: 1 as const, vendor: "test", validate: () => ({ value: {} }) },
    }),
    insert: () => ({
      "~standard": { version: 1 as const, vendor: "test", validate: () => ({ value: {} }) },
    }),
    update: () => ({
      "~standard": { version: 1 as const, vendor: "test", validate: () => ({ value: {} }) },
    }),
  };
  expect(() =>
    DrizzleSqliteStore.define({ schemas: unsupported, records: { item: table } }),
  ).toThrow(DrizzleDefinitionError);
  try {
    DrizzleSqliteStore.define({ schemas: unsupported, records: { item: table } });
  } catch (error) {
    expect(error).toBeInstanceOf(DrizzleDefinitionError);
    if (!(error instanceof DrizzleDefinitionError)) throw error;
    expect(error.issues.map(({ code }) => code)).toEqual(["unsupported-schema-family"]);
  }
});

it("suppresses missing-schema diagnostics after a generator callback fails", () => {
  const table = sqliteTable("failed_generator", { id: sqliteText("id").notNull() });
  try {
    DrizzleSqliteStore.define({
      records: { item: table },
      schemas: {
        select: () => {
          throw new Error("select failed");
        },
        insert: createInsertSchema,
        update: createUpdateSchema,
      },
    });
    expect.unreachable("definition should fail");
  } catch (error) {
    expect(error).toBeInstanceOf(DrizzleDefinitionError);
    if (!(error instanceof DrizzleDefinitionError)) throw error;
    expect(error.issues.map(({ code }) => code)).toEqual(["invalid-schema-generator"]);
  }
});

it("rejects recognized generated schemas that produce non-JSON values", () => {
  class GeneratedNonJsonValue {}
  const dateField = {
    "~standard": {
      version: 1 as const,
      vendor: "test",
      validate: () => ({ value: new GeneratedNonJsonValue() }),
    },
  };
  const objectSchema = {
    "~standard": {
      version: 1 as const,
      vendor: "test",
      validate: () => ({ value: { id: new GeneratedNonJsonValue() } }),
    },
    shape: { id: dateField },
  };
  const table = sqliteTable("non_json_generator", { id: sqliteText("id").notNull() });
  expect(() =>
    DrizzleSqliteStore.define({
      records: { item: table },
      schemas: {
        select: () => objectSchema,
        insert: () => objectSchema,
        update: () => objectSchema,
      },
    }),
  ).toThrow(DrizzleDefinitionError);
});

it("rejects write schemas whose output cannot re-enter select", () => {
  const table = sqliteTable("incompatible_write", { id: sqliteText("id").notNull() });
  expect(() =>
    DrizzleSqliteStore.define({
      records: { item: table },
      overrides: {
        item: {
          fields: {
            id: {
              select: z.string(),
              create: z.string().transform(() => 1),
              update: z.string(),
            },
          },
        },
      },
    }),
  ).toThrow(DrizzleDefinitionError);
});

it("rejects async Field Schema validation that cannot be verified synchronously", () => {
  const asyncField = {
    "~standard": {
      version: 1 as const,
      vendor: "test",
      validate: () => Promise.reject(new TypeError("async validation failed")),
    },
  };
  const objectSchema = {
    "~standard": {
      version: 1 as const,
      vendor: "test",
      validate: () => ({ value: { id: "sample" } }),
    },
    shape: { id: asyncField },
  };
  const table = sqliteTable("async_generator", { id: sqliteText("id").notNull() });
  expect(() =>
    DrizzleSqliteStore.define({
      records: { item: table },
      schemas: {
        select: () => objectSchema,
        insert: () => objectSchema,
        update: () => objectSchema,
      },
    }),
  ).toThrow(DrizzleDefinitionError);
});

it("uses static Field Schemas without requiring generators", () => {
  const table = sqliteTable("static_items", { id: sqliteText("id").notNull() });
  const definition = DrizzleSqliteStore.define({
    records: { item: table },
    overrides: { item: { fields: { id: z.string() } } },
  });
  expect(definition.schema.item).toBe(table);
});

it("adds a direct column builder to a lower-tier Record", () => {
  const record = SqlRecord.define({
    fields: {
      id: {
        select: z.string(),
        column: sql.column({ type: sql.text(), notNull: true }),
      },
    },
  });
  const definition = DrizzleSqliteStore.define({
    schemas,
    records: { item: record },
    overrides: {
      item: {
        fields: { queue: sqliteText("queue").notNull() },
      },
    },
  });
  expect(Object.keys(getTableColumns(definition.schema.item))).toEqual(["id", "queue"]);
  expect(definition.schema.item.queue.name).toBe("queue");
  const queueValue: (typeof definition.schema.item.queue)["_"]["data"] = "jobs";
  // @ts-expect-error The concrete SQLite text builder preserves string inference.
  const invalidQueueValue: (typeof definition.schema.item.queue)["_"]["data"] = 1;
  expect({ queueValue, invalidQueueValue }).toEqual({ queueValue: "jobs", invalidQueueValue: 1 });
});

it("retains string codecs for generated bigint identity columns", () => {
  const postgresRecord = SqlRecord.define({
    fields: {
      id: {
        select: z.string(),
        column: sql.column({
          postgres: storePostgres.column({
            type: storePostgres.bigint(),
            identity: { mode: "always" },
          }),
        }),
      },
    },
  });
  const mysqlRecord = SqlRecord.define({
    fields: {
      id: {
        select: z.string(),
        column: sql.column({
          mysql: storeMysql.column({
            type: storeMysql.bigint(),
            autoIncrement: true,
          }),
        }),
      },
    },
  });
  const postgres = DrizzlePostgresStore.define({ records: { item: postgresRecord } });
  const mysql = DrizzleMysqlStore.define({ records: { item: mysqlRecord } });
  expect(getTableColumns(postgres.schema.item).id?.mapFromDriverValue("9007199254740993")).toBe(
    "9007199254740993",
  );
  expect(getTableColumns(mysql.schema.item).id?.mapFromDriverValue("9007199254740993")).toBe(
    "9007199254740993",
  );
});

it("rejects incompatible lower-tier direct columns and direct-table overrides", () => {
  const record = SqlRecord.define({
    fields: {
      id: {
        select: z.string(),
        column: sql.column({ name: "record_id", type: sql.text(), notNull: true }),
      },
    },
  });
  expect(() =>
    DrizzleSqliteStore.define({
      records: { item: record },
      overrides: { item: { fields: { id: integer("record_id").notNull() } } },
    }),
  ).toThrow(DrizzleDefinitionError);

  const direct = sqliteTable("items", { id: sqliteText("id").notNull() });
  expect(() =>
    DrizzleSqliteStore.define({
      schemas,
      records: { item: direct },
      overrides: { item: { fields: { ghost: z.string() } } },
    }),
  ).toThrow(DrizzleDefinitionError);
  expect(() =>
    DrizzleSqliteStore.define({
      schemas,
      records: { item: direct },
      overrides: {
        item: {
          // SAFETY: This test deliberately crosses the public dialect constraint to verify the runtime definition error.
          table: pgTable("wrong", { id: pgText("id") }) as never,
        },
      },
    }),
  ).toThrow(DrizzleDefinitionError);
});

it("rejects same-SQL column builders with incompatible runtime value mapping", () => {
  const record = SqlRecord.define({
    fields: {
      createdAt: {
        select: z.string(),
        column: sql.column({
          name: "created_at",
          mysql: storeMysql.column({ type: storeMysql.datetime() }),
        }),
      },
    },
  });
  expect(() =>
    DrizzleMysqlStore.define({
      records: { item: record },
      overrides: { item: { fields: { createdAt: datetime("created_at") } } },
    }),
  ).toThrow(DrizzleDefinitionError);
});

it("rejects direct columns that cannot encode valid write-schema outputs", () => {
  const brokenText = sqliteCustomType<{ data: string; driverData: string }>({
    dataType: () => "text",
    fromDriver: (value) => value,
    toDriver: () => {
      throw new TypeError("encode failed");
    },
  });
  const table = sqliteTable("broken_writes", { id: brokenText("id").notNull() });
  expect(() =>
    DrizzleSqliteStore.define({
      records: { item: table },
      overrides: { item: { fields: { id: z.string() } } },
    }),
  ).toThrow(DrizzleDefinitionError);
  expect(() =>
    DrizzleSqliteStore.define({
      records: { item: table },
      overrides: {
        item: {
          fields: {
            id: {
              select: z.string(),
              create: z.number().transform(String),
              update: z.number().transform(String),
            },
          },
        },
      },
    }),
  ).toThrow(DrizzleDefinitionError);
  for (const writeSchema of [z.literal("write"), z.string().regex(/^write$/)]) {
    expect(() =>
      DrizzleSqliteStore.define({
        records: { item: table },
        overrides: {
          item: {
            fields: {
              id: {
                select: z.string(),
                create: writeSchema,
                update: writeSchema,
              },
            },
          },
        },
      }),
    ).toThrow(DrizzleDefinitionError);
  }
});

it("rejects generated non-JSON selected values until a static schema converts them", () => {
  const table = mysqlTable("dated_items", {
    id: mysqlText("id").notNull(),
    createdAt: datetime("created_at").notNull(),
  });
  expect(() => DrizzleMysqlStore.define({ schemas, records: { item: table } })).toThrow(
    DrizzleDefinitionError,
  );
  const converted = z.preprocess(
    (value) => (value instanceof Date ? value.toISOString() : value),
    z.string(),
  );
  const convertedTable = mysqlTable("converted_dates", {
    id: mysqlText("id").notNull(),
    createdAt: datetime("created_at")
      .notNull()
      .generatedAlwaysAs(drizzleSql`current_timestamp`),
  });
  const definition = DrizzleMysqlStore.define({
    schemas,
    records: { item: convertedTable },
    overrides: { item: { fields: { createdAt: { select: converted } } } },
  });
  expect(definition.schema.item).toBe(convertedTable);
});

it("materializes the exact Core catalog for every Thread definition", () => {
  const postgres = DrizzlePostgresThreadStore.define({ records: {} });
  const mysql = DrizzleMysqlThreadStore.define({ records: {} });
  const sqlite = DrizzleSqliteThreadStore.define({ records: {} });
  const expected = Object.keys(coreRecordDefinitions);
  expect(Object.keys(postgres.schema)).toEqual(expected);
  expect(Object.keys(mysql.schema)).toEqual(expected);
  expect(Object.keys(sqlite.schema)).toEqual(expected);
  expect(Object.keys(getTableColumns(postgres.schema.thread))).toContain("id");
  for (const [recordName, coreDefinition] of Object.entries(coreRecordDefinitions)) {
    const coreTable = Reflect.get(coreDefinition, "table");
    expect(coreTable).toBeTypeOf("object");
    const expectedTableName = Reflect.get(coreTable, "name") ?? recordName;
    const expectedPrimaryKey = Reflect.get(coreTable, "primaryKey") ?? [];
    const expectedColumnNames = Object.entries(coreDefinition.fields).map(
      ([fieldName, field]) => Reflect.get(Reflect.get(field, "column"), "name") ?? fieldName,
    );

    const postgresTable = Reflect.get(postgres.schema, recordName);
    const mysqlTableValue = Reflect.get(mysql.schema, recordName);
    const sqliteTableValue = Reflect.get(sqlite.schema, recordName);
    expect(is(postgresTable, PgTable)).toBe(true);
    expect(is(mysqlTableValue, MySqlTable)).toBe(true);
    expect(is(sqliteTableValue, SQLiteTable)).toBe(true);
    if (
      !is(postgresTable, PgTable) ||
      !is(mysqlTableValue, MySqlTable) ||
      !is(sqliteTableValue, SQLiteTable)
    ) {
      throw new TypeError(`Core table '${recordName}' has the wrong Drizzle dialect`);
    }

    const postgresConfig = getPostgresTableConfig(postgresTable);
    const mysqlConfig = getMysqlTableConfig(mysqlTableValue);
    const sqliteConfig = getSqliteTableConfig(sqliteTableValue);
    expect([postgresConfig.name, mysqlConfig.name, sqliteConfig.name]).toEqual([
      expectedTableName,
      expectedTableName,
      expectedTableName,
    ]);
    for (const [tableValue, primaryColumns] of [
      [
        postgresTable,
        postgresConfig.primaryKeys[0]?.columns ??
          postgresConfig.columns.filter((column) => column.primary),
      ],
      [
        mysqlTableValue,
        mysqlConfig.primaryKeys[0]?.columns ??
          mysqlConfig.columns.filter((column) => column.primary),
      ],
      [
        sqliteTableValue,
        sqliteConfig.primaryKeys[0]?.columns ??
          sqliteConfig.columns.filter((column) => column.primary),
      ],
    ] as const) {
      const columns = getTableColumns(tableValue);
      expect(Object.values(columns).map((column) => column.name)).toEqual(expectedColumnNames);
      expect(logicalColumnKeys(columns, primaryColumns)).toEqual(expectedPrimaryKey);
    }
  }
});

it("applies Core table fields and captures hooks in a Thread definition", () => {
  let hookCalls = 0;
  const definition = DrizzleSqliteThreadStore.define({
    records: {},
    overrides: {
      thread: {
        fields: {
          tenantId: {
            select: z.string(),
            create: z.string(),
            update: z.string(),
            column: sqliteText("tenant_id").notNull(),
          },
        },
      },
    },
    hooks: {
      thread: {
        beforeCreate: () => {
          hookCalls += 1;
          return { tenantId: "tenant" };
        },
      },
    },
  });
  type CreateInputs =
    typeof definition extends ConcreteDrizzleDefinition<
      "sqlite",
      "thread-store",
      infer _Definitions,
      infer _Records,
      infer _Tables,
      infer _Schema,
      infer _Hooks,
      infer Inputs
    >
      ? Inputs
      : never;
  const tenantIdIsOptional: {} extends Pick<CreateInputs["thread"], "tenantId"> ? true : false =
    true;
  const idIsOptional: {} extends Pick<CreateInputs["thread"], "id"> ? true : false = false;
  expect(definition.schema.thread.tenantId.name).toBe("tenant_id");
  expect(hookCalls).toBe(0);
  expect({ tenantIdIsOptional, idIsOptional }).toEqual({
    tenantIdIsOptional: true,
    idIsOptional: false,
  });
});

it("rejects physical conflicts in Core column-builder overrides", () => {
  expect(() =>
    DrizzleSqliteThreadStore.define({
      records: {},
      overrides: { thread: { fields: { id: sqliteText("wrong_id").notNull() } } },
    }),
  ).toThrow(DrizzleDefinitionError);
});

it("requires internal Core hooks for required custom create fields at runtime", () => {
  expect(() =>
    DrizzleSqliteThreadStore.define({
      records: {},
      overrides: {
        message: {
          fields: {
            tenantId: {
              select: z.string(),
              column: sqliteText("tenant_id").notNull(),
            },
          },
        },
      },
      // SAFETY: The test bypasses the compile-time hook requirement to verify the matching runtime diagnostic.
    } as never),
  ).toThrow(DrizzleDefinitionError);
});

it("specializes Core outcome types after Core field overrides", () => {
  const definition = DrizzleSqliteThreadStore.define({
    records: {},
    overrides: {
      branch: {
        fields: {
          tenantId: {
            select: z.string(),
            create: z.string(),
            update: z.string(),
            column: sqliteText("tenant_id").notNull(),
          },
        },
      },
    },
  });
  type Definitions =
    typeof definition extends ConcreteDrizzleDefinition<
      "sqlite",
      "thread-store",
      infer Value,
      infer _Records,
      infer _Tables,
      infer _Schema,
      infer _Hooks,
      infer _CreateInputs
    >
      ? Value
      : never;
  type ModelCommitOutcome = FieldOutput<
    SelectFieldSchema<Definitions["modelCommitOutcome"]["fields"]["outcome"]>
  >;
  type CommittedBranch = Extract<ModelCommitOutcome, { readonly type: "committed" }>["value"];
  const outcomeIncludesTenantId: "tenantId" extends keyof CommittedBranch ? true : false = true;
  expect(outcomeIncludesTenantId).toBe(true);
});

it("reports the exact Drizzle 0.45.2 representation limits", () => {
  const mysqlRecord = SqlRecord.define({
    fields: {
      updatedAt: {
        select: z.string(),
        column: sql.column({
          mysql: storeMysql.column({
            type: storeMysql.datetime(),
            default: sql.raw("CURRENT_TIMESTAMP"),
            onUpdate: "current-timestamp",
          }),
        }),
      },
    },
  });
  expect(() => DrizzleMysqlStore.define({ records: { item: mysqlRecord } })).toThrowError(
    "Drizzle cannot represent MySQL DATETIME with ON UPDATE CURRENT_TIMESTAMP",
  );

  const postgresRecord = SqlRecord.define({
    table: sql.table({ postgres: storePostgres.table({ schema: "app" }) }),
    fields: {
      id: {
        select: z.string(),
        column: sql.column({
          postgres: storePostgres.column({
            type: storePostgres.bigint(),
            identity: {
              mode: "always",
              sequence: { name: { schema: "shared", name: "item_id_seq" } },
            },
          }),
        }),
      },
    },
  });
  expect(() => DrizzlePostgresStore.define({ records: { item: postgresRecord } })).toThrowError(
    "Drizzle cannot represent an explicit PostgreSQL identity sequence whose schema qualification differs from its table",
  );
});

const compileTimeDefinitionFailures = (): void => {
  const lowerRecord = SqlRecord.define({
    fields: {
      id: { select: z.string(), column: sql.column({ type: sql.text() }) },
    },
  });
  // @ts-expect-error A new direct column needs generated schemas or a complete static schema.
  DrizzleSqliteStore.define({
    records: { item: lowerRecord },
    overrides: { item: { fields: { queue: sqliteText("queue") } } },
  });
  // @ts-expect-error A PostgreSQL table is not a SQLite Record input.
  DrizzleSqliteStore.define({ schemas, records: { item: pgTable("wrong", { id: pgText("id") }) } });
  DrizzleSqliteStore.define({
    schemas,
    records: { item: sqliteTable("item", { id: sqliteText("id") }) },
    overrides: {
      item: {
        // @ts-expect-error A PostgreSQL table cannot replace a SQLite table.
        table: pgTable("wrong", { id: pgText("id") }),
      },
    },
  });
  DrizzleSqliteStore.define({
    schemas,
    records: { item: sqliteTable("item", { id: sqliteText("id") }) },
    overrides: {
      item: {
        fields: {
          // @ts-expect-error A PostgreSQL builder cannot replace a SQLite column.
          id: pgText("id"),
        },
      },
    },
  });
  // @ts-expect-error A required custom Core field needs its corresponding internal create hook.
  DrizzleSqliteThreadStore.define({
    records: {},
    overrides: {
      message: {
        fields: {
          tenantId: {
            select: z.string(),
            create: z.string(),
            update: z.string(),
            column: sqliteText("tenant_id").notNull(),
          },
        },
      },
    },
  });
  // @ts-expect-error A required builder-only Core field also needs its internal create hook.
  DrizzleSqliteThreadStore.define({
    schemas,
    records: {},
    overrides: {
      message: {
        fields: { tenantId: sqliteText("tenant_id").notNull() },
      },
    },
  });
  // @ts-expect-error A complete Core table override with a required extra column needs its hook.
  DrizzleSqliteThreadStore.define({
    schemas,
    records: {},
    overrides: {
      message: sqliteTable("overridden_messages", {
        tenantId: sqliteText("tenant_id").notNull(),
      }),
    },
  });
  DrizzleSqliteThreadStore.define({
    records: {},
    overrides: {
      message: {
        fields: {
          tenantId: {
            select: z.string(),
            create: z.string(),
            update: z.string(),
            column: sqliteText("tenant_id").notNull(),
          },
        },
      },
    },
    hooks: {
      message: {
        // @ts-expect-error The required hook key must guarantee its required custom create field.
        beforeCreate: () => ({}),
      },
    },
  });
};
void compileTimeDefinitionFailures;
