import type { JsonValue } from "../../json.js";
import type {
  FieldDefinition,
  FieldOutput,
  RecordDefinition,
  RecordDefinitions,
  SelectFieldSchema,
} from "../../record.js";
import type {
  SqlCustomEncodedValue,
  SqlDefinitionIssue,
  SqlLiteralValue,
  SqlRecordReference,
  SqlRecordReferences,
  SqlResolvedGeneratedColumn,
} from "../record.js";
import type { SqlStatement } from "../statement.js";

/** One driver-independent value produced by a resolved SQLite column encoder. */
export type SqliteEncodedValue = SqlCustomEncodedValue;

/** Every supported direct SQLite column type name. */
export type SqliteDirectTypeName =
  | "integer"
  | "boolean"
  | "timestamp-seconds"
  | "timestamp-milliseconds"
  | "real"
  | "text"
  | "json"
  | "blob"
  | "json-blob"
  | "bigint-blob"
  | "numeric"
  | "numeric-number";

/** Final physical facts for one direct SQLite type. */
export interface SqliteResolvedDirectType {
  readonly kind: "direct";
  readonly type: SqliteDirectTypeName;
}

/** Final physical facts for one external SQLite type. */
export interface SqliteResolvedCustomType {
  readonly kind: "custom";
  readonly type: SqlStatement<never>;
}

/** Final SQLite column type selected by resolution. */
export type SqliteResolvedColumnType = SqliteResolvedDirectType | SqliteResolvedCustomType;

/** Final SQLite ROWID reuse behavior. */
export interface SqliteResolvedRowid {
  readonly reuse: "allowed" | "forbidden";
}

/** Final physical facts for one resolved SQLite column. */
export interface SqliteResolvedColumn<Field extends FieldDefinition> {
  readonly name: string;
  readonly reference: SqlStatement<never>;
  readonly schema: SelectFieldSchema<Field>;
  readonly type: SqliteResolvedColumnType;
  readonly notNull: boolean;
  readonly default?: SqlLiteralValue | SqlStatement<never>;
  readonly rowid?: SqliteResolvedRowid;
  readonly generated?: SqlResolvedGeneratedColumn;
  readonly encode: (
    value: Exclude<FieldOutput<SelectFieldSchema<Field>>, null | undefined>,
  ) => SqliteEncodedValue;
  readonly decode: (
    value: unknown,
  ) => Exclude<FieldOutput<SelectFieldSchema<Field>>, null | undefined>;
}

/** Resolved SQLite columns keyed by local SQL Record Field name. */
export type SqliteResolvedColumns<Definition extends RecordDefinition> = Readonly<{
  [Name in keyof Definition["fields"] & string]: SqliteResolvedColumn<Definition["fields"][Name]>;
}>;

/** Final physical facts for one resolved SQLite table. */
export interface SqliteResolvedTable<Definition extends RecordDefinition> {
  readonly name: string;
  readonly reference: SqlRecordReference<Definition>;
  readonly definition: Definition;
  readonly columns: SqliteResolvedColumns<Definition>;
  readonly primaryKey: readonly SqliteResolvedColumn<
    Definition["fields"][keyof Definition["fields"]]
  >[];
}

/** Resolved SQLite tables keyed by local SQL Record name. */
export type SqliteResolvedTables<Definitions extends RecordDefinitions> = Readonly<{
  [Name in keyof Definitions & string]: SqliteResolvedTable<Definitions[Name]>;
}>;

/** Immutable SQL Record references and SQLite adapter assets. */
export interface SqliteRecordResolution<Definitions extends RecordDefinitions> {
  readonly records: SqlRecordReferences<Definitions>;
  readonly tables: SqliteResolvedTables<Definitions>;
}

export interface RuntimePhysicalType {
  readonly resolved: SqliteResolvedColumnType;
  readonly application: "string" | "number" | "integer" | "boolean" | "json" | "custom";
  readonly encode: (value: unknown) => SqliteEncodedValue;
  readonly decode: (value: unknown) => JsonValue;
}

export type RuntimeColumn = SqliteResolvedColumn<FieldDefinition>;

export interface RuntimeTable extends SqliteResolvedTable<RecordDefinition> {
  readonly columns: Readonly<Record<string, RuntimeColumn>>;
  readonly primaryKey: readonly RuntimeColumn[];
}

export interface ResolutionState {
  readonly issues: SqlDefinitionIssue[];
}
