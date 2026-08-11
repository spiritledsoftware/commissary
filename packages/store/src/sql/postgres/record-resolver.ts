import {
  applyRecordOverrides,
  type ApplyOverrides,
  type CompatibleRecordOverrides,
  type RecordDefinition,
  type RecordDefinitions,
  type RecordOverrides,
  type RoundTripRecordDefinitions,
} from "../../record.js";
import { isSqlContractObject as isRecordContainer } from "../contract-object.js";
import { validateSqlDefinitionStatement } from "../definition-statement.js";
import {
  createSqlFieldReference as fieldReference,
  freezeSqlRecordMap,
  iterateSqlRecordCatalog,
  iterateSqlRecordFields,
  readSqlOverrideValue as ownNullableOverride,
  resolveSqlPrimaryKey,
  selectSqlFieldSchema as selectedSchema,
  sqlDefinitionIssue as issue,
  sqlEvidenceMatchesApplication as evidenceCompatible,
  sqlLiteralMatchesApplication as literalMatchesApplication,
  validateSqlPrimaryKeyStructure,
} from "../record-catalog-resolver.js";
import {
  readSqlLiteralFormat,
  reflectSqlSelectStorage,
  SqlDefinitionError,
  type SqlDefinitionIssue,
  type SqlRecordReference,
  type SqlLiteralValue,
  type SqlResolvedGeneratedColumn,
} from "../record.js";
import { type SqlStatement } from "../statement.js";
import { resolvePhysicalType } from "./column-type-resolver.js";
import {
  isValidPostgresName,
  normalizeExactInteger,
  qualifiedReference,
  readPostgresMetadata,
  recordReference,
} from "./metadata.js";
import type { PostgresQualifiedName } from "./record.js";
import {
  type PostgresRecordResolution,
  type PostgresResolvedColumnType,
  type PostgresResolvedIdentity,
  type ResolutionState,
  type RuntimeColumn,
  type RuntimePhysicalType,
  type RuntimeTable,
} from "./resolution-types.js";

function integerRange(type: PostgresResolvedColumnType): readonly [bigint, bigint] | undefined {
  if (type.kind !== "direct") return undefined;
  switch (type.type) {
    case "smallint":
      return [-32_768n, 32_767n];
    case "integer":
      return [-2_147_483_648n, 2_147_483_647n];
    case "bigint":
      return [-9_223_372_036_854_775_808n, 9_223_372_036_854_775_807n];
    default:
      return undefined;
  }
}
const postgresIdentitySequenceOptionKeys = new Set([
  "name",
  "startWith",
  "incrementBy",
  "minValue",
  "maxValue",
  "cache",
  "cycle",
]);

function resolveIdentity(
  value: unknown,
  type: PostgresResolvedColumnType,
  path: readonly (string | number)[],
  issues: SqlDefinitionIssue[],
): PostgresResolvedIdentity | undefined {
  if (value === undefined) return undefined;
  if (!isRecordContainer(value)) {
    issues.push(issue("invalid-database-options", path, "PostgreSQL identity must be an object"));
    return undefined;
  }
  const mode = Reflect.get(value, "mode");
  if (mode !== "always" && mode !== "by-default") {
    issues.push(
      issue("invalid-database-options", [...path, "mode"], "PostgreSQL identity mode is invalid"),
    );
    return undefined;
  }
  const range = integerRange(type);
  if (range === undefined) {
    issues.push(
      issue(
        "invalid-database-options",
        path,
        "PostgreSQL identity requires an integer physical type",
      ),
    );
    return undefined;
  }
  if (!Object.hasOwn(value, "sequence")) return Object.freeze({ mode });
  const sequence = Reflect.get(value, "sequence");
  if (!isRecordContainer(sequence)) {
    issues.push(
      issue(
        "invalid-database-options",
        [...path, "sequence"],
        "PostgreSQL identity sequence must be an object",
      ),
    );
    return undefined;
  }
  for (const key of Reflect.ownKeys(sequence)) {
    if (typeof key !== "string" || !postgresIdentitySequenceOptionKeys.has(key)) {
      issues.push(
        issue(
          "invalid-database-options",
          [...path, "sequence", String(key)],
          `PostgreSQL identity sequence option '${String(key)}' is not supported`,
        ),
      );
    }
  }
  let name: Readonly<PostgresQualifiedName> | undefined;
  if (Object.hasOwn(sequence, "name")) {
    const candidate = Reflect.get(sequence, "name");
    if (
      !isRecordContainer(candidate) ||
      !isValidPostgresName(Reflect.get(candidate, "name")) ||
      (Object.hasOwn(candidate, "schema") && !isValidPostgresName(Reflect.get(candidate, "schema")))
    ) {
      issues.push(
        issue(
          "invalid-database-options",
          [...path, "sequence", "name"],
          "PostgreSQL identity sequence name is invalid",
        ),
      );
    } else {
      name = Object.freeze({
        ...(Object.hasOwn(candidate, "schema")
          ? { schema: Reflect.get(candidate, "schema") as string }
          : {}),
        name: Reflect.get(candidate, "name") as string,
      });
    }
  }
  const normalized = new Map<string, bigint>();
  for (const key of ["startWith", "incrementBy", "minValue", "maxValue", "cache"] as const) {
    if (!Object.hasOwn(sequence, key)) continue;
    const integer = normalizeExactInteger(Reflect.get(sequence, key));
    if (integer === undefined) {
      issues.push(
        issue(
          "invalid-database-options",
          [...path, "sequence", key],
          `PostgreSQL identity sequence '${key}' must be an exact integer`,
        ),
      );
    } else if (integer < range[0] || integer > range[1]) {
      issues.push(
        issue(
          "invalid-database-options",
          [...path, "sequence", key],
          `PostgreSQL identity sequence '${key}' is outside the column range`,
        ),
      );
    } else {
      normalized.set(key, integer);
    }
  }
  if (normalized.get("incrementBy") === 0n) {
    issues.push(
      issue(
        "invalid-database-options",
        [...path, "sequence", "incrementBy"],
        "PostgreSQL identity increment must not be zero",
      ),
    );
  }
  const cache = normalized.get("cache");
  if (cache !== undefined && cache < 1n) {
    issues.push(
      issue(
        "invalid-database-options",
        [...path, "sequence", "cache"],
        "PostgreSQL identity cache must be at least one",
      ),
    );
  }
  const minimum = normalized.get("minValue");
  const maximum = normalized.get("maxValue");
  const start = normalized.get("startWith");
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    issues.push(
      issue(
        "invalid-database-options",
        [...path, "sequence", "maxValue"],
        "PostgreSQL identity minimum exceeds its maximum",
      ),
    );
  }
  if (
    start !== undefined &&
    ((minimum !== undefined && start < minimum) || (maximum !== undefined && start > maximum))
  ) {
    issues.push(
      issue(
        "invalid-database-options",
        [...path, "sequence", "startWith"],
        "PostgreSQL identity start is outside its explicit bounds",
      ),
    );
  }
  if (Object.hasOwn(sequence, "cycle") && typeof Reflect.get(sequence, "cycle") !== "boolean") {
    issues.push(
      issue(
        "invalid-database-options",
        [...path, "sequence", "cycle"],
        "PostgreSQL identity cycle must be a boolean",
      ),
    );
  }
  const resolvedSequence = Object.freeze({
    ...(name === undefined ? {} : { name, reference: qualifiedReference(name) }),
    ...Object.fromEntries([...normalized].map(([key, integer]) => [key, integer.toString()])),
    ...(typeof Reflect.get(sequence, "cycle") === "boolean"
      ? { cycle: Reflect.get(sequence, "cycle") as boolean }
      : {}),
  });
  return Object.freeze({ mode, sequence: resolvedSequence });
}

function resolveDefault(
  value: unknown,
  physical: RuntimePhysicalType,
  path: readonly (string | number)[],
  issues: SqlDefinitionIssue[],
): SqlLiteralValue | SqlStatement<never> | undefined {
  if (value === undefined) return undefined;
  const literal = readSqlLiteralFormat(value);
  if (literal !== undefined) {
    if (!literalMatchesApplication(literal.value, physical.application)) {
      issues.push(
        issue(
          "invalid-column-default",
          path,
          "PostgreSQL column default does not match its final type",
        ),
      );
      return undefined;
    }
    return literal.value;
  }
  return validateSqlDefinitionStatement(value, path, issues, "PostgreSQL column default");
}

function resolveGenerated(
  value: unknown,
  path: readonly (string | number)[],
  issues: SqlDefinitionIssue[],
): SqlResolvedGeneratedColumn | undefined {
  if (value === undefined) return undefined;
  const expression = validateSqlDefinitionStatement(
    value,
    path,
    issues,
    "PostgreSQL generated expression",
    "invalid-database-options",
  );
  return expression === undefined ? undefined : Object.freeze({ expression, mode: "stored" });
}

function namespaceKey(name: PostgresQualifiedName): string {
  return name.schema === undefined
    ? `unqualified\0${name.name}`
    : `qualified\0${name.schema}\0${name.name}`;
}

function resolveRuntime(
  definitions: RecordDefinitions,
  overrides: unknown,
): PostgresRecordResolution<RecordDefinitions> {
  const state: ResolutionState = { issues: [], enums: [], enumByIdentity: new Map() };
  const tables = new Map<string, RuntimeTable>();
  const records = new Map<string, SqlRecordReference<RecordDefinition>>();
  const namespaceAssets: Array<{
    readonly relation?: {
      readonly name: PostgresQualifiedName;
      readonly path: readonly (string | number)[];
      readonly owner: string;
    };
    readonly type?: {
      readonly name: PostgresQualifiedName;
      readonly path: readonly (string | number)[];
      readonly owner: string;
    };
  }> = [];

  for (const record of iterateSqlRecordCatalog(definitions, overrides, state.issues)) {
    const { recordName, definition, table } = record;
    const recordPath = ["records", recordName] as const;
    const postgresValue = table === undefined ? undefined : Reflect.get(table, "postgres");
    const postgresTable = readPostgresMetadata(
      "table",
      postgresValue,
      [...recordPath, "table", "postgres"],
      state.issues,
    );
    const schemaValue = ownNullableOverride(postgresTable, undefined, "schema");
    const nameValue = ownNullableOverride(postgresTable, table, "name") ?? recordName;
    const tableNameValid = isValidPostgresName(nameValue);
    const schemaValid = schemaValue === undefined || isValidPostgresName(schemaValue);
    if (!tableNameValid) {
      state.issues.push(
        issue("invalid-name", [...recordPath, "table", "name"], "PostgreSQL table name is invalid"),
      );
    }
    if (!schemaValid) {
      state.issues.push(
        issue(
          "invalid-name",
          [...recordPath, "table", "postgres", "schema"],
          "PostgreSQL table schema is invalid",
        ),
      );
    }
    const primaryKeyValue = table?.primaryKey;

    const columns = new Map<string, RuntimeColumn>();
    const fieldStatements = new Map<string, SqlStatement<never>>();
    const columnNames = new Map<string, string>();
    for (const fieldEntry of iterateSqlRecordFields(record, state.issues)) {
      const { fieldName, field, column } = fieldEntry;
      const fieldPath = [...recordPath, "fields", fieldName] as const;
      const postgresColumnValue =
        column === undefined ? undefined : Reflect.get(column, "postgres");
      const postgresColumn = readPostgresMetadata(
        "column",
        postgresColumnValue,
        [...fieldPath, "column", "postgres"],
        state.issues,
      );
      const columnName = ownNullableOverride(postgresColumn, column, "name") ?? fieldName;
      if (!isValidPostgresName(columnName)) {
        state.issues.push(
          issue(
            "invalid-name",
            [...fieldPath, "column", "name"],
            `PostgreSQL column '${fieldName}' name is invalid`,
          ),
        );
        continue;
      }
      const evidence = reflectSqlSelectStorage(selectedSchema(field));
      const typeValue = ownNullableOverride(postgresColumn, column, "type");
      const physical = resolvePhysicalType(
        typeValue,
        evidence,
        [...fieldPath, "column", "type"],
        state,
      );
      if (physical === undefined) continue;
      if (!evidenceCompatible(evidence, physical.application)) {
        state.issues.push(
          issue(
            "invalid-column-type",
            [...fieldPath, "column", "type"],
            `PostgreSQL column '${fieldName}' type conflicts with Select Schema output`,
          ),
        );
      }
      const defaultValue = ownNullableOverride(postgresColumn, column, "default");
      const resolvedDefault = resolveDefault(
        defaultValue,
        physical,
        [...fieldPath, "column", "default"],
        state.issues,
      );
      const selectedNull = evidence?.selectedNull ?? false;
      const selectedPresence = evidence?.presence ?? "unknown";
      const explicitNotNull = ownNullableOverride(postgresColumn, column, "notNull");
      let notNull =
        typeof explicitNotNull === "boolean"
          ? explicitNotNull
          : selectedPresence === "required" && (physical.application === "json" || !selectedNull);
      if (
        explicitNotNull !== undefined &&
        explicitNotNull !== null &&
        typeof explicitNotNull !== "boolean"
      ) {
        state.issues.push(
          issue(
            "invalid-database-options",
            [...fieldPath, "column", "notNull"],
            `PostgreSQL column '${fieldName}' notNull option is invalid`,
          ),
        );
      }
      const identityValue =
        postgresColumn === undefined
          ? undefined
          : ownNullableOverride(postgresColumn, undefined, "identity");
      const identity = resolveIdentity(
        identityValue,
        physical.resolved,
        [...fieldPath, "column", "postgres", "identity"],
        state.issues,
      );
      if (identity !== undefined) notNull = true;
      if (notNull && selectedNull && physical.application !== "json") {
        state.issues.push(
          issue(
            "invalid-database-options",
            [...fieldPath, "column", "notNull"],
            `PostgreSQL column '${fieldName}' Select Schema permits SQL NULL`,
          ),
        );
      }
      const generatedValue =
        postgresColumn === undefined
          ? undefined
          : ownNullableOverride(postgresColumn, undefined, "generated");
      const generated = resolveGenerated(
        generatedValue,
        [...fieldPath, "column", "postgres", "generated"],
        state.issues,
      );
      if (identity !== undefined && explicitNotNull === false) {
        state.issues.push(
          issue(
            "invalid-database-options",
            [...fieldPath, "column", "postgres", "identity"],
            "PostgreSQL identity conflicts with notNull false",
          ),
        );
      }
      if (identity !== undefined && resolvedDefault !== undefined) {
        state.issues.push(
          issue(
            "invalid-database-options",
            [...fieldPath, "column", "postgres", "identity"],
            "PostgreSQL identity conflicts with an explicit default",
          ),
        );
      }
      if (generated !== undefined && resolvedDefault !== undefined) {
        state.issues.push(
          issue(
            "invalid-database-options",
            [...fieldPath, "column", "postgres", "generated"],
            "PostgreSQL generated column conflicts with a default",
          ),
        );
      }
      if (generated !== undefined && identity !== undefined) {
        state.issues.push(
          issue(
            "invalid-database-options",
            [...fieldPath, "column", "postgres", "generated"],
            "PostgreSQL generated column conflicts with identity",
          ),
        );
      }
      const reference = fieldReference(columnName);
      const resolvedColumn = Object.freeze({
        name: columnName,
        reference,
        schema: selectedSchema(field),
        type: physical.resolved,
        notNull,
        ...(resolvedDefault === undefined ? {} : { default: resolvedDefault }),
        ...(identity === undefined ? {} : { identity }),
        ...(generated === undefined ? {} : { generated }),
        encode: physical.encode,
        decode: physical.decode,
      }) as RuntimeColumn;
      columns.set(fieldName, resolvedColumn);
      fieldStatements.set(fieldName, reference);
      const earlier = columnNames.get(columnName);
      if (earlier === undefined) columnNames.set(columnName, fieldName);
      else
        state.issues.push(
          issue(
            "duplicate-name",
            [...fieldPath, "column", "name"],
            `PostgreSQL column '${columnName}' conflicts with field '${earlier}'`,
          ),
        );
    }

    const primaryKeyPath = [...recordPath, "table", "primaryKey"] as const;
    const primaryKeyFields = validateSqlPrimaryKeyStructure(
      primaryKeyValue,
      definition,
      primaryKeyPath,
      state.issues,
    );
    const frozenColumns = freezeSqlRecordMap(columns);
    const primaryKey = resolveSqlPrimaryKey(
      primaryKeyFields,
      frozenColumns,
      primaryKeyPath,
      state.issues,
    );
    if (!tableNameValid || !schemaValid) continue;
    const qualified = Object.freeze({
      ...(schemaValue === undefined ? {} : { schema: schemaValue }),
      name: nameValue,
    });
    const fields = freezeSqlRecordMap(fieldStatements);
    const reference = recordReference<RecordDefinition>(qualified, fields);
    const resolvedTable = Object.freeze({
      ...qualified,
      reference,
      definition,
      columns: frozenColumns,
      primaryKey,
    }) as RuntimeTable;
    tables.set(recordName, resolvedTable);
    records.set(recordName, reference);
    namespaceAssets.push({
      relation: {
        name: qualified,
        path: [...recordPath, "table", "name"],
        owner: `table '${recordName}'`,
      },
      type: {
        name: qualified,
        path: [...recordPath, "table", "name"],
        owner: `table row type '${recordName}'`,
      },
    });
    for (const [fieldName, column] of columns) {
      const sequence = column.identity?.sequence;
      if (sequence?.name !== undefined) {
        namespaceAssets.push({
          relation: {
            name: sequence.name,
            path: [
              ...recordPath,
              "fields",
              fieldName,
              "column",
              "postgres",
              "identity",
              "sequence",
              "name",
            ],
            owner: `identity sequence '${recordName}.${fieldName}'`,
          },
        });
      }
    }
  }

  for (const pending of state.enums) {
    namespaceAssets.push({
      type: { name: pending.asset, path: pending.path, owner: `enum '${pending.asset.name}'` },
    });
  }
  const relations = new Map<string, string>();
  const types = new Map<string, string>();
  for (const asset of namespaceAssets) {
    if (asset.relation !== undefined) {
      const key = namespaceKey(asset.relation.name);
      const earlier = relations.get(key);
      if (earlier === undefined) relations.set(key, asset.relation.owner);
      else
        state.issues.push(
          issue(
            "duplicate-name",
            asset.relation.path,
            `PostgreSQL ${asset.relation.owner} conflicts with ${earlier}`,
          ),
        );
    }
    if (asset.type !== undefined) {
      const key = namespaceKey(asset.type.name);
      const earlier = types.get(key);
      if (earlier === undefined) types.set(key, asset.type.owner);
      else
        state.issues.push(
          issue(
            "duplicate-name",
            asset.type.path,
            `PostgreSQL ${asset.type.owner} conflicts with ${earlier}`,
          ),
        );
    }
  }

  if (state.issues.length > 0) throw new SqlDefinitionError(state.issues);
  return Object.freeze({
    records: freezeSqlRecordMap(records),
    tables: freezeSqlRecordMap(tables),
    enums: Object.freeze(state.enums.map(({ asset }) => asset)),
  });
}

/** Resolve effective SQL Records into immutable PostgreSQL adapter assets without I/O. */
export function resolvePostgresRecords<
  const Definitions extends RecordDefinitions,
  const Overrides extends RecordOverrides<Definitions> = {},
>(options: {
  readonly records: Definitions & RoundTripRecordDefinitions<Definitions>;
  readonly overrides?: Overrides & CompatibleRecordOverrides<Definitions, Overrides>;
}): PostgresRecordResolution<ApplyOverrides<Definitions, Overrides>> {
  const overrides =
    options.overrides ?? ({} as Overrides & CompatibleRecordOverrides<Definitions, Overrides>);
  let definitions: RecordDefinitions;
  try {
    definitions = applyRecordOverrides<Definitions, Overrides>(options.records, overrides);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "unknown override structure";
    throw new SqlDefinitionError(
      [
        issue(
          "invalid-override",
          ["overrides"],
          `PostgreSQL Record override is invalid: ${message}`,
        ),
      ],
      { cause },
    );
  }
  // SAFETY: applyRecordOverrides and the resolver preserve all generic Record and Field keys.
  return resolveRuntime(definitions, overrides) as PostgresRecordResolution<
    ApplyOverrides<Definitions, Overrides>
  >;
}
