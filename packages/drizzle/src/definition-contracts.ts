import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { SqlDefinitionIssueCode } from "@commissary/store/sql";

/** Stable code identifying one connection-free Drizzle definition issue. */
export type DrizzleDefinitionIssueCode =
  | SqlDefinitionIssueCode
  | "schema-generators-required"
  | "invalid-schema-generator"
  | "unsupported-schema-family"
  | "invalid-generated-schema"
  | "incompatible-generated-schema"
  | "invalid-drizzle-table"
  | "incompatible-drizzle-table"
  | "invalid-drizzle-column"
  | "incompatible-drizzle-column"
  | "invalid-drizzle-enum"
  | "invalid-drizzle-override"
  | "invalid-before-create-hook"
  | "invalid-drizzle-relations"
  | "duplicate-schema-key";

/** One ordered diagnostic from a failed Drizzle Store definition. */
export interface DrizzleDefinitionIssue {
  /** Stable machine-readable classification. */
  readonly code: DrizzleDefinitionIssueCode;
  /** Path into the caller's definition input. */
  readonly path: readonly (string | number)[];
  /** Diagnostic text that can contain application-owned names. */
  readonly message: string;
  /** Original callback failure, when one exists. */
  readonly cause?: unknown;
}

/** Aggregate synchronous failure from one connection-free Drizzle definition. */
export class DrizzleDefinitionError extends Error {
  /** Exact error family name used for definition failure classification. */
  override readonly name = "DrizzleDefinitionError" as const;

  /** Every independent definition issue in stable lifecycle order. */
  readonly issues: readonly DrizzleDefinitionIssue[];

  /** Create one immutable aggregate from an already ordered issue list. */
  constructor(issues: readonly DrizzleDefinitionIssue[]) {
    super(
      issues.length === 1
        ? `Drizzle definition failed: ${issues[0]?.message ?? "unknown issue"}`
        : `Drizzle definition failed with ${issues.length} issues`,
    );
    this.issues = Object.freeze(
      issues.map((issue) =>
        Object.freeze({
          code: issue.code,
          path: Object.freeze([...issue.path]),
          message: issue.message,
          ...(Object.hasOwn(issue, "cause") ? { cause: issue.cause } : {}),
        }),
      ),
    );
  }
}

/** Host functions that derive select, insert, and update object schemas from one final table. */
export interface DrizzleSchemaGenerators<
  in Table = object,
  out SelectRecordSchema extends StandardSchemaV1 = StandardSchemaV1,
  out InsertRecordSchema extends StandardSchemaV1 = StandardSchemaV1,
  out UpdateRecordSchema extends StandardSchemaV1 = StandardSchemaV1,
> {
  /** Generate the whole-table selected Record schema. */
  readonly select: (table: Table) => SelectRecordSchema;
  /** Generate the whole-table create-input schema. */
  readonly insert: (table: Table) => InsertRecordSchema;
  /** Generate the whole-table update-input schema. */
  readonly update: (table: Table) => UpdateRecordSchema;
}

/** Small public view of a connection-free Drizzle Store definition. */
export interface DrizzleStoreDefinition<
  out Records extends Readonly<Record<string, object>>,
  out Schema extends Readonly<Record<string, object>>,
> {
  /** Final SQL Record references keyed by Collection catalog name. */
  readonly records: Records;
  /** Flat final tables, PostgreSQL enums, and host relation entities. */
  readonly schema: Schema;
}

/** Construct one internal issue while preserving an optional callback cause. */
export function drizzleDefinitionIssue(
  code: DrizzleDefinitionIssueCode,
  path: readonly (string | number)[],
  message: string,
  options?: { readonly cause: unknown },
): DrizzleDefinitionIssue {
  return {
    code,
    path,
    message,
    ...(options === undefined ? {} : { cause: options.cause }),
  };
}
