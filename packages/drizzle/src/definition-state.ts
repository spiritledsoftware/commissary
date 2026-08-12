import type { RecordDefinitions, StoreCreateInputMap } from "@commissary/store";
import type { SqlRecordReferences } from "@commissary/store/sql";

/** Package-private type and runtime channel retained for later dialect binding. */
export const drizzleDefinitionState: unique symbol = Symbol("@commissary/drizzle/definition-state");
declare const drizzleCreateInputsType: unique symbol;

/** Hidden immutable facts shared by all connection-free dialect definitions. */
export interface DrizzleDefinitionState<
  Dialect extends "postgres" | "mysql" | "sqlite",
  Kind extends "store" | "thread-store",
  Definitions extends RecordDefinitions,
  Tables extends Readonly<Record<string, object>>,
  Hooks,
  CreateInputs extends StoreCreateInputMap<Definitions>,
> {
  /** Concrete database family that owns the definition. */
  readonly dialect: Dialect;
  /** Whether Core Records were added before host contributions. */
  readonly kind: Kind;
  /** Complete effective Field Schema catalog used by binding. */
  readonly definitions: Definitions;
  /** Exact final Drizzle tables keyed by Record name. */
  readonly tables: Tables;
  /** Captured Before Create Hooks keyed by Record name. */
  readonly hooks: Hooks;
  /** Inaccessible type-only hook-adjusted create-input catalog. */
  readonly [drizzleCreateInputsType]?: (inputs: CreateInputs) => CreateInputs;
}

/** Concrete definition shape carrying inaccessible lifecycle state. */
export interface ConcreteDrizzleDefinition<
  Dialect extends "postgres" | "mysql" | "sqlite",
  Kind extends "store" | "thread-store",
  Definitions extends RecordDefinitions,
  Records extends SqlRecordReferences<Definitions>,
  Tables extends Readonly<Record<string, object>>,
  Schema extends Readonly<Record<string, object>>,
  Hooks,
  CreateInputs extends StoreCreateInputMap<Definitions>,
> {
  /** Final SQL Record references keyed by Collection catalog name. */
  readonly records: Records;
  /** Flat final Drizzle schema for application configuration and direct exports. */
  readonly schema: Schema;
  /** Inaccessible definition facts consumed only by matching package binders. */
  readonly [drizzleDefinitionState]: DrizzleDefinitionState<
    Dialect,
    Kind,
    Definitions,
    Tables,
    Hooks,
    CreateInputs
  >;
}
