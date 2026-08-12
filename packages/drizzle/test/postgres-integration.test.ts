import { PGlite } from "@electric-sql/pglite";
import { StoreAdapterError, type FieldSchema } from "@commissary/store";
import { SqlRecord, sql } from "@commissary/store/sql";
import { drizzle } from "drizzle-orm/pglite";
import { sql as drizzleSql } from "drizzle-orm";
import { integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { afterEach, expect, test } from "vitest";

import { DrizzlePostgresStore, bindPostgresStore } from "../src/postgres.js";

const openClients: PGlite[] = [];
const livePostgresTestTimeout = 15_000;

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()));
});

function requiredString(): FieldSchema<string, string> {
  return {
    "~standard": {
      version: 1,
      vendor: "commissary-test",
      validate: (value) =>
        typeof value === "string" ? { value } : { issues: [{ message: "Expected string" }] },
    },
  };
}

function optionalNumber(): FieldSchema<number | null | undefined, number | null | undefined> {
  return {
    "~standard": {
      version: 1,
      vendor: "commissary-test",
      validate: (value) =>
        value === undefined || value === null || typeof value === "number"
          ? { value }
          : { issues: [{ message: "Expected optional number" }] },
    },
  };
}

const defaultedStatus: FieldSchema<string | undefined, string> = {
  "~standard": {
    version: 1,
    vendor: "commissary-test",
    validate: (value) =>
      value === undefined || typeof value === "string"
        ? { value: value ?? "queued" }
        : { issues: [{ message: "Expected optional string" }] },
  },
};

const omittedWrite: FieldSchema<undefined, undefined> = {
  "~standard": {
    version: 1,
    vendor: "commissary-test",
    validate: (value) =>
      value === undefined
        ? { value: undefined }
        : { issues: [{ message: "Expected an omitted field" }] },
  },
};

const optionalWriteString: FieldSchema<string | undefined, string | undefined> = {
  "~standard": {
    version: 1,
    vendor: "commissary-test",
    validate: (value) =>
      value === undefined || typeof value === "string"
        ? { value }
        : { issues: [{ message: "Expected optional string" }] },
  },
};

const optionalNull: FieldSchema<null | undefined, null | undefined> = {
  "~standard": {
    version: 1,
    vendor: "commissary-test",
    validate: (value) =>
      value === undefined || value === null
        ? { value }
        : { issues: [{ message: "Expected null or omission" }] },
  },
};

const requiredNumber: FieldSchema<number, number> = {
  "~standard": {
    version: 1,
    vendor: "commissary-test",
    validate: (value) =>
      typeof value === "number" && Number.isSafeInteger(value)
        ? { value }
        : { issues: [{ message: "Expected integer" }] },
  },
};

const jobRecord = SqlRecord.define({
  table: sql.table({ name: "jobs", primaryKey: ["id"] }),
  fields: {
    id: {
      select: requiredString(),
      column: sql.column({ type: sql.text(), notNull: true }),
    },
    status: {
      select: requiredString(),
      create: defaultedStatus,
      column: sql.column({
        type: sql.text(),
        notNull: true,
        default: sql.literal("queued"),
      }),
    },
    score: {
      select: optionalNumber(),
      column: sql.column({ type: sql.number() }),
    },
  },
});

const eventRecord = SqlRecord.define({
  table: sql.table({ name: "events" }),
  fields: {
    kind: {
      select: requiredString(),
      column: sql.column({ type: sql.text(), notNull: true }),
    },
  },
});

async function makeIntegrationDatabase() {
  const definition = DrizzlePostgresStore.define({
    records: { job: jobRecord, event: eventRecord },
  });
  const client = new PGlite();
  openClients.push(client);
  await client.exec(`
    CREATE TABLE jobs (
      id text PRIMARY KEY,
      status text NOT NULL DEFAULT 'queued',
      score double precision
    );
    CREATE TABLE events (kind text NOT NULL);
  `);
  const database = drizzle(client, { schema: definition.schema });
  return { definition, database, client };
}

function beforePostgresUpdate(database: object, beforeCall: (call: number) => Promise<void>): void {
  const update = Reflect.get(database, "update");
  if (typeof update !== "function") throw new TypeError("Expected PostgreSQL update method");
  let calls = 0;
  Object.defineProperty(database, "update", {
    configurable: true,
    value: (table: unknown) => {
      const builder = Reflect.apply(update, database, [table]);
      if (typeof builder !== "object" || builder === null) {
        throw new TypeError("Expected PostgreSQL update builder");
      }
      const set = Reflect.get(builder, "set");
      if (typeof set !== "function") throw new TypeError("Expected PostgreSQL set method");
      Object.defineProperty(builder, "set", {
        configurable: true,
        value: (values: unknown) => {
          const query = Reflect.apply(set, builder, [values]);
          if (typeof query !== "object" || query === null) {
            throw new TypeError("Expected PostgreSQL update query");
          }
          const where = Reflect.get(query, "where");
          if (typeof where !== "function") throw new TypeError("Expected PostgreSQL where method");
          Object.defineProperty(query, "where", {
            configurable: true,
            value: (condition: unknown) => {
              const guarded = Reflect.apply(where, query, [condition]);
              if (typeof guarded !== "object" || guarded === null) {
                throw new TypeError("Expected guarded PostgreSQL update query");
              }
              const returning = Reflect.get(guarded, "returning");
              if (typeof returning !== "function") {
                throw new TypeError("Expected PostgreSQL returning method");
              }
              Object.defineProperty(guarded, "returning", {
                configurable: true,
                value: (...arguments_: readonly unknown[]) => {
                  const result = Reflect.apply(returning, guarded, arguments_);
                  calls += 1;
                  return Promise.resolve().then(async () => {
                    await beforeCall(calls);
                    return await result;
                  });
                },
              });
              return guarded;
            },
          });
          return query;
        },
      });
      return builder;
    },
  });
}

test(
  "runs Collection fallback operations with keyed and keyless tables",
  async () => {
    const { definition, database } = await makeIntegrationDatabase();
    const store = await bindPostgresStore({ definition, database });
    await store.collections.job.create({ id: "two", status: "ready", score: 2 });
    await store.collections.job.create({ id: "one", status: "queued" });
    await store.collections.event.create({ kind: "created" });

    expect(
      await store.collections.job.find({
        where: (fields, op) => op.gte(fields.score, 1),
        orderBy: (fields, op) => [op.desc(fields.id)],
        select: { id: true, score: true },
      }),
    ).toEqual([{ id: "two", score: 2 }]);
    expect(await store.collections.job.count()).toBe(2);
    expect(
      await store.collections.job.update({
        where: (fields, op) => op.eq(fields.id, "two"),
        set: (fields, op) => ({ status: op.concat(fields.status, "-done") }),
      }),
    ).toBe(1);
    expect(
      await store.collections.event.update({
        set: (fields, op) => ({ kind: op.concat(fields.kind, "-updated") }),
      }),
    ).toBe(1);
    expect(
      await store.collections.event.delete({
        where: (fields, op) => op.eq(fields.kind, "created-updated"),
      }),
    ).toBe(1);
    expect(await store.collections.job.find({ select: { id: true, status: true } })).toEqual([
      { id: "one", status: "queued" },
      { id: "two", status: "ready-done" },
    ]);
  },
  livePostgresTestTimeout,
);

test(
  "guards supplied composite-primary-key mutations",
  async () => {
    const memberships = pgTable(
      "memberships",
      {
        tenantId: text("tenant_id").notNull(),
        userId: text("user_id").notNull(),
        role: text("role").notNull(),
      },
      (table) => [primaryKey({ columns: [table.tenantId, table.userId] })],
    );
    const definition = DrizzlePostgresStore.define({
      records: { membership: memberships },
      overrides: {
        membership: {
          fields: {
            tenantId: requiredString(),
            userId: requiredString(),
            role: requiredString(),
          },
        },
      },
    });
    const client = new PGlite();
    openClients.push(client);
    await client.exec(`
    CREATE TABLE memberships (
      tenant_id text NOT NULL,
      user_id text NOT NULL,
      role text NOT NULL,
      PRIMARY KEY (tenant_id, user_id)
    )
  `);
    const database = drizzle(client, { schema: definition.schema });
    const store = await bindPostgresStore({ definition, database });
    await store.collections.membership.create({
      tenantId: "tenant-1",
      userId: "user-1",
      role: "viewer",
    });

    expect(
      await store.collections.membership.update({
        where: (fields, op) =>
          op.and(op.eq(fields.tenantId, "tenant-1"), op.eq(fields.userId, "user-1")),
        set: { role: "editor" },
      }),
    ).toBe(1);
    expect(
      await store.collections.membership.delete({
        where: (fields, op) => op.eq(fields.userId, "user-1"),
      }),
    ).toBe(1);
  },
  livePostgresTestTimeout,
);

test.each([
  { conflictCall: 1, expectedWritesMayRemain: false },
  { conflictCall: 2, expectedWritesMayRemain: true },
])(
  "reports an xmin conflict at guarded update $conflictCall with partial-write state",
  async ({ conflictCall, expectedWritesMayRemain }) => {
    const { definition, database, client } = await makeIntegrationDatabase();
    const store = await bindPostgresStore({ definition, database });
    await store.collections.job.create({ id: "one", status: "queued" });
    await store.collections.job.create({ id: "two", status: "queued" });
    beforePostgresUpdate(database, async (call) => {
      if (call !== conflictCall) return;
      const id = conflictCall === 1 ? "one" : "two";
      await client.exec(`UPDATE jobs SET status = status || '-concurrent' WHERE id = '${id}'`);
    });

    const failure = await store.collections.job
      .update({ set: { status: "processed" } })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(StoreAdapterError);
    expect(failure).toMatchObject({
      collection: "job",
      operation: "update",
      writesMayRemain: expectedWritesMayRemain,
    });
    expect(
      await store.collections.job.find({
        select: { id: true, status: true },
        orderBy: (fields, op) => [op.asc(fields.id)],
      }),
    ).toEqual(
      conflictCall === 1
        ? [
            { id: "one", status: "queued-concurrent" },
            { id: "two", status: "queued" },
          ]
        : [
            { id: "one", status: "processed" },
            { id: "two", status: "queued-concurrent" },
          ],
    );
  },
  livePostgresTestTimeout,
);

test(
  "returns SQL NULL through nullable selected fields",
  async () => {
    const { definition, database } = await makeIntegrationDatabase();
    const store = await bindPostgresStore({ definition, database });

    await store.collections.job.create({ id: "null-score", status: "queued", score: null });
    await store.collections.job.create({ id: "missing-score", status: "queued" });

    expect(
      await store.collections.job.find({
        select: { id: true, score: true },
        orderBy: (fields, op) => [op.asc(fields.id)],
      }),
    ).toEqual([
      { id: "missing-score", score: null },
      { id: "null-score", score: null },
    ]);
  },
  livePostgresTestTimeout,
);

test(
  "distinguishes an omitted nullable JSON field from a stored JSON null",
  async () => {
    const definition = DrizzlePostgresStore.define({
      records: {
        payload: SqlRecord.define({
          table: sql.table({ name: "payloads", primaryKey: ["id"] }),
          fields: {
            id: {
              select: requiredString(),
              column: sql.column({ type: sql.text(), notNull: true }),
            },
            value: {
              select: optionalNull,
              column: sql.column({ type: sql.json() }),
            },
          },
        }),
      },
    });
    const client = new PGlite();
    openClients.push(client);
    await client.exec("CREATE TABLE payloads (id text PRIMARY KEY, value json)");
    const database = drizzle(client, { schema: definition.schema });
    const store = await bindPostgresStore({ definition, database });

    expect(await store.collections.payload.create({ id: "missing" })).toEqual({ id: "missing" });
    expect(await store.collections.payload.create({ id: "null", value: null })).toEqual({
      id: "null",
      value: null,
    });
    expect(
      await store.collections.payload.update({
        where: (fields, op) => op.eq(fields.id, "missing"),
        set: { value: null },
      }),
    ).toBe(1);
    expect(
      await store.collections.payload.update({
        where: (fields, op) => op.eq(fields.id, "null"),
        set: (_fields, op) => ({ value: op.unset() }),
      }),
    ).toBe(1);
    expect(
      await store.collections.payload.find({
        orderBy: (fields, op) => [op.asc(fields.id)],
      }),
    ).toEqual([{ id: "missing", value: null }, { id: "null" }]);
  },
  livePostgresTestTimeout,
);

test(
  "shares Collection and direct SQL work in one physical transaction",
  async () => {
    const { definition, database } = await makeIntegrationDatabase();
    const store = await bindPostgresStore({ definition, database, transaction: true });

    await store.transaction(async (transaction) => {
      await transaction.collections.job.create({ id: "one", status: "queued" });
      const rows = await transaction.query<{ readonly count: string }>(
        sql.raw("SELECT count(*)::text AS count FROM jobs"),
      );
      expect(rows).toEqual([{ count: "1" }]);
    });

    const failure = Object.freeze({ kind: "rollback" });
    await expect(
      store.transaction(async (transaction) => {
        await transaction.collections.job.create({ id: "rolled-back", status: "queued" });
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(
      await store.collections.job.count({
        where: (fields, op) => op.eq(fields.id, "rolled-back"),
      }),
    ).toBe(0);
  },
  livePostgresTestTimeout,
);

test(
  "merges hooks and returns database-generated values without overwriting host values",
  async () => {
    const generatedJobs = pgTable("generated_jobs", {
      id: integer("id").generatedAlwaysAsIdentity(),
      tenantId: text("tenant_id").notNull(),
      label: text("label").notNull().default("queued"),
      summary: text("summary").generatedAlwaysAs(drizzleSql`tenant_id || ':' || label`),
    });
    const definition = DrizzlePostgresStore.define({
      records: { generatedJob: generatedJobs },
      overrides: {
        generatedJob: {
          fields: {
            id: { select: requiredNumber, create: omittedWrite, update: omittedWrite },
            tenantId: requiredString(),
            label: { select: requiredString(), create: optionalWriteString },
            summary: { select: requiredString(), create: omittedWrite, update: omittedWrite },
          },
        },
      },
      hooks: {
        generatedJob: {
          beforeCreate: () => ({ tenantId: "tenant-from-hook" }),
        },
      },
    });
    const client = new PGlite();
    openClients.push(client);
    await client.exec(`
    CREATE TABLE generated_jobs (
      id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      tenant_id text NOT NULL,
      label text NOT NULL DEFAULT 'queued',
      summary text GENERATED ALWAYS AS (tenant_id || ':' || label) STORED
    )
  `);
    const database = drizzle(client, { schema: definition.schema });
    const store = await bindPostgresStore({ definition, database });

    const created = await store.collections.generatedJob.create({});

    expect(created).toEqual({
      id: 1,
      tenantId: "tenant-from-hook",
      label: "queued",
      summary: "tenant-from-hook:queued",
    });
    expect(await store.collections.generatedJob.create({ label: "priority" })).toMatchObject({
      label: "priority",
      summary: "tenant-from-hook:priority",
    });
  },
  livePostgresTestTimeout,
);
