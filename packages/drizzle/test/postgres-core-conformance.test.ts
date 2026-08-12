import { PGlite } from "@electric-sql/pglite";
import { createThreadStore } from "@commissary/core";
import { SqlRecord, sql } from "@commissary/store/sql";
import {
  createCoreRuntimeConformanceSuite,
  type CoreRuntimeConformanceAdapter,
} from "@commissary/core/conformance";
import { getTableColumns, is } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import {
  getTableConfig as getPostgresTableConfig,
  PgTable,
  text,
  type AnyPgTable,
} from "drizzle-orm/pg-core";
import { afterEach, test } from "vitest";

import { DrizzlePostgresThreadStore, bindPostgresStore } from "../src/postgres.js";

const openClients: PGlite[] = [];

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()));
});

function quotePostgresTestIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function postgresTestTableDdl(table: AnyPgTable): string {
  const config = getPostgresTableConfig(table);
  const columns = getTableColumns(table);
  const primaryColumns =
    config.primaryKeys[0]?.columns ?? config.columns.filter((column) => column.primary);
  const primaryNames = primaryColumns.map((column) => column.name);
  const columnSql = Object.values(columns).map((column) => {
    const generated = column.generated;
    const generatedSql =
      generated === undefined
        ? ""
        : ` GENERATED ALWAYS AS (${String(generated.as)}) ${generated.mode === "virtual" ? "VIRTUAL" : "STORED"}`;
    return `${quotePostgresTestIdentifier(column.name)} ${column.getSQLType()}${column.notNull ? " NOT NULL" : ""}${generatedSql}`;
  });
  if (primaryNames.length > 0) {
    columnSql.push(`PRIMARY KEY (${primaryNames.map(quotePostgresTestIdentifier).join(", ")})`);
  }
  const qualifiedName =
    config.schema === undefined
      ? quotePostgresTestIdentifier(config.name)
      : `${quotePostgresTestIdentifier(config.schema)}.${quotePostgresTestIdentifier(config.name)}`;
  return `CREATE TABLE ${qualifiedName} (${columnSql.join(", ")})`;
}

async function createPostgresCoreDatabase<Schema extends Readonly<Record<string, object>>>(
  schema: Schema,
) {
  const client = new PGlite();
  openClients.push(client);
  const tables = Object.values(schema).filter((value): value is AnyPgTable => is(value, PgTable));
  await client.exec(tables.map(postgresTestTableDdl).join(";\n"));
  return drizzle(client, { schema });
}

function postgresCoreConformanceAdapter(transaction: boolean): CoreRuntimeConformanceAdapter {
  const mode = transaction ? "transaction" : "plain";
  const makeConfiguredThreadStore: CoreRuntimeConformanceAdapter["makeConfiguredThreadStore"] =
    async (configuration) => {
      const overrides = configuration.overrides;
      if (overrides === undefined) {
        throw new TypeError("Core Runtime conformance requires Record overrides");
      }
      const messageHook = configuration.hooks?.message;
      if (messageHook === undefined) {
        throw new TypeError("Core Runtime conformance requires the Message hook");
      }
      const records = {
        scheduledJobs: SqlRecord.define({
          table: sql.table({ name: "scheduledJobs", primaryKey: ["id"] }),
          fields: {
            id: {
              select: configuration.records.scheduledJobs.fields.id,
              column: sql.column({ type: sql.text(), notNull: true }),
            },
            status: {
              select: configuration.records.scheduledJobs.fields.status,
              column: sql.column({ type: sql.text(), notNull: true }),
            },
          },
        }),
      };
      const definition = DrizzlePostgresThreadStore.define({
        records,
        overrides: {
          thread: {
            fields: {
              ...overrides.thread.fields,
              id: {
                select: overrides.thread.fields.id,
                column: text("id").notNull().primaryKey(),
              },
              owner: {
                select: overrides.thread.fields.owner,
                column: text("owner"),
              },
            },
          },
          branch: {
            fields: {
              label: {
                select: overrides.branch.fields.label,
                column: text("label"),
              },
            },
          },
          message: {
            fields: {
              source: {
                select: overrides.message.fields.source,
                column: text("source"),
              },
            },
          },
          run: {
            fields: {
              category: {
                select: overrides.run.fields.category,
                column: text("category"),
              },
            },
          },
        },
        hooks: {
          message: {
            beforeCreate: ({ draft }) => {
              // SAFETY: Both callbacks receive the same effective configured Message create draft; the Drizzle definition adds only physical column evidence.
              const patch = messageHook.beforeCreate({ draft: draft as never });
              return {
                ...(typeof draft === "object" && draft !== null ? draft : {}),
                ...patch,
              };
            },
          },
        },
      });
      const database = await createPostgresCoreDatabase(definition.schema);
      const backend = transaction
        ? await bindPostgresStore({ definition, database, transaction: true })
        : await bindPostgresStore({ definition, database });
      const store = createThreadStore({ backend });
      // SAFETY: This definition contains the exact configured contributions and Core overrides supplied by the conformance contract; Drizzle adds only physical builders.
      return store as unknown as Awaited<
        ReturnType<CoreRuntimeConformanceAdapter["makeConfiguredThreadStore"]>
      >;
    };
  return {
    adapter: `Drizzle PostgreSQL ${mode}`,
    makeThreadStore: async () => {
      const definition = DrizzlePostgresThreadStore.define({ records: {} });
      const database = await createPostgresCoreDatabase(definition.schema);
      const backend = transaction
        ? await bindPostgresStore({ definition, database, transaction: true })
        : await bindPostgresStore({ definition, database });
      return createThreadStore({ backend });
    },
    makeConfiguredThreadStore,
  };
}

for (const transaction of [false, true]) {
  for (const scenario of createCoreRuntimeConformanceSuite(
    postgresCoreConformanceAdapter(transaction),
  )) {
    test(
      `Core Runtime conformance: ${transaction ? "transaction" : "plain"}: ${scenario.name}`,
      scenario.run,
      30_000,
    );
  }
}
