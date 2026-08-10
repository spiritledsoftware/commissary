import { composeThreadStoreRecordDefinitions, createThreadStore } from "@commissary/core";
import type {
  Clock,
  CoreRecordDefinitions,
  ContributedThreadRecordDefinitions,
  EffectiveRecordDefinitions,
  ThreadStore,
  ThreadStoreFactoryConfig,
  ThreadStoreHooks,
  ThreadRecordDefinitions,
} from "@commissary/core";
import {
  compileStoreOrder,
  compileStoreUpdate,
  compileStoreWhere,
  parseStoreCreatedRecord,
  parseStoreCreateInput,
  parseStoreSelectedFields,
  StoreAdapterContractError,
  StoreValidationError,
  TransactionRollbackError,
  type CountOptions,
  type CompiledStoreUpdate,
  type Collection,
  type CreateInput,
  type DeleteOptions,
  type BaseStoreOperatorTypes,
  type FindOptions,
  type JsonObject,
  type JsonValue,
  type RecordDefinition,
  type Project,
  type RecordOverrides,
  type RecordDefinitions,
  type RoundTripRecordDefinitions,
  type Selection,
  type SelectedRecord,
  type StoreCollectionOperation,
  type StoreCollections,
  type TransactionStore,
  type StoreWhereEvaluator,
  parseStoreUpdatedRecord,
  validateStoreFindPagination,
  type UpdateOptions,
  type WhereOptions,
} from "@commissary/store";
import {
  runTransactionCallback,
  type TrackTransactionOperation,
} from "@commissary/store/transaction-adapter";

/** Configuration for one generic process-local Store. */
export interface MemoryStoreOptions<Definitions extends RecordDefinitions> {
  /** Complete Custom Record catalog exposed by the returned Store. */
  readonly records: Definitions & RoundTripRecordDefinitions<Definitions>;
}

class MemoryTransactionLock {
  #locked = false;
  readonly #waiters: Array<() => void> = [];

  async run<Value>(use: () => Promise<Value>): Promise<Value> {
    await this.#acquire();
    try {
      return await use();
    } finally {
      this.#release();
    }
  }

  async #acquire(): Promise<void> {
    if (!this.#locked) {
      this.#locked = true;
      return;
    }
    await new Promise<void>((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  #release(): void {
    const next = this.#waiters.shift();
    if (next === undefined) {
      this.#locked = false;
      return;
    }
    next();
  }
}

class MemoryTransactionJournal {
  readonly #undoOperations: Array<() => void> = [];

  record(undo: () => void): void {
    this.#undoOperations.push(undo);
  }

  rollback(): void {
    for (let index = this.#undoOperations.length - 1; index >= 0; index -= 1) {
      this.#undoOperations[index]?.();
    }
  }
}

function requireMemoryValue<Value>(value: Value | undefined, description: string): Value {
  if (value === undefined) {
    throw new StoreAdapterContractError({
      operation: "transaction",
      violation: "transaction-contract",
      writesMayRemain: false,
      cause: new Error(`Memory Store state is missing ${description}`),
    });
  }
  return value;
}

function cloneMemoryJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(cloneMemoryJsonValue);
  }
  if (value !== null && typeof value === "object") {
    const cloned: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      cloned[key] = cloneMemoryJsonValue(child);
    }
    return cloned;
  }
  return value;
}

function cloneMemoryJsonObject(value: JsonObject): JsonObject {
  // SAFETY: cloneMemoryJsonValue preserves object roots and recursively copies only JSON values.
  return cloneMemoryJsonValue(value) as JsonObject;
}

function cloneMemorySelectedRecord<Definition extends RecordDefinition>(
  value: JsonObject | SelectedRecord<Definition>,
): JsonObject & SelectedRecord<Definition> {
  // SAFETY: Every selected Field output is JSON-compatible. Cloning preserves the selected Record shape.
  return cloneMemoryJsonObject(value as JsonObject) as JsonObject & SelectedRecord<Definition>;
}

class MemoryCollection<Definition extends RecordDefinition> implements Collection<Definition> {
  readonly #definition: Definition;
  readonly #name: string;
  readonly #records: JsonObject[];
  readonly #transactionJournal: MemoryTransactionJournal | undefined;

  constructor(
    name: string,
    definition: Definition,
    records: JsonObject[],
    transactionJournal?: MemoryTransactionJournal,
  ) {
    this.#name = name;
    this.#definition = definition;
    this.#records = records;
    this.#transactionJournal = transactionJournal;
  }

  #recordUndo(undo: () => void): void {
    this.#transactionJournal?.record(undo);
  }

  #assertKnownFields(fields: Iterable<string>, operation: StoreCollectionOperation): void {
    for (const field of fields) {
      if (!Object.hasOwn(this.#definition.fields, field)) {
        throw new StoreValidationError({
          collection: this.#name,
          operation,
          phase: "query",
          field,
          issues: [{ message: `Unknown Record field '${field}'`, path: [field] }],
        });
      }
    }
  }

  async #parseSelectedFields(
    record: JsonObject,
    fields: readonly string[],
    operation: StoreCollectionOperation,
  ): Promise<SelectedRecord<Definition>> {
    for (const field of Object.keys(record)) {
      if (!Object.hasOwn(this.#definition.fields, field)) {
        throw new StoreAdapterContractError({
          collection: this.#name,
          operation,
          violation: "unknown-record-key",
          writesMayRemain: false,
          field,
        });
      }
    }
    const rawFields: Record<string, JsonValue> = {};
    for (const field of fields) {
      const value = Reflect.get(record, field);
      if (value !== undefined) {
        rawFields[field] = value;
      }
    }
    try {
      const parsed = await parseStoreSelectedFields(
        this.#definition,
        this.#name,
        rawFields,
        fields,
      );
      // SAFETY: Callers expose only the requested fields. Full-result callers request every definition field.
      return cloneMemorySelectedRecord<Definition>(parsed);
    } catch (cause) {
      throw new StoreAdapterContractError({
        collection: this.#name,
        operation,
        violation: "invalid-selected-record",
        writesMayRemain: false,
        ...(cause instanceof StoreValidationError && cause.field !== undefined
          ? { field: cause.field }
          : {}),
        cause,
      });
    }
  }

  async #matchingRecords(
    matches: StoreWhereEvaluator<SelectedRecord<Definition>>,
    operation: "update" | "delete" | "count",
    additionalFields: readonly string[] = [],
  ): Promise<
    readonly {
      readonly index: number;
      readonly record: SelectedRecord<Definition>;
    }[]
  > {
    const fields = Object.freeze([...new Set([...matches.fields, ...additionalFields])]);
    this.#assertKnownFields(fields, operation);
    const parsed = await Promise.all(
      this.#records.map((record) => this.#parseSelectedFields(record, fields, operation)),
    );
    return parsed.flatMap((record, index) => (matches(record) ? [{ index, record }] : []));
  }

  async #matchingIndexes(
    options: WhereOptions<SelectedRecord<Definition>, BaseStoreOperatorTypes> | undefined,
    operation: "delete" | "count",
  ): Promise<number[]> {
    const matches = compileStoreWhere(this.#name, options?.where, operation);
    const matching = await this.#matchingRecords(matches, operation);
    return matching.map(({ index }) => index);
  }

  readonly create = async (input: CreateInput<Definition>): Promise<SelectedRecord<Definition>> => {
    const created = await parseStoreCreateInput(this.#definition, this.#name, input);
    const selected = await parseStoreCreatedRecord(this.#definition, this.#name, created);
    const stored = cloneMemorySelectedRecord<Definition>(selected);
    this.#records.push(stored);
    const index = this.#records.length - 1;
    this.#recordUndo(() => {
      this.#records.splice(index, 1);
    });
    return cloneMemorySelectedRecord<Definition>(selected);
  };

  readonly find = async <
    const Select extends Selection<SelectedRecord<Definition>> | undefined = undefined,
  >(
    options?: FindOptions<SelectedRecord<Definition>, Select, BaseStoreOperatorTypes>,
  ): Promise<readonly Project<SelectedRecord<Definition>, Select>[]> => {
    const { limit, offset } = validateStoreFindPagination(this.#name, options);
    const matches = compileStoreWhere(this.#name, options?.where);
    const compare = compileStoreOrder(this.#name, options?.orderBy);
    const selection = options?.select;
    const outputFields =
      selection === undefined
        ? Object.keys(this.#definition.fields)
        : Object.entries(selection).map(([field, selected]) => {
            if (selected !== true) {
              throw new StoreValidationError({
                collection: this.#name,
                operation: "find",
                phase: "query",
                field,
                issues: [{ message: "Selection values must be true", path: [field] }],
              });
            }
            return field;
          });
    const queryFields = [...new Set([...matches.fields, ...(compare?.fields ?? [])])];
    const queryFieldSet = new Set(queryFields);
    const remainingOutputFields = outputFields.filter((field) => !queryFieldSet.has(field));
    this.#assertKnownFields([...queryFields, ...outputFields], "find");
    const queried = await Promise.all(
      this.#records.map(async (rawRecord) => ({
        rawRecord,
        queryRecord:
          queryFields.length === 0
            ? // SAFETY: Compiled query evaluators with no referenced fields cannot read this empty projection.
              ({} as SelectedRecord<Definition>)
            : await this.#parseSelectedFields(rawRecord, queryFields, "find"),
      })),
    );
    const filtered = queried.filter((candidate) => matches(candidate.queryRecord));
    if (compare !== undefined) {
      filtered.sort((left, right) => compare(left.queryRecord, right.queryRecord));
    }
    const page = filtered.slice(offset, limit === undefined ? undefined : offset + limit);
    const selected = await Promise.all(
      page.map(async ({ rawRecord, queryRecord }) => {
        const remaining =
          remainingOutputFields.length === 0
            ? // SAFETY: No remaining output field can be read from this empty projection.
              ({} as SelectedRecord<Definition>)
            : await this.#parseSelectedFields(rawRecord, remainingOutputFields, "find");
        // SAFETY: Both projections contain only JSON values produced by the Record Field Schemas.
        const parsedFields = { ...queryRecord, ...remaining } as JsonObject;
        const output: Record<string, JsonValue> = {};
        for (const field of outputFields) {
          const value = parsedFields[field];
          if (value !== undefined) {
            output[field] = value;
          }
        }
        return output;
      }),
    );
    // SAFETY: Every returned object includes exactly the requested, validated output fields.
    return selected as unknown as readonly Project<SelectedRecord<Definition>, Select>[];
  };

  readonly update = async (
    input: UpdateOptions<Definition, BaseStoreOperatorTypes>,
  ): Promise<number> => {
    // Compile the query first so invalid where input has consistent precedence for every set form.
    const matches = compileStoreWhere(this.#name, input.where, "update");
    const update: CompiledStoreUpdate = await compileStoreUpdate(
      this.#definition,
      this.#name,
      input.set,
    );
    const matching = await this.#matchingRecords(matches, "update", update.fields);
    const candidates: { readonly index: number; readonly record: JsonObject }[] = [];
    for (const { index, record } of matching) {
      // SAFETY: #matchingRecords parsed every field referenced by the compiled update expression.
      const changes = update.evaluate(record as unknown as JsonObject);
      const candidate: Record<string, JsonValue> = {
        ...requireMemoryValue(this.#records[index], `update-record-${index}`),
      };
      for (const field of update.changedFields) {
        if (Object.hasOwn(changes, field)) {
          // SAFETY: The compiled update evaluator returns only JSON-compatible changed Field values.
          candidate[field] = Reflect.get(changes, field) as JsonValue;
        } else {
          delete candidate[field];
        }
      }
      candidates.push({ index, record: candidate });
    }
    const selectedCandidates = await Promise.all(
      candidates.map(async ({ index, record }) => ({
        index,
        record: await parseStoreUpdatedRecord(this.#definition, this.#name, record),
      })),
    );
    const previous = selectedCandidates.map(({ index }) => ({
      index,
      record: requireMemoryValue(this.#records[index], `update-record-${index}`),
    }));
    this.#recordUndo(() => {
      for (const item of previous) {
        this.#records[item.index] = item.record;
      }
    });
    for (const candidate of selectedCandidates) {
      this.#records[candidate.index] = cloneMemorySelectedRecord<Definition>(candidate.record);
    }
    return matching.length;
  };

  readonly delete = async (
    input?: DeleteOptions<SelectedRecord<Definition>, BaseStoreOperatorTypes>,
  ): Promise<number> => {
    const indexes = await this.#matchingIndexes(input, "delete");
    const removed = indexes.map((index) => ({
      index,
      record: requireMemoryValue(this.#records[index], `delete-record-${index}`),
    }));
    this.#recordUndo(() => {
      for (const item of removed) {
        this.#records.splice(item.index, 0, item.record);
      }
    });
    for (let position = indexes.length - 1; position >= 0; position -= 1) {
      const index = requireMemoryValue(indexes[position], `delete-index-${position}`);
      this.#records.splice(index, 1);
    }
    return indexes.length;
  };

  readonly count = async (
    input?: CountOptions<SelectedRecord<Definition>, BaseStoreOperatorTypes>,
  ): Promise<number> => (await this.#matchingIndexes(input, "count")).length;
}

function runMemoryStoreOperation<Value>(start: () => Promise<Value>): Promise<Value> {
  return Promise.resolve().then(start);
}

function lockMemoryCollection<Definition extends RecordDefinition>(
  collection: Collection<Definition>,
  lock: MemoryTransactionLock,
  track: TrackTransactionOperation = runMemoryStoreOperation,
): Collection<Definition> {
  const find: Collection<Definition>["find"] = (options) =>
    track(() => lock.run(() => collection.find(options)));
  const create: Collection<Definition>["create"] = (input) =>
    track(() => lock.run(() => collection.create(input)));
  const update: Collection<Definition>["update"] = (input) =>
    track(() => lock.run(() => collection.update(input)));
  const deleteRecords: Collection<Definition>["delete"] = (input) =>
    track(() => lock.run(() => collection.delete(input)));
  const count: Collection<Definition>["count"] = (input) =>
    track(() => lock.run(() => collection.count(input)));
  return Object.freeze({
    find,
    create,
    update,
    delete: deleteRecords,
    count,
  });
}

/** Generic process-local Transaction Store for tests, examples, and local development. */
export class MemoryStore {
  /** Make a Transaction Store whose Collection Map exactly matches the supplied Record catalog. */
  static make<const Definitions extends RecordDefinitions>(
    options: MemoryStoreOptions<Definitions>,
  ): TransactionStore<Definitions> {
    const lock = new MemoryTransactionLock();
    // SAFETY: MemoryStoreOptions constrains every catalog value to RecordDefinition.
    const definitions = Object.entries(options.records) as [string, RecordDefinition][];
    const storage: Record<string, JsonObject[]> = {};
    const collections: Record<string, Collection<RecordDefinition>> = {};
    for (const [name, definition] of definitions) {
      const records: JsonObject[] = [];
      storage[name] = records;
      const collection = new MemoryCollection(name, definition, records);
      collections[name] = lockMemoryCollection(collection, lock);
    }
    // SAFETY: The loop creates exactly one Collection with its matching Definition for every key in options.records.
    const typedCollections = collections as StoreCollections<Definitions>;
    const transaction: TransactionStore<Definitions>["transaction"] = (use) =>
      lock.run(async () => {
        const journal = new MemoryTransactionJournal();
        const transactionLock = new MemoryTransactionLock();
        try {
          return await runTransactionCallback((track) => {
            const transactionCollections: Record<string, Collection<RecordDefinition>> = {};
            for (const [name, definition] of definitions) {
              // SAFETY: definitions and storage contain the same keys created by the loop above.
              transactionCollections[name] = lockMemoryCollection(
                new MemoryCollection(name, definition, storage[name] as JsonObject[], journal),
                transactionLock,
                track,
              );
            }
            // SAFETY: The loop creates one transaction-bound Collection over the same storage and matching Definition for every key.
            return Object.freeze({
              collections: transactionCollections as StoreCollections<Definitions>,
            });
          }, use);
        } catch (callbackFailure) {
          try {
            journal.rollback();
          } catch (rollbackFailure) {
            throw new TransactionRollbackError({
              callbackFailure,
              rollbackFailure,
            });
          }
          throw callbackFailure;
        }
      });
    return Object.freeze({ collections: typedCollections, transaction });
  }
}

/** Process-local options for the Core Thread Store specialization. */
export interface MemoryThreadStoreOptions {
  /** Backend clock used for lease expiry calculations. */
  readonly clock?: Pick<Clock, "now">;
}

/** Core Thread Store factory backed by the generic Memory Transaction Store. */
export class MemoryThreadStore {
  /** Make a Thread Store with the built-in Core Record catalog. */
  static make(options?: MemoryThreadStoreOptions): ThreadStore<CoreRecordDefinitions>;
  /** Make a Thread Store with host Record contributions and explicit Core Record overrides. */
  static make<
    const Records extends RecordDefinitions,
    const Overrides extends RecordOverrides<ContributedThreadRecordDefinitions<Records>> = {},
  >(
    options: MemoryThreadStoreOptions & ThreadStoreFactoryConfig<Records, Overrides>,
  ): ThreadStore<EffectiveRecordDefinitions<Records, Overrides>>;
  static make(
    options: MemoryThreadStoreOptions & {
      readonly records?: RecordDefinitions;
      readonly overrides?: object;
      readonly hooks?: object;
    } = {},
  ): unknown {
    const definitions = composeThreadStoreRecordDefinitions({
      records: options.records ?? {},
      ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
    }) as ThreadRecordDefinitions;
    const backend = MemoryStore.make({ records: definitions });
    return createThreadStore({
      backend,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.hooks === undefined
        ? {}
        : // SAFETY: The public overload checks hooks against the effective definitions before this implementation signature erases them.
          { hooks: options.hooks as ThreadStoreHooks<typeof definitions> }),
    });
  }
}
