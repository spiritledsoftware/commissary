import type { JsonValue } from "../../json.js";
import type {
  FieldDefinition,
  FieldOutput,
  RecordDefinition,
  RecordDefinitions,
  SelectFieldSchema,
} from "../../record.js";
import type {
  SqlDefinitionIssue,
  SqlLiteralValue,
  SqlRecordReference,
  SqlRecordReferences,
  SqlResolvedGeneratedColumn,
} from "../record.js";
import type { SqlStatement } from "../statement.js";
import type {
  MysqlDecimalOptions,
  MysqlDoubleOptions,
  MysqlFloatOptions,
  MysqlIntegerOptions,
  MysqlOptionalLengthOptions,
  MysqlRealOptions,
  MysqlTemporalOptions,
} from "./record.js";

/** One driver-independent value produced by a resolved MySQL column encoder. */
export type MysqlEncodedValue = JsonValue | Uint8Array;

/** Every supported direct MySQL column type name. */
export type MysqlDirectTypeName =
  | "tinyint"
  | "smallint"
  | "mediumint"
  | "int"
  | "bigint"
  | "decimal"
  | "float"
  | "double"
  | "real"
  | "boolean"
  | "char"
  | "varchar"
  | "binary"
  | "varbinary"
  | "text"
  | "tinytext"
  | "mediumtext"
  | "longtext"
  | "json"
  | "date"
  | "datetime"
  | "time"
  | "timestamp"
  | "year"
  | "serial";

/** Final supported options for one direct MySQL column type. */
export type MysqlResolvedDirectTypeOptions =
  | MysqlIntegerOptions
  | MysqlDecimalOptions
  | MysqlFloatOptions
  | MysqlDoubleOptions
  | MysqlRealOptions
  | MysqlOptionalLengthOptions
  | MysqlTemporalOptions
  | Readonly<{ readonly length: number }>;

/** Final physical facts for one direct MySQL type. */
export interface MysqlResolvedDirectType {
  readonly kind: "direct";
  readonly type: MysqlDirectTypeName;
  readonly options?: Readonly<MysqlResolvedDirectTypeOptions>;
}

/** Final physical facts for one inline MySQL enum. */
export interface MysqlResolvedEnumType {
  readonly kind: "enum";
  readonly values: readonly [string, ...string[]];
}

/** Final physical facts for one external MySQL type. */
export interface MysqlResolvedCustomType {
  readonly kind: "custom";
  readonly type: SqlStatement<never>;
}

/** Final MySQL column type selected by resolution. */
export type MysqlResolvedColumnType =
  | MysqlResolvedDirectType
  | MysqlResolvedEnumType
  | MysqlResolvedCustomType;

/** How a MySQL automatic-increment column proves its required key. */
export interface MysqlResolvedAutoIncrement {
  readonly key: "host-required" | "serial-unique";
}

/** Final physical facts for one resolved MySQL column. */
export interface MysqlResolvedColumn<Field extends FieldDefinition> {
  readonly name: string;
  readonly reference: SqlStatement<never>;
  readonly schema: SelectFieldSchema<Field>;
  readonly type: MysqlResolvedColumnType;
  readonly notNull: boolean;
  readonly default?: SqlLiteralValue | SqlStatement<never>;
  readonly autoIncrement?: MysqlResolvedAutoIncrement;
  readonly generated?: SqlResolvedGeneratedColumn;
  readonly onUpdate?: "current-timestamp";
  readonly encode: (
    value: Exclude<FieldOutput<SelectFieldSchema<Field>>, null | undefined>,
  ) => MysqlEncodedValue;
  readonly decode: (
    value: unknown,
  ) => Exclude<FieldOutput<SelectFieldSchema<Field>>, null | undefined>;
}

/** Resolved MySQL columns keyed by local SQL Record Field name. */
export type MysqlResolvedColumns<Definition extends RecordDefinition> = Readonly<{
  [Name in keyof Definition["fields"] & string]: MysqlResolvedColumn<Definition["fields"][Name]>;
}>;

/** Final physical facts for one resolved MySQL table. */
export interface MysqlResolvedTable<Definition extends RecordDefinition> {
  readonly database?: string;
  readonly name: string;
  readonly reference: SqlRecordReference<Definition>;
  readonly definition: Definition;
  readonly columns: MysqlResolvedColumns<Definition>;
  readonly primaryKey: readonly MysqlResolvedColumn<
    Definition["fields"][keyof Definition["fields"]]
  >[];
}

/** Resolved MySQL tables keyed by local SQL Record name. */
export type MysqlResolvedTables<Definitions extends RecordDefinitions> = Readonly<{
  [Name in keyof Definitions & string]: MysqlResolvedTable<Definitions[Name]>;
}>;

/** Immutable SQL Record references and MySQL adapter assets. */
export interface MysqlRecordResolution<Definitions extends RecordDefinitions> {
  readonly records: SqlRecordReferences<Definitions>;
  readonly tables: MysqlResolvedTables<Definitions>;
}

export interface RuntimePhysicalType {
  readonly resolved: MysqlResolvedColumnType;
  readonly application: "string" | "number" | "integer" | "boolean" | "json" | "custom";
  readonly encode: (value: unknown) => MysqlEncodedValue;
  readonly decode: (value: unknown) => JsonValue;
  readonly intrinsicAutoIncrement?: boolean;
}

export type RuntimeColumn = MysqlResolvedColumn<FieldDefinition>;

export interface RuntimeTable extends MysqlResolvedTable<RecordDefinition> {
  readonly columns: Readonly<Record<string, RuntimeColumn>>;
  readonly primaryKey: readonly RuntimeColumn[];
}

export interface ResolutionState {
  readonly issues: SqlDefinitionIssue[];
}
