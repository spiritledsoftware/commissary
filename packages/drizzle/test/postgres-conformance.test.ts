import { PGlite } from "@electric-sql/pglite";
import type { RecordDefinition } from "@commissary/store";
import {
  createStoreAdapterConformanceSuite,
  storeConformanceRecordDefinitions,
} from "@commissary/store/conformance";
import { SqlRecord, sql } from "@commissary/store/sql";
import { pg } from "@commissary/store/sql/postgres";
import { drizzle } from "drizzle-orm/pglite";
import { doublePrecision, pgTable, text } from "drizzle-orm/pg-core";
import { afterEach, test } from "vitest";

import { DrizzlePostgresStore, bindPostgresStore } from "../src/postgres.js";

const conformanceJobs = pgTable("commissary_conformance_jobs", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  rank: doublePrecision("rank").notNull(),
  score: doublePrecision("score"),
  tags: text("tags").array().notNull(),
});

const conformanceRecords = {
  jobs: SqlRecord.define({
    table: sql.table({ name: "commissary_conformance_jobs", primaryKey: ["id"] }),
    fields: {
      id: {
        select: storeConformanceRecordDefinitions.jobs.fields.id,
        column: sql.column({ type: sql.text(), notNull: true }),
      },
      label: {
        select: storeConformanceRecordDefinitions.jobs.fields.label,
        column: sql.column({ type: sql.text(), notNull: true }),
      },
      rank: {
        select: storeConformanceRecordDefinitions.jobs.fields.rank,
        column: sql.column({ type: sql.number(), notNull: true }),
      },
      score: {
        select: storeConformanceRecordDefinitions.jobs.fields.score,
        column: sql.column({ type: sql.number() }),
      },
      tags: {
        select: storeConformanceRecordDefinitions.jobs.fields.tags,
        column: sql.column({
          postgres: pg.column({ type: pg.array(pg.text()) }),
          notNull: true,
        }),
      },
    },
  }),
} as const satisfies Readonly<Record<string, RecordDefinition>>;

const conformanceDefinition = DrizzlePostgresStore.define({
  records: conformanceRecords,
  overrides: { jobs: conformanceJobs },
});

const openClients: PGlite[] = [];

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()));
});

for (const scenario of createStoreAdapterConformanceSuite({
  profile: {
    adapter: "Drizzle PostgreSQL",
    find: { limitMaximum: null, equalValueOrder: "stable" },
    query: {
      semantics: "javascript-fallback",
      stringCollation: "JavaScript relational order",
      inArrayCandidateMaximum: null,
    },
    update: { semantics: "javascript-fallback" },
  },
  makeStore: async () => {
    const client = new PGlite();
    openClients.push(client);
    await client.exec(`
      CREATE TABLE commissary_conformance_jobs (
        id text PRIMARY KEY,
        label text NOT NULL,
        rank double precision NOT NULL,
        score double precision,
        tags text[] NOT NULL
      )
    `);
    const database = drizzle(client, { schema: conformanceDefinition.schema });
    return await bindPostgresStore({
      definition: conformanceDefinition,
      database,
      transaction: true,
    });
  },
})) {
  test(`Store conformance: ${scenario.name}`, scenario.run, 15_000);
}
