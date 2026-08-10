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
  PostgresCharacterOptions,
  PostgresIntervalOptions,
  PostgresNumericOptions,
  PostgresQualifiedName,
  PostgresTemporalOptions,
} from "./record.js";

/** One driver-independent value produced by a resolved PostgreSQL column encoder. */
export type PostgresEncodedValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | { readonly [key: string]: JsonValue }
  | readonly PostgresEncodedValue[];

/** PostgreSQL array data plus the lower bound of each application dimension. */
export interface PostgresArrayDriverValue {
  readonly values: readonly unknown[];
  readonly lowerBounds: readonly number[];
}

/** Final supported PostgreSQL direct physical type name. */
export type PostgresDirectTypeName =
  | "smallint"
  | "integer"
  | "bigint"
  | "numeric"
  | "real"
  | "double-precision"
  | "boolean"
  | "char"
  | "varchar"
  | "text"
  | "uuid"
  | "json"
  | "jsonb"
  | "bytea"
  | "date"
  | "time"
  | "timestamp"
  | "interval"
  | "inet"
  | "cidr"
  | "macaddr"
  | "macaddr8"
  | "point"
  | "line";

/** Final physical facts for one direct PostgreSQL column type. */
export interface PostgresResolvedDirectType {
  readonly kind: "direct";
  readonly type: PostgresDirectTypeName;
  readonly options?: Readonly<
    | PostgresNumericOptions
    | PostgresCharacterOptions
    | PostgresTemporalOptions
    | PostgresIntervalOptions
  >;
}

/** One immutable definition-owned PostgreSQL enum asset. */
export interface PostgresResolvedEnum {
  readonly schema?: string;
  readonly name: string;
  readonly values: readonly [string, ...string[]];
  readonly reference: SqlStatement<never>;
}

/** Final physical facts for one PostgreSQL enum column. */
export interface PostgresResolvedEnumType {
  readonly kind: "enum";
  readonly enum: PostgresResolvedEnum;
}

/** Final physical facts for one PostgreSQL array column. */
export interface PostgresResolvedArrayType {
  readonly kind: "array";
  readonly element: PostgresResolvedColumnType;
}

/** Final physical facts for one external PostgreSQL custom type. */
export interface PostgresResolvedCustomType {
  readonly kind: "custom";
  readonly type: Readonly<PostgresQualifiedName>;
  readonly modifier?: SqlStatement<never>;
}

/** Final physical PostgreSQL type for one resolved column. */
export type PostgresResolvedColumnType =
  | PostgresResolvedDirectType
  | PostgresResolvedEnumType
  | PostgresResolvedArrayType
  | PostgresResolvedCustomType;

/** Normalized PostgreSQL identity-sequence controls. */
export interface PostgresResolvedIdentitySequence {
  readonly name?: Readonly<PostgresQualifiedName>;
  readonly reference?: SqlStatement<never>;
  readonly startWith?: string;
  readonly incrementBy?: string;
  readonly minValue?: string;
  readonly maxValue?: string;
  readonly cache?: string;
  readonly cycle?: boolean;
}

/** Final PostgreSQL identity generation facts. */
export interface PostgresResolvedIdentity {
  readonly mode: "always" | "by-default";
  readonly sequence?: PostgresResolvedIdentitySequence;
}

/** Adapter-facing facts and conversion functions for one PostgreSQL column. */
export interface PostgresResolvedColumn<Field extends FieldDefinition = FieldDefinition> {
  readonly name: string;
  readonly reference: SqlStatement<never>;
  readonly schema: SelectFieldSchema<Field>;
  readonly type: PostgresResolvedColumnType;
  readonly notNull: boolean;
  readonly default?: SqlLiteralValue | SqlStatement<never>;
  readonly identity?: PostgresResolvedIdentity;
  readonly generated?: SqlResolvedGeneratedColumn;
  readonly encode: (
    value: Exclude<FieldOutput<SelectFieldSchema<Field>>, null | undefined>,
  ) => PostgresEncodedValue;
  readonly decode: (value: unknown) => Exclude<FieldOutput<SelectFieldSchema<Field>>, undefined>;
}

/** Adapter-facing final PostgreSQL table facts for one Record. */
export interface PostgresResolvedTable<Definition extends RecordDefinition = RecordDefinition> {
  readonly schema?: string;
  readonly name: string;
  readonly reference: SqlRecordReference<Definition>;
  readonly definition: Definition;
  readonly columns: {
    readonly [Name in keyof Definition["fields"]]: PostgresResolvedColumn<
      Definition["fields"][Name]
    >;
  };
  readonly primaryKey: readonly PostgresResolvedColumn<
    Definition["fields"][keyof Definition["fields"]]
  >[];
}

/** Final PostgreSQL tables keyed by Record catalog name. */
export type PostgresResolvedTables<Definitions extends RecordDefinitions> = {
  readonly [Name in keyof Definitions]: PostgresResolvedTable<Definitions[Name]>;
};

/** Complete immutable PostgreSQL Record resolution for one effective catalog. */
export interface PostgresRecordResolution<Definitions extends RecordDefinitions> {
  readonly records: SqlRecordReferences<Definitions>;
  readonly tables: PostgresResolvedTables<Definitions>;
  readonly enums: readonly PostgresResolvedEnum[];
}

export type RuntimeColumn = PostgresResolvedColumn<FieldDefinition>;
export type RuntimeTable = PostgresResolvedTable<RecordDefinition>;

export type RuntimePhysicalType = {
  readonly resolved: PostgresResolvedColumnType;
  readonly application:
    | "string"
    | "number"
    | "integer"
    | "boolean"
    | "json"
    | "point"
    | "line"
    | "array"
    | "custom";
  readonly encode: (value: unknown) => PostgresEncodedValue;
  readonly decode: (value: unknown) => JsonValue;
  readonly enumIdentity?: symbol;
};

export interface PendingEnum {
  readonly identity: symbol;
  readonly asset: PostgresResolvedEnum;
  readonly path: readonly (string | number)[];
}

export interface ResolutionState {
  readonly issues: SqlDefinitionIssue[];
  readonly enums: PendingEnum[];
  readonly enumByIdentity: Map<symbol, PostgresResolvedEnum>;
}
