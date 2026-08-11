import type {
  CreateInput,
  FieldSchema,
  RecordDefinition,
  SelectedRecord,
  UpdateInput,
} from "@commissary/store";
import type { MysqlResolvedColumnType } from "@commissary/store/sql/mysql/adapter";
import { resolveMysqlRecords } from "@commissary/store/sql/mysql/adapter";
import type { PostgresResolvedColumnType } from "@commissary/store/sql/postgres/adapter";
import { resolvePostgresRecords } from "@commissary/store/sql/postgres/adapter";
import type { SqliteResolvedColumnType } from "@commissary/store/sql/sqlite/adapter";
import { resolveSqliteRecords } from "@commissary/store/sql/sqlite/adapter";
import { expect, expectTypeOf, it } from "vitest";

import {
  coreRecordDefinitions,
  type BranchRecord,
  type MessageEntry,
  type ThreadId,
  type ThreadRecord,
} from "@commissary/core";

const expectedCoreCatalogSignatures = [
  "thread|commissary_threads|id|id=id:text:max95",
  "branch|commissary_branches|id|id=id:text:max95,threadId=thread_id:text,name=name:text,head=head:text",
  "message|commissary_messages|id|id=id:text:max95,threadId=thread_id:text,parent=parent:text,message=message:json",
  "run|commissary_runs|id|id=id:text:max95,threadId=thread_id:text,branchId=branch_id:text,agent=agent:json,admittedHead=admitted_head:text,status=status:text,abortRequested=abort_requested:boolean,settlementContinuations=settlement_continuations:integer,usage=usage:json,abortReason=abort_reason:json,result=result:json",
  "toolCall|commissary_tool_calls|runId,toolCallId|toolCallId=tool_call_id:text:max95,runId=run_id:text:max95,sequence=sequence:integer,toolName=tool_name:text,parentToolCallId=parent_tool_call_id:text,providerId=provider_id:text,delegationKey=delegation_key:text,requestedInput=requested_input:json,effectiveInput=effective_input:json,status=status:text,result=result:json,suspension=suspension:json,providerData=provider_data:json,historyCommitted=history_committed:boolean",
  "executionClaim|commissary_execution_claims|runId|runId=run_id:text:max95,executionId=execution_id:text,token=token:text,fence=fence:integer,expiresAt=expires_at:integer",
  "executionFence|commissary_execution_fences|runId|runId=run_id:text:max95,fence=fence:integer",
  "pendingSteering|commissary_pending_steerings|runId,sequence|runId=run_id:text:max95,sequence=sequence:integer,message=message:json",
  "pendingRedirect|commissary_pending_redirects|runId,sequence|runId=run_id:text:max95,sequence=sequence:integer,message=message:json",
  "runCommandSequence|commissary_run_command_sequences|runId|runId=run_id:text:max95,sequence=sequence:integer",
  "toolCallSequence|commissary_tool_call_sequences|runId|runId=run_id:text:max95,sequence=sequence:integer",
  "runSubmission|commissary_run_submissions|runId|runId=run_id:text:max95,fingerprint=fingerprint:text,result=result:json",
  "toolResumeRequest|commissary_tool_resume_requests|runId,requestId|runId=run_id:text:max95,requestId=request_id:text:max95,fingerprint=fingerprint:text,result=result:json",
  "steeringRequest|commissary_steering_requests|runId,requestId|runId=run_id:text:max95,requestId=request_id:text:max95,fingerprint=fingerprint:text,result=result:json",
  "redirectRequest|commissary_redirect_requests|runId,requestId|runId=run_id:text:max95,requestId=request_id:text:max95,fingerprint=fingerprint:text,result=result:json",
  "commit|commissary_commits|commitId|commitId=commit_id:text:max95,fingerprint=fingerprint:text",
  "finalizationOutcome|commissary_finalization_outcomes|commitId|commitId=commit_id:text:max95,outcome=outcome:json",
  "modelCommitOutcome|commissary_model_commit_outcomes|commitId|commitId=commit_id:text:max95,outcome=outcome:json",
  "settlementOutcome|commissary_settlement_outcomes|commitId|commitId=commit_id:text:max95,outcome=outcome:json",
] as const;

type ResolvedCatalogColumn<Type> = {
  readonly name: string;
  readonly schema: FieldSchema;
  readonly type: Type;
};

type ResolvedCatalogTable<Type> = {
  readonly name: string;
  readonly definition: RecordDefinition;
  readonly columns: Readonly<Record<string, ResolvedCatalogColumn<Type>>>;
  readonly primaryKey: readonly ResolvedCatalogColumn<Type>[];
};

function postgresTypeSignature(resolved: PostgresResolvedColumnType): string {
  if (resolved.kind !== "direct") {
    throw new Error("Core SQL catalog PostgreSQL column did not resolve to a direct type");
  }
  switch (resolved.type) {
    case "text":
    case "boolean":
    case "json":
      return resolved.type;
    case "bigint":
      return "integer";
    default:
      throw new Error(`Core SQL catalog PostgreSQL type '${resolved.type}' is not portable`);
  }
}

function mysqlTypeSignature(resolved: MysqlResolvedColumnType): string {
  if (resolved.kind !== "direct") {
    throw new Error("Core SQL catalog MySQL column did not resolve to a direct type");
  }
  switch (resolved.type) {
    case "text":
    case "boolean":
    case "json":
      return resolved.type;
    case "bigint":
      return "integer";
    case "varchar":
      if (
        resolved.options !== undefined &&
        "length" in resolved.options &&
        resolved.options.length === 95
      ) {
        return "text:max95";
      }
      throw new Error("Core SQL catalog MySQL key does not use VARCHAR(95)");
    default:
      throw new Error(`Core SQL catalog MySQL type '${resolved.type}' is not portable`);
  }
}

function sqliteTypeSignature(resolved: SqliteResolvedColumnType): string {
  if (resolved.kind !== "direct") {
    throw new Error("Core SQL catalog SQLite column did not resolve to a direct type");
  }
  switch (resolved.type) {
    case "text":
    case "integer":
    case "boolean":
    case "json":
      return resolved.type;
    default:
      throw new Error(`Core SQL catalog SQLite type '${resolved.type}' is not portable`);
  }
}

function resolvedCatalogSignatures<Type>(
  tables: Readonly<Record<string, ResolvedCatalogTable<Type>>>,
  typeSignature: (type: Type) => string,
): readonly string[] {
  return Object.entries(tables).map(([recordName, table]) => {
    const primaryKey = table.primaryKey.map((primaryColumn) => {
      const entry = Object.entries(table.columns).find(([, column]) => column === primaryColumn);
      if (entry === undefined) {
        throw new Error("Core SQL catalog primary key did not reference a resolved field");
      }
      return entry[0];
    });
    const fields = Object.entries(table.columns).map(
      ([fieldName, column]) => `${fieldName}=${column.name}:${typeSignature(column.type)}`,
    );
    return `${recordName}|${table.name}|${primaryKey.join(",")}|${fields.join(",")}`;
  });
}

async function expectSchemaSuccess(schema: FieldSchema, value: unknown): Promise<void> {
  expect(await schema["~standard"].validate(value)).toHaveProperty("value");
}

async function expectSchemaFailure(schema: FieldSchema, value: unknown): Promise<void> {
  expect(await schema["~standard"].validate(value)).toHaveProperty("issues");
}

it("resolves the exact 19-Record, 74-field Core SQL catalog for every database", () => {
  const postgres = resolvePostgresRecords({ records: coreRecordDefinitions });
  const mysql = resolveMysqlRecords({ records: coreRecordDefinitions });
  const sqlite = resolveSqliteRecords({ records: coreRecordDefinitions });
  const unboundedSignatures = expectedCoreCatalogSignatures.map((signature) =>
    signature.replaceAll(":text:max95", ":text"),
  );

  expect(resolvedCatalogSignatures(postgres.tables, postgresTypeSignature)).toEqual(
    unboundedSignatures,
  );
  expect(resolvedCatalogSignatures(mysql.tables, mysqlTypeSignature)).toEqual(
    expectedCoreCatalogSignatures,
  );
  expect(resolvedCatalogSignatures(sqlite.tables, sqliteTypeSignature)).toEqual(
    unboundedSignatures,
  );
  expect(
    Object.values(postgres.tables).flatMap((table) => Object.keys(table.columns)),
  ).toHaveLength(74);
});

it("enforces Core SQL key and integer storage bounds in the owning Field Schemas", async () => {
  const mysql = resolveMysqlRecords({ records: coreRecordDefinitions });
  const tables: Readonly<Record<string, ResolvedCatalogTable<MysqlResolvedColumnType>>> =
    mysql.tables;
  const maximumKey = "😀".repeat(95);
  const oversizedKey = `${maximumKey}😀`;

  for (const signature of expectedCoreCatalogSignatures) {
    const [recordName, , , fieldsSignature] = signature.split("|");
    const table = recordName === undefined ? undefined : tables[recordName];
    if (table === undefined || fieldsSignature === undefined) {
      throw new Error("Core SQL catalog test signature is malformed");
    }
    for (const fieldSignature of fieldsSignature.split(",")) {
      const [fieldName, storage] = fieldSignature.split("=");
      const column = fieldName === undefined ? undefined : table.columns[fieldName];
      if (column === undefined || storage === undefined) {
        throw new Error("Core SQL catalog test field signature is malformed");
      }
      if (storage.endsWith(":text:max95")) {
        await expectSchemaSuccess(column.schema, maximumKey);
        await expectSchemaFailure(column.schema, oversizedKey);
      }
      if (storage.endsWith(":integer")) {
        await expectSchemaSuccess(column.schema, 0);
        await expectSchemaSuccess(column.schema, Number.MAX_SAFE_INTEGER);
        await expectSchemaFailure(column.schema, -1);
        await expectSchemaFailure(column.schema, 1.5);
        await expectSchemaFailure(column.schema, Number.MAX_SAFE_INTEGER + 1);
      }
    }
  }
});

it("preserves selected, create, and update Core public types", () => {
  expectTypeOf<
    SelectedRecord<(typeof coreRecordDefinitions)["thread"]>
  >().toEqualTypeOf<ThreadRecord>();
  expectTypeOf<
    SelectedRecord<(typeof coreRecordDefinitions)["branch"]>
  >().toEqualTypeOf<BranchRecord>();
  expectTypeOf<
    SelectedRecord<(typeof coreRecordDefinitions)["message"]>
  >().toExtend<MessageEntry>();
  expectTypeOf<CreateInput<(typeof coreRecordDefinitions)["thread"]>>().toEqualTypeOf<{
    readonly id: ThreadId;
  }>();
  expectTypeOf<UpdateInput<(typeof coreRecordDefinitions)["thread"]>>().toEqualTypeOf<{
    readonly id?: ThreadId;
  }>();
});
