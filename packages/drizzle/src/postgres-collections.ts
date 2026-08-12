import {
  compileStoreOrder,
  compileStoreUpdate,
  compileStoreWhere,
  parseStoreCreateInput,
  parseStoreSelectedFields,
  parseStoreSelectedRecord,
  parseStoreUpdatedRecord,
  StoreAdapterContractError,
  StoreAdapterError,
  StoreHookError,
  StoreValidationError,
  validateStoreFindPagination,
  type BaseStoreOperatorTypes,
  type Collection,
  type JsonObject,
  type JsonValue,
  type Project,
  type RecordDefinition,
  type RecordDefinitions,
  type SelectedRecord,
  type Selection,
  type StoreCollectionOperation,
  type StoreCollections,
  type StoreCreateInputMap,
} from "@commissary/store";
import type { TrackTransactionOperation } from "@commissary/store/transaction-adapter";
import { and, getTableColumns, sql, type SQL } from "drizzle-orm";
import {
  getTableConfig as getPostgresTableConfig,
  type AnyPgColumn,
  type AnyPgTable,
} from "drizzle-orm/pg-core";

interface RuntimePostgresSelectBuilder {
  from(table: AnyPgTable): PromiseLike<unknown>;
}

interface RuntimePostgresInsertQuery {
  returning(fields?: Readonly<Record<string, unknown>>): PromiseLike<unknown>;
}

interface RuntimePostgresInsertBuilder {
  overridingSystemValue(): RuntimePostgresInsertBuilder;
  values(values: Readonly<Record<string, unknown>>): RuntimePostgresInsertQuery;
}

interface RuntimePostgresUpdateQuery {
  where(condition: SQL): {
    returning(fields?: Readonly<Record<string, unknown>>): PromiseLike<unknown>;
  };
}

interface RuntimePostgresUpdateBuilder {
  set(values: Readonly<Record<string, unknown>>): RuntimePostgresUpdateQuery;
}

interface RuntimePostgresDeleteBuilder {
  where(condition: SQL): { returning(): PromiseLike<unknown> };
}

/** Public Drizzle query-builder surface used by PostgreSQL Collections. */
export interface PostgresCollectionDatabase {
  readonly select: (fields: Readonly<Record<string, unknown>>) => RuntimePostgresSelectBuilder;
  readonly insert: (table: AnyPgTable) => RuntimePostgresInsertBuilder;
  readonly update: (table: AnyPgTable) => RuntimePostgresUpdateBuilder;
  readonly delete: (table: AnyPgTable) => RuntimePostgresDeleteBuilder;
}

/** Runtime facts retained by one PostgreSQL Store definition. */
export interface PostgresCollectionDefinitionState {
  readonly definitions: RecordDefinitions;
  readonly tables: Readonly<Record<string, AnyPgTable>>;
  readonly hooks: Readonly<Record<string, unknown>>;
}

interface RuntimeBeforeCreateHook {
  readonly beforeCreate: (input: { readonly draft: unknown }) => unknown;
}

type PostgresCandidateIdentity =
  | {
      readonly kind: "primary-key";
      readonly columns: readonly AnyPgColumn[];
      readonly values: readonly unknown[];
      readonly xmin: string;
    }
  | {
      readonly kind: "physical-row";
      readonly tableOid: string;
      readonly tupleId: string;
      readonly xmin: string;
    };

interface PostgresCandidate<Definition extends RecordDefinition> {
  readonly identity: PostgresCandidateIdentity;
  readonly record: SelectedRecord<Definition>;
}

interface PostgresRecordSelection {
  readonly columns: Readonly<Record<string, AnyPgColumn>>;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly fieldNames: readonly string[];
  readonly jsonNullMarkers: Readonly<Record<string, string>>;
  readonly privateFields: readonly string[];
}

interface PostgresCandidateSelection extends PostgresRecordSelection {
  readonly identityFields: {
    readonly tableOid?: string;
    readonly tupleId?: string;
    readonly xmin: string;
  };
}

function runPostgresStoreOperation<Value>(start: () => Promise<Value>): Promise<Value> {
  return Promise.resolve().then(start);
}

function isRuntimeBeforeCreateHook(value: unknown): value is RuntimeBeforeCreateHook {
  return (
    typeof value === "object" &&
    value !== null &&
    "beforeCreate" in value &&
    typeof value.beforeCreate === "function"
  );
}

function postgresContractError(options: {
  readonly collection: string;
  readonly operation: StoreCollectionOperation;
  readonly violation:
    | "unknown-record-key"
    | "invalid-selected-record"
    | "generated-value-overwrite"
    | "invalid-column-encoding";
  readonly writesMayRemain: boolean;
  readonly cause?: unknown;
  readonly field?: string;
}): StoreAdapterContractError {
  return new StoreAdapterContractError({
    collection: options.collection,
    operation: options.operation,
    violation: options.violation,
    writesMayRemain: options.writesMayRemain,
    ...(Object.hasOwn(options, "cause") ? { cause: options.cause } : {}),
    ...(options.field === undefined ? {} : { field: options.field }),
  });
}

async function callPostgresCollection<Result>(options: {
  readonly collection: string;
  readonly operation: StoreCollectionOperation;
  readonly writesMayRemain: boolean;
  readonly call: () => PromiseLike<Result>;
}): Promise<Result> {
  try {
    return await options.call();
  } catch (cause) {
    throw new StoreAdapterError({
      collection: options.collection,
      operation: options.operation,
      writesMayRemain: options.writesMayRemain,
      cause,
    });
  }
}

function requireReturnedRows(
  value: unknown,
  collection: string,
  operation: StoreCollectionOperation,
  writesMayRemain: boolean,
): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw postgresContractError({
      collection,
      operation,
      violation: "invalid-selected-record",
      writesMayRemain,
    });
  }
  return value;
}

async function parsePostgresSelectedRecord<Definition extends RecordDefinition>(options: {
  readonly collection: string;
  readonly definition: Definition;
  readonly operation: StoreCollectionOperation;
  readonly selection: PostgresRecordSelection;
  readonly value: unknown;
  readonly writesMayRemain: boolean;
}): Promise<SelectedRecord<Definition>> {
  try {
    let value = options.value;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const fieldName of options.selection.fieldNames) {
        if (!Object.hasOwn(value, fieldName)) {
          throw new TypeError(`PostgreSQL result is missing Record field '${fieldName}'`);
        }
      }
      const normalized: Record<string, unknown> = { ...value };
      for (const field of options.selection.privateFields) delete normalized[field];
      for (const [fieldName, field] of Object.entries(options.definition.fields)) {
        const driverValue = Reflect.get(value, fieldName);
        if (driverValue !== null && Object.hasOwn(options.selection.columns, fieldName)) {
          try {
            normalized[fieldName] =
              options.selection.columns[fieldName]?.mapFromDriverValue(driverValue);
          } catch (cause) {
            throw postgresContractError({
              collection: options.collection,
              operation: options.operation,
              violation: "invalid-selected-record",
              writesMayRemain: options.writesMayRemain,
              field: fieldName,
              cause,
            });
          }
          continue;
        }
        if (driverValue !== null) continue;
        const select = "~standard" in field ? field : field.select;
        const jsonNullMarker = options.selection.jsonNullMarkers[fieldName];
        if (jsonNullMarker !== undefined && Reflect.get(value, jsonNullMarker) === true) {
          const missingResult = await select["~standard"].validate(undefined);
          if (missingResult.issues === undefined) delete normalized[fieldName];
          continue;
        }
        const nullResult = await select["~standard"].validate(null);
        if (nullResult.issues === undefined) continue;
        const missingResult = await select["~standard"].validate(undefined);
        if (missingResult.issues === undefined) delete normalized[fieldName];
      }
      value = normalized;
    }
    const allFields = Object.keys(options.definition.fields);
    const parsed =
      options.selection.fieldNames.length === allFields.length
        ? await parseStoreSelectedRecord(options.definition, options.collection, value)
        : await parseStoreSelectedFields(
            options.definition,
            options.collection,
            value,
            options.selection.fieldNames,
          );
    // SAFETY: Callers access only selection.fieldNames; complete selections use every Definition field.
    return parsed as SelectedRecord<Definition>;
  } catch (cause) {
    if (cause instanceof StoreAdapterContractError) throw cause;
    throw postgresContractError({
      collection: options.collection,
      operation: options.operation,
      violation:
        cause instanceof StoreValidationError && cause.issues[0]?.message.includes("Unknown Record")
          ? "unknown-record-key"
          : "invalid-selected-record",
      writesMayRemain: options.writesMayRemain,
      cause,
    });
  }
}

function selectedProjection<Definition extends RecordDefinition>(
  record: SelectedRecord<Definition>,
  fields: readonly string[],
): JsonObject {
  const output: Record<string, JsonValue> = {};
  for (const field of fields) {
    const value = Reflect.get(record, field);
    if (value !== undefined) {
      // SAFETY: Every selected Record value passed its Field Schema and is JSON-compatible.
      output[field] = value as JsonValue;
    }
  }
  return output;
}

function validatePostgresExpressionFields(
  collection: string,
  definition: RecordDefinition,
  operation: Exclude<StoreCollectionOperation, "create">,
  fields: Iterable<string>,
): void {
  for (const field of fields) {
    if (Object.hasOwn(definition.fields, field)) continue;
    throw new StoreValidationError({
      collection,
      operation,
      phase: "query",
      field,
      issues: [{ message: `Unknown Record field '${field}'`, path: [field] }],
    });
  }
}

function primaryKeyColumns(table: AnyPgTable): readonly AnyPgColumn[] {
  const config = getPostgresTableConfig(table);
  const tableColumns = Object.values(getTableColumns(table));
  const declared =
    config.primaryKeys[0]?.columns ?? config.columns.filter((column) => column.primary);
  return declared.flatMap((column) => {
    const tableColumn = tableColumns.find(
      (candidate) => candidate === column || candidate.name === column.name,
    );
    return tableColumn === undefined ? [] : [tableColumn];
  });
}

function postgresPrivateSelectionName(usedNames: Set<string>, stem: string): string {
  let name = `__commissary${stem}`;
  while (usedNames.has(name)) name = `_${name}`;
  usedNames.add(name);
  return name;
}

function postgresRecordSelection(
  table: AnyPgTable,
  definition: RecordDefinition,
  selectedFields: readonly string[] = Object.keys(definition.fields),
): PostgresRecordSelection {
  const columns = getTableColumns(table);
  const usedNames = new Set(Object.keys(columns));
  const fieldNames = Object.freeze([...new Set(selectedFields)]);
  const fields: Record<string, unknown> = {};
  const selectedColumns: Record<string, AnyPgColumn> = {};
  const jsonNullMarkers: Record<string, string> = {};
  const privateFields: string[] = [];
  for (const fieldName of fieldNames) {
    const column = columns[fieldName];
    if (column === undefined || !Object.hasOwn(definition.fields, fieldName)) {
      throw new TypeError(`PostgreSQL table is missing Record field '${fieldName}'`);
    }
    fields[fieldName] = sql<unknown>`${column}`;
    selectedColumns[fieldName] = column;
    const sqlType = column.getSQLType().toLowerCase();
    if (sqlType !== "json" && sqlType !== "jsonb") continue;
    const marker = postgresPrivateSelectionName(usedNames, `JsonSqlNull${fieldName}`);
    fields[marker] = sql<boolean>`${column} IS NULL`;
    jsonNullMarkers[fieldName] = marker;
    privateFields.push(marker);
  }
  if (fieldNames.length === 0) {
    const marker = postgresPrivateSelectionName(usedNames, "Projection");
    fields[marker] = sql<number>`1`;
    privateFields.push(marker);
  }
  return {
    columns: Object.freeze(selectedColumns),
    fields: Object.freeze(fields),
    fieldNames,
    jsonNullMarkers: Object.freeze(jsonNullMarkers),
    privateFields: Object.freeze(privateFields),
  };
}

function postgresCandidateSelection(
  table: AnyPgTable,
  definition: RecordDefinition,
): PostgresCandidateSelection {
  const recordSelection = postgresRecordSelection(table, definition);
  const usedNames = new Set(Object.keys(recordSelection.fields));
  const fields: Record<string, unknown> = { ...recordSelection.fields };
  const keyColumns = primaryKeyColumns(table);
  const xmin = postgresPrivateSelectionName(usedNames, "Xmin");
  fields[xmin] = sql<string>`xmin::text`;
  if (keyColumns.length > 0) {
    return {
      ...recordSelection,
      fields: Object.freeze(fields),
      identityFields: Object.freeze({ xmin }),
    };
  }
  const tableOid = postgresPrivateSelectionName(usedNames, "TableOid");
  const tupleId = postgresPrivateSelectionName(usedNames, "TupleId");
  fields[tableOid] = sql<string>`tableoid::text`;
  fields[tupleId] = sql<string>`ctid::text`;
  return {
    ...recordSelection,
    fields: Object.freeze(fields),
    identityFields: Object.freeze({ tableOid, tupleId, xmin }),
  };
}

function readIdentityText(value: object, property: string): string | undefined {
  const child = Reflect.get(value, property);
  return typeof child === "string" && child.length > 0 ? child : undefined;
}

function readPostgresCandidateIdentity(
  row: object,
  table: AnyPgTable,
  record: Readonly<Record<string, unknown>>,
  identityFields: PostgresCandidateSelection["identityFields"],
): PostgresCandidateIdentity | undefined {
  const xmin = readIdentityText(row, identityFields.xmin);
  if (xmin === undefined) return undefined;
  const columns = primaryKeyColumns(table);
  if (columns.length > 0) {
    const logicalColumns = getTableColumns(table);
    const values = columns.map((column) => {
      const entry = Object.entries(logicalColumns).find(([, value]) => value === column);
      return entry === undefined ? undefined : Reflect.get(record, entry[0]);
    });
    if (values.some((value) => value === undefined)) return undefined;
    return { kind: "primary-key", columns, values, xmin };
  }
  const tableOid =
    identityFields.tableOid === undefined
      ? undefined
      : readIdentityText(row, identityFields.tableOid);
  const tupleId =
    identityFields.tupleId === undefined
      ? undefined
      : readIdentityText(row, identityFields.tupleId);
  return tableOid === undefined || tupleId === undefined
    ? undefined
    : { kind: "physical-row", tableOid, tupleId, xmin };
}

function postgresCandidateGuard(identity: PostgresCandidateIdentity): SQL {
  if (identity.kind === "physical-row") {
    const guard = and(
      sql`tableoid = ${identity.tableOid}::oid`,
      sql`ctid = ${identity.tupleId}::tid`,
      sql`xmin = ${identity.xmin}::xid`,
    );
    if (guard === undefined) throw new TypeError("PostgreSQL physical row guard is empty");
    return guard;
  }
  const guard = and(
    ...identity.columns.map(
      (column, index) => sql`${column} = ${sql.param(identity.values[index])}`,
    ),
    sql`xmin = ${identity.xmin}::xid`,
  );
  if (guard === undefined) throw new TypeError("PostgreSQL primary-key row guard is empty");
  return guard;
}

function encodePostgresWriteValue(options: {
  readonly collection: string;
  readonly operation: "create" | "update";
  readonly column: AnyPgColumn | undefined;
  readonly field: string;
  readonly value: unknown;
  readonly writesMayRemain: boolean;
}): SQL {
  if (options.column === undefined) {
    throw postgresContractError({
      collection: options.collection,
      operation: options.operation,
      violation: "invalid-column-encoding",
      writesMayRemain: options.writesMayRemain,
      field: options.field,
    });
  }
  try {
    if (options.value === null) {
      const sqlType = options.column.getSQLType().toLowerCase();
      if (sqlType !== "json" && sqlType !== "jsonb") return sql`${null}`;
    }
    const encoded = options.column.mapToDriverValue(options.value);
    return sql`${sql.param(encoded)}`;
  } catch (cause) {
    throw postgresContractError({
      collection: options.collection,
      operation: options.operation,
      violation: "invalid-column-encoding",
      writesMayRemain: options.writesMayRemain,
      field: options.field,
      cause,
    });
  }
}

async function readPostgresCandidates<Definition extends RecordDefinition>(options: {
  readonly collection: string;
  readonly database: PostgresCollectionDatabase;
  readonly definition: Definition;
  readonly table: AnyPgTable;
  readonly operation: "update" | "delete";
}): Promise<readonly PostgresCandidate<Definition>[]> {
  const selection = postgresCandidateSelection(options.table, options.definition);
  const result = await callPostgresCollection({
    collection: options.collection,
    operation: options.operation,
    writesMayRemain: false,
    call: () => options.database.select(selection.fields).from(options.table),
  });
  const rows = requireReturnedRows(result, options.collection, options.operation, false);
  const candidates: PostgresCandidate<Definition>[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw postgresContractError({
        collection: options.collection,
        operation: options.operation,
        violation: "invalid-selected-record",
        writesMayRemain: false,
      });
    }
    const rawRecord = Object.fromEntries(
      [
        ...Object.keys(options.definition.fields),
        ...Object.values(selection.jsonNullMarkers),
      ].flatMap((field) => (Object.hasOwn(row, field) ? [[field, Reflect.get(row, field)]] : [])),
    );
    const record = await parsePostgresSelectedRecord({
      collection: options.collection,
      definition: options.definition,
      operation: options.operation,
      selection,
      value: rawRecord,
      writesMayRemain: false,
    });
    const identity = readPostgresCandidateIdentity(
      row,
      options.table,
      rawRecord,
      selection.identityFields,
    );
    if (identity === undefined) {
      throw postgresContractError({
        collection: options.collection,
        operation: options.operation,
        violation: "invalid-selected-record",
        writesMayRemain: false,
      });
    }
    candidates.push({ record, identity });
  }
  return candidates;
}

function createPostgresCollection<
  Definition extends RecordDefinition,
  Create extends object,
>(options: {
  readonly collection: string;
  readonly database: PostgresCollectionDatabase;
  readonly definition: Definition;
  readonly hook: unknown;
  readonly table: AnyPgTable;
  readonly track: TrackTransactionOperation;
}): Collection<Definition, BaseStoreOperatorTypes, Create> {
  const find: Collection<Definition, BaseStoreOperatorTypes, Create>["find"] = <
    const Select extends Selection<SelectedRecord<Definition>> | undefined = undefined,
  >(
    input?: Parameters<Collection<Definition, BaseStoreOperatorTypes, Create>["find"]>[0],
  ) =>
    options.track(async (): Promise<readonly Project<SelectedRecord<Definition>, Select>[]> => {
      const { limit, offset } = validateStoreFindPagination(options.collection, input);
      const matches = compileStoreWhere(options.collection, input?.where);
      const compare = compileStoreOrder(options.collection, input?.orderBy);
      const selection = input?.select;
      const outputFields =
        selection === undefined
          ? Object.keys(options.definition.fields)
          : Object.entries(selection).map(([field, selected]) => {
              if (!Object.hasOwn(options.definition.fields, field) || selected !== true) {
                throw new StoreValidationError({
                  collection: options.collection,
                  operation: "find",
                  phase: "query",
                  field,
                  issues: [{ message: `Invalid selected Record field '${field}'`, path: [field] }],
                });
              }
              return field;
            });
      const queryFields = Object.freeze([
        ...new Set([...matches.fields, ...(compare?.fields ?? []), ...outputFields]),
      ]);
      validatePostgresExpressionFields(options.collection, options.definition, "find", queryFields);
      const recordSelection = postgresRecordSelection(
        options.table,
        options.definition,
        queryFields,
      );
      const result = await callPostgresCollection({
        collection: options.collection,
        operation: "find",
        writesMayRemain: false,
        call: () => options.database.select(recordSelection.fields).from(options.table),
      });
      const records = await Promise.all(
        requireReturnedRows(result, options.collection, "find", false).map((value) =>
          parsePostgresSelectedRecord({
            collection: options.collection,
            definition: options.definition,
            operation: "find",
            selection: recordSelection,
            value,
            writesMayRemain: false,
          }),
        ),
      );
      const filtered = records.filter(matches);
      if (compare !== undefined) filtered.sort(compare);
      const page = filtered.slice(offset, limit === undefined ? undefined : offset + limit);
      const projected = page.map((record) => selectedProjection(record, outputFields));
      // SAFETY: outputFields contains exactly the requested Definition keys and each value passed its Select Field Schema.
      return projected as unknown as readonly Project<SelectedRecord<Definition>, Select>[];
    });

  const create: Collection<Definition, BaseStoreOperatorTypes, Create>["create"] = (input) =>
    options.track(async () => {
      let draft: unknown = input;
      if (isRuntimeBeforeCreateHook(options.hook)) {
        let patch: unknown;
        try {
          patch = options.hook.beforeCreate({ draft: input });
        } catch (cause) {
          throw new StoreHookError(options.collection, cause);
        }
        if (typeof patch === "object" && patch !== null && !Array.isArray(patch)) {
          draft = { ...input, ...patch };
        } else {
          draft = patch;
        }
      }
      const created = await parseStoreCreateInput(options.definition, options.collection, draft);
      const columns = getTableColumns(options.table);
      for (const field of Object.keys(created)) {
        const column = Reflect.get(columns, field);
        if (column?.generated !== undefined) {
          throw postgresContractError({
            collection: options.collection,
            operation: "create",
            violation: "generated-value-overwrite",
            writesMayRemain: false,
          });
        }
      }
      let selectedCreated: JsonObject;
      try {
        selectedCreated = await parseStoreSelectedFields(
          options.definition,
          options.collection,
          created,
          Object.keys(created),
        );
      } catch (cause) {
        throw postgresContractError({
          collection: options.collection,
          operation: "create",
          violation: "invalid-selected-record",
          writesMayRemain: false,
          cause,
        });
      }
      let insert = options.database.insert(options.table);
      if (
        Object.keys(created).some(
          (field) => Reflect.get(columns, field)?.generatedIdentity?.type === "always",
        )
      ) {
        insert = insert.overridingSystemValue();
      }
      const encodedCreated = Object.fromEntries(
        Object.entries(selectedCreated).map(([field, value]) => [
          field,
          encodePostgresWriteValue({
            collection: options.collection,
            operation: "create",
            column: columns[field],
            field,
            value,
            writesMayRemain: false,
          }),
        ]),
      );
      const recordSelection = postgresRecordSelection(options.table, options.definition);
      const result = await callPostgresCollection({
        collection: options.collection,
        operation: "create",
        writesMayRemain: true,
        call: () => insert.values(encodedCreated).returning(recordSelection.fields),
      });
      const rows = requireReturnedRows(result, options.collection, "create", true);
      if (rows.length !== 1) {
        throw postgresContractError({
          collection: options.collection,
          operation: "create",
          violation: "invalid-selected-record",
          writesMayRemain: true,
        });
      }
      return parsePostgresSelectedRecord({
        collection: options.collection,
        definition: options.definition,
        operation: "create",
        selection: recordSelection,
        value: rows[0],
        writesMayRemain: true,
      });
    });

  const update: Collection<Definition, BaseStoreOperatorTypes, Create>["update"] = (input) =>
    options.track(async () => {
      const matches = compileStoreWhere(options.collection, input.where, "update");
      const updateValue = await compileStoreUpdate(
        options.definition,
        options.collection,
        input.set,
      );
      validatePostgresExpressionFields(options.collection, options.definition, "update", [
        ...matches.fields,
        ...updateValue.fields,
      ]);
      const allCandidates = await readPostgresCandidates({
        collection: options.collection,
        database: options.database,
        definition: options.definition,
        table: options.table,
        operation: "update",
      });
      const matching = allCandidates.filter(({ record }) => matches(record));
      const recordSelection = postgresRecordSelection(options.table, options.definition);
      let completed = 0;
      for (const candidate of matching) {
        // SAFETY: Candidate records have only JSON values produced by Select Field Schemas.
        const changes = updateValue.evaluate(candidate.record as unknown as JsonObject);
        const changed: Record<string, JsonValue> = {};
        for (const [field, value] of Object.entries(candidate.record)) {
          if (value !== undefined) {
            // SAFETY: Every selected Record value passed a Field Schema whose output is JSON-compatible.
            changed[field] = value as JsonValue;
          }
        }
        for (const field of updateValue.changedFields) {
          if (Object.hasOwn(changes, field)) {
            // SAFETY: The compiled update evaluator produces only validated JSON expression values.
            changed[field] = Reflect.get(changes, field) as JsonValue;
          } else delete changed[field];
        }
        const selectedChanged = await parseStoreUpdatedRecord(
          options.definition,
          options.collection,
          changed,
        );
        const encodedChanges: Record<string, unknown> = {};
        const columns = getTableColumns(options.table);
        for (const field of updateValue.changedFields) {
          encodedChanges[field] = Object.hasOwn(selectedChanged, field)
            ? encodePostgresWriteValue({
                collection: options.collection,
                operation: "update",
                column: columns[field],
                field,
                value: Reflect.get(selectedChanged, field),
                writesMayRemain: completed > 0,
              })
            : null;
        }
        const result = await callPostgresCollection({
          collection: options.collection,
          operation: "update",
          writesMayRemain: true,
          call: () =>
            options.database
              .update(options.table)
              .set(encodedChanges)
              .where(postgresCandidateGuard(candidate.identity))
              .returning(recordSelection.fields),
        });
        const rows = requireReturnedRows(result, options.collection, "update", true);
        if (rows.length === 0) {
          throw new StoreAdapterError({
            collection: options.collection,
            operation: "update",
            cause: new Error("Drizzle PostgreSQL candidate changed before guarded update"),
            writesMayRemain: completed > 0,
          });
        }
        if (rows.length !== 1) {
          throw postgresContractError({
            collection: options.collection,
            operation: "update",
            violation: "invalid-selected-record",
            writesMayRemain: true,
          });
        }
        await parsePostgresSelectedRecord({
          collection: options.collection,
          definition: options.definition,
          operation: "update",
          selection: recordSelection,
          value: rows[0],
          writesMayRemain: true,
        });
        completed += 1;
      }
      return completed;
    });

  const deleteRecords: Collection<Definition, BaseStoreOperatorTypes, Create>["delete"] = (input) =>
    options.track(async () => {
      const matches = compileStoreWhere(options.collection, input?.where, "delete");
      validatePostgresExpressionFields(
        options.collection,
        options.definition,
        "delete",
        matches.fields,
      );
      const candidates = (
        await readPostgresCandidates({
          collection: options.collection,
          database: options.database,
          definition: options.definition,
          table: options.table,
          operation: "delete",
        })
      ).filter(({ record }) => matches(record));
      let completed = 0;
      for (const candidate of candidates) {
        const result = await callPostgresCollection({
          collection: options.collection,
          operation: "delete",
          writesMayRemain: true,
          call: () =>
            options.database
              .delete(options.table)
              .where(postgresCandidateGuard(candidate.identity))
              .returning(),
        });
        const rows = requireReturnedRows(result, options.collection, "delete", true);
        if (rows.length === 0) {
          throw new StoreAdapterError({
            collection: options.collection,
            operation: "delete",
            cause: new Error("Drizzle PostgreSQL candidate changed before guarded delete"),
            writesMayRemain: completed > 0,
          });
        }
        if (rows.length !== 1) {
          throw postgresContractError({
            collection: options.collection,
            operation: "delete",
            violation: "invalid-selected-record",
            writesMayRemain: true,
          });
        }
        completed += 1;
      }
      return completed;
    });

  const count: Collection<Definition, BaseStoreOperatorTypes, Create>["count"] = (input) =>
    options.track(async () => {
      const matches = compileStoreWhere(options.collection, input?.where, "count");
      validatePostgresExpressionFields(
        options.collection,
        options.definition,
        "count",
        matches.fields,
      );
      const recordSelection = postgresRecordSelection(
        options.table,
        options.definition,
        matches.fields,
      );
      const result = await callPostgresCollection({
        collection: options.collection,
        operation: "count",
        writesMayRemain: false,
        call: () => options.database.select(recordSelection.fields).from(options.table),
      });
      const records = await Promise.all(
        requireReturnedRows(result, options.collection, "count", false).map((value) =>
          parsePostgresSelectedRecord({
            collection: options.collection,
            definition: options.definition,
            operation: "count",
            selection: recordSelection,
            value,
            writesMayRemain: false,
          }),
        ),
      );
      return records.filter(matches).length;
    });

  return Object.freeze({ find, create, update, delete: deleteRecords, count });
}

/** Build every Collection over one active PostgreSQL database view. */
export function createPostgresCollections<
  Definitions extends RecordDefinitions,
  CreateInputs extends StoreCreateInputMap<Definitions>,
>(
  database: PostgresCollectionDatabase,
  state: PostgresCollectionDefinitionState,
  track: TrackTransactionOperation = runPostgresStoreOperation,
): StoreCollections<Definitions, BaseStoreOperatorTypes, CreateInputs> {
  const collections: Record<
    string,
    Collection<RecordDefinition, BaseStoreOperatorTypes, object>
  > = {};
  for (const [name, definition] of Object.entries(state.definitions)) {
    const table = state.tables[name];
    if (table === undefined) {
      throw new StoreAdapterContractError({
        collection: name,
        operation: "find",
        violation: "invalid-catalog-state",
        writesMayRemain: false,
      });
    }
    collections[name] = createPostgresCollection({
      collection: name,
      database,
      definition,
      hook: state.hooks[name],
      table,
      track,
    });
  }
  // SAFETY: The loop creates one Collection from the matching Definition and table for every retained catalog key.
  return Object.freeze(collections) as unknown as StoreCollections<
    Definitions,
    BaseStoreOperatorTypes,
    CreateInputs
  >;
}
