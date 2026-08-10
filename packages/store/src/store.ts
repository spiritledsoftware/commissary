import type {
  BaseStoreOperatorTypes,
  Fields,
  StoreOperatorTypes,
  UpdateSet,
} from "./store-expressions.js";
import type {
  CreateInput,
  RecordDefinition,
  RecordDefinitions,
  SelectedRecord,
  UpdateInput,
} from "./record.js";

/** Top-level fields requested from one selected Record. */
export type Selection<Record extends object> = {
  readonly [Key in keyof Record]?: true;
};

type SelectedKeys<Record extends object, Select extends Selection<Record>> = {
  readonly [Key in keyof Record]-?: Key extends keyof Select
    ? Select[Key] extends true
      ? Key
      : never
    : never;
}[keyof Record];

/** Full selected Record or its requested top-level projection. */
export type Project<Record extends object, Select extends Selection<Record> | undefined> = [
  Select,
] extends [undefined]
  ? Record
  : Select extends Selection<Record>
    ? Pick<Record, SelectedKeys<Record, Select>>
    : never;
/** Find filtering, projection, ordering, and pagination input. */
export interface FindOptions<
  Record extends object,
  Select extends Selection<Record> | undefined,
  Operators extends StoreOperatorTypes,
> {
  /** Optional typed predicate used to filter Records. */
  readonly where?: (
    fields: Fields<Record>,
    operators: Operators["operators"],
  ) => Operators["predicate"];
  /** Optional top-level projection. */
  readonly select?: Select;
  /** Optional ordered list of typed sort expressions. */
  readonly orderBy?: (
    fields: Fields<Record>,
    operators: Operators["operators"],
  ) => ReadonlyArray<Operators["order"]>;
  /** Maximum number of Records to return. */
  readonly limit?: number;
  /** Number of ordered matching Records to skip. */
  readonly offset?: number;
}

/** Optional typed where expression shared by count and delete. */
export interface WhereOptions<Record extends object, Operators extends StoreOperatorTypes> {
  /** Optional typed predicate used to filter Records. */
  readonly where?: (
    fields: Fields<Record>,
    operators: Operators["operators"],
  ) => Operators["predicate"];
}

/** Literal or expression update input. */
export interface UpdateOptions<
  Definition extends RecordDefinition,
  Operators extends StoreOperatorTypes,
> extends WhereOptions<SelectedRecord<Definition>, Operators> {
  /** Literal changes or one callback that builds update expressions. */
  readonly set:
    | UpdateInput<Definition>
    | ((
        fields: Fields<SelectedRecord<Definition>>,
        operators: Operators["operators"],
      ) => UpdateSet<Definition, Operators["expressionOwner"]>);
}
/** Delete input contains only an optional where expression. */
export type DeleteOptions<
  Record extends object,
  Operators extends StoreOperatorTypes,
> = WhereOptions<Record, Operators>;

/** Count input contains only an optional where expression. */
export type CountOptions<
  Record extends object,
  Operators extends StoreOperatorTypes,
> = WhereOptions<Record, Operators>;

/** Generic CRUD operations for one typed Record Collection. */
export interface Collection<
  Definition extends RecordDefinition,
  Operators extends StoreOperatorTypes = BaseStoreOperatorTypes,
  Create extends object = CreateInput<Definition>,
> {
  /** Find stored Records with typed filtering, ordering, paging, and projection. */
  readonly find: <
    const Select extends Selection<SelectedRecord<Definition>> | undefined = undefined,
  >(
    options?: FindOptions<SelectedRecord<Definition>, Select, Operators>,
  ) => Promise<readonly Project<SelectedRecord<Definition>, Select>[]>;

  /** Validate and create one Record. */
  readonly create: (input: Create) => Promise<SelectedRecord<Definition>>;

  /** Validate and change every matching Record. */
  readonly update: (input: UpdateOptions<Definition, Operators>) => Promise<number>;

  /** Delete every matching Record and return the affected count. */
  readonly delete: (
    input?: DeleteOptions<SelectedRecord<Definition>, Operators>,
  ) => Promise<number>;

  /** Count every matching Record. */
  readonly count: (input?: CountOptions<SelectedRecord<Definition>, Operators>) => Promise<number>;
}

/** Default create inputs inferred from every Record Definition in a catalog. */
export type DefaultStoreCreateInputs<Definitions extends RecordDefinitions> = {
  readonly [Name in keyof Definitions]: CreateInput<Definitions[Name]>;
};

export type StoreCreateInputMap<Definitions extends RecordDefinitions> = {
  readonly [Name in keyof Definitions]: object;
};

/** The readonly Collection Map for one complete Record catalog. */
export type StoreCollections<
  Definitions extends RecordDefinitions,
  Operators extends StoreOperatorTypes = BaseStoreOperatorTypes,
  CreateInputs extends StoreCreateInputMap<Definitions> = DefaultStoreCreateInputs<Definitions>,
> = {
  readonly [Name in keyof Definitions]: Collection<
    Definitions[Name],
    Operators,
    CreateInputs[Name]
  >;
};

/** Base persistence interface for one complete typed Collection Catalog. */
export interface Store<
  Definitions extends RecordDefinitions,
  Operators extends StoreOperatorTypes = BaseStoreOperatorTypes,
  CreateInputs extends StoreCreateInputMap<Definitions> = DefaultStoreCreateInputs<Definitions>,
> {
  /** Every Core and Custom Collection available to the Store owner. */
  readonly collections: StoreCollections<Definitions, Operators, CreateInputs>;
}

/** Store with one adapter-owned serializable transaction boundary. */
export interface TransactionStore<
  Definitions extends RecordDefinitions,
  Operators extends StoreOperatorTypes = BaseStoreOperatorTypes,
  TransactionCapabilities extends {
    readonly [Key in keyof TransactionCapabilities]: Key extends "transaction"
      ? never
      : TransactionCapabilities[Key];
  } = {},
  CreateInputs extends StoreCreateInputMap<Definitions> = DefaultStoreCreateInputs<Definitions>,
> extends Store<Definitions, Operators, CreateInputs> {
  /** Run one callback at most once against a transaction-bound Store view. */
  readonly transaction: <Value>(
    use: (
      transaction: Store<Definitions, Operators, CreateInputs> & TransactionCapabilities,
    ) => Promise<Value>,
  ) => Promise<Value>;
}
