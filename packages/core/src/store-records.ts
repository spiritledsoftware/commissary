import {
  applyRecordOverrides,
  isJsonValue,
  type ApplyOverrides,
  type CompatibleRecordOverrides,
  type CreateFieldSchema,
  type CreateInput,
  type FieldInput,
  type FieldOutput,
  type FieldSchema,
  type JsonValue as StoreJsonValue,
  type RecordDefinition,
  type RecordDefinitions,
  type RecordOverrides,
  type RoundTripFieldDefinitions,
  type RoundTripRecordDefinitions,
  type SelectFieldSchema,
  type SelectedRecord,
  type UpdateFieldSchema,
} from "@commissary/store";

import type { AgentReference } from "./identity.js";
import type { EncodedProviderData, ModelMessage, RunUsage } from "./protocol.js";
import type {
  AcceptedRun,
  BranchConflict,
  RedirectResult,
  RunConflict,
  RunResult,
  SteeringResult,
  SuspendedRunResult,
  ToolCallResult,
  ToolResumeConflict,
  ToolResumeRequestConflict,
} from "./runtime.js";
import type {
  BranchRecord,
  ExecutionClaim,
  CommitModelInvocationStoreResult,
  ContinueSettlementStoreResult,
  FinalizeRunStoreResult,
  MessageEntry,
  StoredToolCall,
  StoredToolFailure,
  StoredToolSuspension,
  ThreadRecord,
} from "./store.js";
import type {
  BranchId,
  CommitId,
  ExecutionClaimToken,
  ExecutionId,
  JsonValue,
  MessageEntryId,
  RedirectRequestId,
  RunId,
  SteeringRequestId,
  ThreadId,
  ToolCallId,
  ToolResumeRequestId,
} from "./types.js";

const invalidField = { issues: [{ message: "Invalid Core Record field" }] };
const invalidCoreField = Symbol("commissary.store.invalid-core-field");

function coreFieldSchema<Input, Output extends StoreJsonValue | undefined>(
  parse: (value: unknown) => Output | typeof invalidCoreField,
): FieldSchema<Input, Output> {
  return {
    "~standard": {
      version: 1,
      vendor: "commissary",
      validate(value) {
        const parsed = parse(value);
        return parsed === invalidCoreField ? invalidField : { value: parsed };
      },
    },
  };
}

function requiredStringField<Value extends string>(): FieldSchema<Value, Value> {
  return coreFieldSchema((value) => {
    if (typeof value !== "string" || value.length === 0) {
      return invalidCoreField;
    }
    // SAFETY: Core opaque string IDs add only a compile-time brand; their runtime parser accepts every nonempty string.
    return value as Value;
  });
}

function optionalStringField<Value extends string>(): FieldSchema<
  Value | undefined,
  Value | undefined
> {
  return coreFieldSchema((value) => {
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== "string" || value.length === 0) {
      return invalidCoreField;
    }
    // SAFETY: Core opaque string IDs add only a compile-time brand; their runtime parser accepts every nonempty string.
    return value as Value;
  });
}

function requiredNumberField(): FieldSchema<number, number> {
  return coreFieldSchema((value) =>
    typeof value === "number" && Number.isFinite(value) ? value : invalidCoreField,
  );
}

function requiredBooleanField(): FieldSchema<boolean, boolean> {
  return coreFieldSchema((value) => (typeof value === "boolean" ? value : invalidCoreField));
}

function literalStringField<const Value extends string>(
  ...values: readonly Value[]
): FieldSchema<Value, Value> {
  const accepted = new Set<string>(values);
  return coreFieldSchema((value) => {
    if (typeof value !== "string" || !accepted.has(value)) {
      return invalidCoreField;
    }
    // SAFETY: Membership in accepted proves that value is one of the const generic string literals.
    return value as Value;
  });
}

function requiredJsonField<Value>(): FieldSchema<Value, Value & StoreJsonValue> {
  return coreFieldSchema((value) => {
    if (!isJsonValue(value)) {
      return invalidCoreField;
    }
    // SAFETY: Core declares Value only for closed JSON contracts. isJsonValue proves the persistence representation, while each owning Core operation constructs the declared contract.
    return value as Value & StoreJsonValue;
  });
}

function optionalJsonField<Value>(): FieldSchema<
  Value | undefined,
  (Value & StoreJsonValue) | undefined
> {
  return coreFieldSchema((value) => {
    if (value === undefined) {
      return undefined;
    }
    if (!isJsonValue(value)) {
      return invalidCoreField;
    }
    // SAFETY: Core declares Value only for closed JSON contracts. isJsonValue proves the persistence representation, while each owning Core operation constructs the declared contract.
    return value as Value & StoreJsonValue;
  });
}

const threadFields = {
  id: requiredStringField<ThreadId>(),
};

const branchFields = {
  id: requiredStringField<BranchId>(),
  threadId: requiredStringField<ThreadId>(),
  name: requiredStringField<string>(),
  head: optionalStringField<MessageEntryId>(),
};

const messageFields = {
  id: requiredStringField<MessageEntryId>(),
  threadId: requiredStringField<ThreadId>(),
  parent: optionalStringField<MessageEntryId>(),
  message: requiredJsonField<ModelMessage>(),
};

const runFields = {
  id: requiredStringField<RunId>(),
  threadId: requiredStringField<ThreadId>(),
  branchId: requiredStringField<BranchId>(),
  agent: requiredJsonField<AgentReference>(),
  admittedHead: requiredStringField<MessageEntryId>(),
  status: literalStringField("active", "suspended", "completed", "failed", "aborted"),
  abortRequested: requiredBooleanField(),
  settlementContinuations: requiredNumberField(),
  usage: optionalJsonField<RunUsage>(),
  abortReason: optionalJsonField<JsonValue>(),
  result: optionalJsonField<Exclude<RunResult, SuspendedRunResult>>(),
};

const toolCallFields = {
  toolCallId: requiredStringField<ToolCallId>(),
  runId: requiredStringField<RunId>(),
  sequence: requiredNumberField(),
  toolName: requiredStringField<string>(),
  parentToolCallId: optionalStringField<ToolCallId>(),
  providerId: optionalStringField<string>(),
  delegationKey: optionalStringField<string>(),
  requestedInput: requiredJsonField<JsonValue>(),
  effectiveInput: optionalJsonField<JsonValue>(),
  status: literalStringField("pending", "running", "suspended", "succeeded", "failed", "aborted"),
  result: optionalJsonField<ToolCallResult<JsonValue, StoredToolFailure>>(),
  suspension: optionalJsonField<StoredToolSuspension>(),
  providerData: optionalJsonField<readonly EncodedProviderData[]>(),
  historyCommitted: requiredBooleanField(),
};

/** Built-in definitions for the five durable entity Collections. */
export const durableEntityRecordDefinitions = {
  thread: { fields: threadFields },
  branch: { fields: branchFields },
  message: { fields: messageFields },
  run: { fields: runFields },
  toolCall: { fields: toolCallFields },
};

/** Built-in definitions for the fourteen Runtime state Collections. */
export const runtimeStateRecordDefinitions = {
  executionClaim: {
    fields: {
      runId: requiredStringField<RunId>(),
      executionId: requiredStringField<ExecutionId>(),
      token: requiredStringField<ExecutionClaimToken>(),
      fence: requiredNumberField(),
      expiresAt: requiredNumberField(),
    },
  },
  executionFence: {
    fields: {
      runId: requiredStringField<RunId>(),
      fence: requiredNumberField(),
    },
  },
  pendingSteering: {
    fields: {
      runId: requiredStringField<RunId>(),
      sequence: requiredNumberField(),
      message: requiredJsonField<ModelMessage>(),
    },
  },
  pendingRedirect: {
    fields: {
      runId: requiredStringField<RunId>(),
      sequence: requiredNumberField(),
      message: requiredJsonField<ModelMessage>(),
    },
  },
  runCommandSequence: {
    fields: {
      runId: requiredStringField<RunId>(),
      sequence: requiredNumberField(),
    },
  },
  toolCallSequence: {
    fields: {
      runId: requiredStringField<RunId>(),
      sequence: requiredNumberField(),
    },
  },
  runSubmission: {
    fields: {
      runId: requiredStringField<RunId>(),
      fingerprint: requiredStringField<string>(),
      result: requiredJsonField<AcceptedRun | BranchConflict | RunConflict>(),
    },
  },
  toolResumeRequest: {
    fields: {
      runId: requiredStringField<RunId>(),
      requestId: requiredStringField<ToolResumeRequestId>(),
      fingerprint: requiredStringField<string>(),
      result: requiredJsonField<AcceptedRun | ToolResumeConflict | ToolResumeRequestConflict>(),
    },
  },
  steeringRequest: {
    fields: {
      runId: requiredStringField<RunId>(),
      requestId: requiredStringField<SteeringRequestId>(),
      fingerprint: requiredStringField<string>(),
      result: requiredJsonField<SteeringResult>(),
    },
  },
  redirectRequest: {
    fields: {
      runId: requiredStringField<RunId>(),
      requestId: requiredStringField<RedirectRequestId>(),
      fingerprint: requiredStringField<string>(),
      result: requiredJsonField<RedirectResult>(),
    },
  },
  commit: {
    fields: {
      commitId: requiredStringField<CommitId>(),
      fingerprint: requiredStringField<string>(),
    },
  },
  finalizationOutcome: {
    fields: {
      commitId: requiredStringField<CommitId>(),
      outcome: requiredJsonField<FinalizeRunStoreResult<typeof durableEntityRecordDefinitions>>(),
    },
  },
  modelCommitOutcome: {
    fields: {
      commitId: requiredStringField<CommitId>(),
      outcome:
        requiredJsonField<
          CommitModelInvocationStoreResult<typeof durableEntityRecordDefinitions>
        >(),
    },
  },
  settlementOutcome: {
    fields: {
      commitId: requiredStringField<CommitId>(),
      outcome:
        requiredJsonField<ContinueSettlementStoreResult<typeof durableEntityRecordDefinitions>>(),
    },
  },
};

/** Complete built-in Core Record catalog used when a host supplies no definitions. */
export const coreRecordDefinitions = {
  ...durableEntityRecordDefinitions,
  ...runtimeStateRecordDefinitions,
};

/** Type of the complete built-in Core Record catalog. */
export type CoreRecordDefinitions = typeof coreRecordDefinitions;

/** Record catalogs that can back a specialized Thread Store. */
export type ThreadRecordDefinitions = RecordDefinitions & {
  readonly [Name in keyof CoreRecordDefinitions]: RecordDefinition;
};

/** Built-in Core Records combined with separate host Record contributions. */
export type ContributedThreadRecordDefinitions<Records extends RecordDefinitions> = {
  readonly [Name in
    | keyof CoreRecordDefinitions
    | keyof Records]: Name extends keyof CoreRecordDefinitions
    ? Name extends keyof Records
      ? never
      : CoreRecordDefinitions[Name]
    : Name extends keyof Records
      ? Records[Name]
      : never;
};

/** Constraint that keeps host contributions separate from built-in Core Records. */
export type ThreadRecordContributions<Records extends RecordDefinitions> = {
  readonly [Name in keyof Records]: Name extends keyof CoreRecordDefinitions
    ? never
    : Records[Name];
};

type ComposedRecordDefinitions<
  Records extends RecordDefinitions,
  Overrides extends RecordOverrides<ContributedThreadRecordDefinitions<Records>>,
> = ApplyOverrides<ContributedThreadRecordDefinitions<Records>, Overrides>;

type EnsureThreadRecordDefinitions<Definitions extends RecordDefinitions> =
  Definitions extends ThreadRecordDefinitions ? Definitions : never;

type OutcomeRecordDefinition<Definition extends RecordDefinition, Outcome> = {
  readonly fields: Omit<Definition["fields"], "outcome"> & {
    readonly outcome: FieldSchema<Outcome, Outcome & StoreJsonValue>;
  };
};

type EffectiveOutcomeRecordDefinitions<Definitions extends ThreadRecordDefinitions> = {
  readonly [Name in keyof Definitions]: Name extends "finalizationOutcome"
    ? OutcomeRecordDefinition<Definitions[Name], FinalizeRunStoreResult<Definitions>>
    : Name extends "modelCommitOutcome"
      ? OutcomeRecordDefinition<Definitions[Name], CommitModelInvocationStoreResult<Definitions>>
      : Name extends "settlementOutcome"
        ? OutcomeRecordDefinition<Definitions[Name], ContinueSettlementStoreResult<Definitions>>
        : Definitions[Name];
};

/** Effective Core, host contribution, and explicit override Record catalog. */
export type EffectiveRecordDefinitions<
  Records extends RecordDefinitions,
  Overrides extends RecordOverrides<ContributedThreadRecordDefinitions<Records>> = {},
> = EffectiveOutcomeRecordDefinitions<
  EnsureThreadRecordDefinitions<ComposedRecordDefinitions<Records, Overrides>>
>;

type IncompatibleContributorFieldName<
  Contributor extends RecordDefinition,
  Effective extends RecordDefinition,
> = {
  readonly [Field in keyof Contributor["fields"]]: Field extends keyof Effective["fields"]
    ? Exclude<
        FieldOutput<SelectFieldSchema<Effective["fields"][Field]>>,
        undefined
      > extends SelectedRecord<Contributor>[Field]
      ? FieldInput<CreateFieldSchema<Contributor["fields"][Field]>> extends FieldInput<
          CreateFieldSchema<Effective["fields"][Field]>
        >
        ? FieldInput<UpdateFieldSchema<Contributor["fields"][Field]>> extends FieldInput<
            UpdateFieldSchema<Effective["fields"][Field]>
          >
          ? never
          : Field
        : Field
      : Field
    : Field;
}[keyof Contributor["fields"]];

type CompatibleThreadRecordOverride<
  Contributor extends RecordDefinition,
  Effective extends RecordDefinition,
> =
  Effective["fields"] extends RoundTripFieldDefinitions<Effective["fields"]>
    ? IncompatibleContributorFieldName<Contributor, Effective> extends never
      ? true
      : false
    : false;

/** Constraint that preserves contributed fields while allowing complete host fields. */
export type CompatibleThreadRecordOverrides<
  Records extends RecordDefinitions,
  Overrides extends RecordOverrides<ContributedThreadRecordDefinitions<Records>>,
  Contributors extends RecordDefinitions = ContributedThreadRecordDefinitions<Records>,
  Effective extends RecordDefinitions = ComposedRecordDefinitions<Records, Overrides>,
> = {
  readonly [Name in keyof Overrides]: Name extends keyof Contributors & keyof Effective
    ? CompatibleThreadRecordOverride<Contributors[Name], Effective[Name]> extends true
      ? Overrides[Name]
      : never
    : never;
};

/** Built-in create drafts that Core supplies before host hooks and validation. */
export type CoreCreateDrafts = {
  readonly thread: Pick<CreateInput<CoreRecordDefinitions["thread"]>, "id">;
  readonly branch: Pick<
    CreateInput<CoreRecordDefinitions["branch"]>,
    "id" | "threadId" | "name" | "head"
  >;
  readonly message: Pick<
    CreateInput<CoreRecordDefinitions["message"]>,
    "id" | "threadId" | "parent" | "message"
  >;
  readonly run: Pick<
    CreateInput<CoreRecordDefinitions["run"]>,
    | "id"
    | "threadId"
    | "branchId"
    | "agent"
    | "admittedHead"
    | "status"
    | "abortRequested"
    | "settlementContinuations"
  >;
  readonly toolCall: Pick<
    CreateInput<CoreRecordDefinitions["toolCall"]>,
    | "toolCallId"
    | "runId"
    | "sequence"
    | "toolName"
    | "parentToolCallId"
    | "providerId"
    | "delegationKey"
    | "requestedInput"
    | "status"
    | "providerData"
    | "historyCommitted"
  >;
  readonly executionClaim: CreateInput<CoreRecordDefinitions["executionClaim"]>;
  readonly executionFence: CreateInput<CoreRecordDefinitions["executionFence"]>;
  readonly pendingSteering: CreateInput<CoreRecordDefinitions["pendingSteering"]>;
  readonly pendingRedirect: CreateInput<CoreRecordDefinitions["pendingRedirect"]>;
  readonly runCommandSequence: CreateInput<CoreRecordDefinitions["runCommandSequence"]>;
  readonly toolCallSequence: CreateInput<CoreRecordDefinitions["toolCallSequence"]>;
  readonly runSubmission: CreateInput<CoreRecordDefinitions["runSubmission"]>;
  readonly toolResumeRequest: CreateInput<CoreRecordDefinitions["toolResumeRequest"]>;
  readonly steeringRequest: CreateInput<CoreRecordDefinitions["steeringRequest"]>;
  readonly redirectRequest: CreateInput<CoreRecordDefinitions["redirectRequest"]>;
  readonly commit: CreateInput<CoreRecordDefinitions["commit"]>;
  readonly finalizationOutcome: CreateInput<CoreRecordDefinitions["finalizationOutcome"]>;
  readonly modelCommitOutcome: CreateInput<CoreRecordDefinitions["modelCommitOutcome"]>;
  readonly settlementOutcome: CreateInput<CoreRecordDefinitions["settlementOutcome"]>;
};

/** Core Records created directly by public Commissary commands in version 1. */
export type CoreCommandCreatedRecordName = "thread" | "branch" | "run";

/** Core Records created without a command-provided fields bag in version 1. */
export type CoreInternallyCreatedRecordName = Exclude<
  keyof CoreRecordDefinitions,
  CoreCommandCreatedRecordName
>;

type RequiredCreateKeys<Definition extends RecordDefinition> = {
  readonly [Key in keyof Definition["fields"]]-?: undefined extends FieldInput<
    CreateFieldSchema<Definition["fields"][Key]>
  >
    ? never
    : Key;
}[keyof Definition["fields"]];

type CoreRecordName = keyof CoreRecordDefinitions;
type CoreCreatedRecordName = keyof CoreCreateDrafts & CoreRecordName;
type CommandCreatedRecordName = Extract<CoreCommandCreatedRecordName, CoreCreatedRecordName>;
type InternallyCreatedRecordName = Extract<CoreInternallyCreatedRecordName, CoreCreatedRecordName>;

type CustomFieldKeys<Name extends CoreRecordName, Definition extends RecordDefinition> = Exclude<
  keyof Definition["fields"],
  keyof CoreRecordDefinitions[Name]["fields"]
>;

type RequiredCustomCreateKeys<
  Name extends CoreCreatedRecordName,
  Definition extends RecordDefinition,
> = Extract<RequiredCreateKeys<Definition>, CustomFieldKeys<Name, Definition>>;

/** Unvalidated Core or host create draft received by one before-create hook. */
export type BeforeCreateDraft<
  Name extends keyof Definitions,
  Definitions extends RecordDefinitions,
> = Name extends keyof CoreCreateDrafts
  ? CoreCreateDrafts[Name] & Partial<CreateInput<Definitions[Name]>>
  : CreateInput<Definitions[Name]>;

/** One Collection hook that returns the complete strict create input. */
export interface BeforeCreateHook<
  Name extends keyof Definitions,
  Definitions extends RecordDefinitions,
> {
  readonly beforeCreate: (input: {
    readonly draft: BeforeCreateDraft<Name, Definitions>;
  }) => CreateInput<Definitions[Name]>;
}

/** Internal Core create paths whose required host fields need a hook. */
export type RequiredBeforeCreateHookNames<Definitions extends ThreadRecordDefinitions> = {
  readonly [Name in InternallyCreatedRecordName & keyof Definitions]: RequiredCustomCreateKeys<
    Name,
    Definitions[Name]
  > extends never
    ? never
    : Name;
}[InternallyCreatedRecordName & keyof Definitions];

/** Per-Collection before-create hooks for one effective Thread Store catalog. */
export type ThreadStoreHooks<Definitions extends ThreadRecordDefinitions> = {
  readonly [Name in RequiredBeforeCreateHookNames<Definitions>]-?: BeforeCreateHook<
    Name,
    Definitions
  >;
} & {
  readonly [Name in Exclude<
    keyof Definitions,
    RequiredBeforeCreateHookNames<Definitions>
  >]?: BeforeCreateHook<Name, Definitions>;
};

/** Hook configuration that becomes required when an internal create needs host data. */
export type ThreadStoreHooksConfig<Definitions extends ThreadRecordDefinitions> = [
  RequiredBeforeCreateHookNames<Definitions>,
] extends [never]
  ? { readonly hooks?: ThreadStoreHooks<Definitions> }
  : { readonly hooks: ThreadStoreHooks<Definitions> };

type CommandCustomCreateFields<
  Name extends CommandCreatedRecordName,
  Definitions extends ThreadRecordDefinitions,
> = Pick<CreateInput<Definitions[Name]>, CustomFieldKeys<Name, Definitions[Name]>>;

/** Command fields bag, required only when a custom create input is required. */
export type CommandFieldsConfig<
  Name extends CommandCreatedRecordName,
  Definitions extends ThreadRecordDefinitions,
> =
  RequiredCustomCreateKeys<Name, Definitions[Name]> extends never
    ? { readonly fields?: CommandCustomCreateFields<Name, Definitions> }
    : { readonly fields: CommandCustomCreateFields<Name, Definitions> };

/** Input for creating a Thread with host-defined Record fields. */
export type CreateThreadInput<Definitions extends ThreadRecordDefinitions> = {
  readonly id?: ThreadId;
} & CommandFieldsConfig<"thread", Definitions>;

/** Input for creating a Branch with host-defined Record fields. */
export type CreateBranchInput<Definitions extends ThreadRecordDefinitions> = {
  readonly id?: BranchId;
  readonly threadId: ThreadId;
  readonly name: string;
  readonly from?: MessageEntryId;
} & CommandFieldsConfig<"branch", Definitions>;

/** Factory configuration with separate new Record contributions and explicit overrides. */
export type ThreadStoreFactoryConfig<
  Records extends RecordDefinitions,
  Overrides extends RecordOverrides<ContributedThreadRecordDefinitions<Records>> = {},
> = {
  readonly records: Records &
    RoundTripRecordDefinitions<Records> &
    ThreadRecordContributions<Records>;
  readonly overrides?: Overrides & CompatibleThreadRecordOverrides<Records, Overrides>;
} & ThreadStoreHooksConfig<EffectiveRecordDefinitions<NoInfer<Records>, NoInfer<Overrides>>>;

/** Compose Core and host Record contributions with explicit compatible overrides. */
export function composeThreadStoreRecordDefinitions<
  const Records extends RecordDefinitions,
  const Overrides extends RecordOverrides<ContributedThreadRecordDefinitions<Records>> = {},
>(
  configuration: Pick<ThreadStoreFactoryConfig<Records, Overrides>, "records" | "overrides">,
): EffectiveRecordDefinitions<Records, Overrides> {
  for (const name of Reflect.ownKeys(configuration.records)) {
    if (Object.hasOwn(coreRecordDefinitions, name)) {
      throw new TypeError(`Duplicate Record contribution '${String(name)}'`);
    }
  }
  // SAFETY: The duplicate check proves that the spread adds only new Record names to the complete Core catalog.
  const contributions = {
    ...coreRecordDefinitions,
    ...configuration.records,
  } as ContributedThreadRecordDefinitions<Records> &
    RoundTripRecordDefinitions<ContributedThreadRecordDefinitions<Records>>;
  // SAFETY: ThreadStoreFactoryConfig checks the same selected, create, update, and round-trip compatibility per overridden field.
  const overrides = (configuration.overrides ?? {}) as Overrides &
    CompatibleRecordOverrides<ContributedThreadRecordDefinitions<Records>, Overrides>;
  // SAFETY: The public configuration checks override compatibility. Runtime composition preserves every contribution key.
  return applyRecordOverrides<ContributedThreadRecordDefinitions<Records>, Overrides>(
    contributions,
    overrides,
  ) as EffectiveRecordDefinitions<Records, Overrides>;
}

/** Existing durable entity output contracts remain assignable from built-in selected Records. */
export type CoreDurableRecordCompatibility = {
  readonly thread: SelectedRecord<CoreRecordDefinitions["thread"]> extends ThreadRecord
    ? true
    : false;
  readonly branch: SelectedRecord<CoreRecordDefinitions["branch"]> extends BranchRecord
    ? true
    : false;
  readonly message: SelectedRecord<CoreRecordDefinitions["message"]> extends MessageEntry
    ? true
    : false;
  readonly toolCall: SelectedRecord<CoreRecordDefinitions["toolCall"]> extends StoredToolCall
    ? true
    : false;
  readonly executionClaim: SelectedRecord<
    CoreRecordDefinitions["executionClaim"]
  > extends ExecutionClaim
    ? true
    : false;
};
