declare const opaqueType: unique symbol;
declare const runIdOwner: unique symbol;
declare const unboundRunOwner: unique symbol;

export type Opaque<Value, Name extends string> = Value & {
  readonly [opaqueType]: Name;
};

export type MaybePromise<Value> = Value | PromiseLike<Value>;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type AgentId<Value extends string = string> = Value;
export type AgentRevision = Opaque<string, "AgentRevision">;
export type ThreadId = Opaque<string, "ThreadId">;
export type BranchId = Opaque<string, "BranchId">;
export type MessageEntryId = Opaque<string, "MessageEntryId">;
export type RunId<Owner = unknown> = Opaque<string, "RunId"> & {
  readonly [runIdOwner]: Owner;
};
/** A Run ID whose successful admission proved ownership by one Agent definition. */
export type AgentRunId<Definition> = RunId<Definition>;
/** A stored Run ID decoded without Agent authority and checked by a bound client at runtime. */
export type DecodedRunId = RunId<{ readonly [unboundRunOwner]: true }>;
export type ExecutionId = Opaque<string, "ExecutionId">;
export type ExecutionClaimToken = Opaque<string, "ExecutionClaimToken">;
export type ToolCallId = Opaque<string, "ToolCallId">;
export type ToolAttemptId = Opaque<string, "ToolAttemptId">;
export type ArtifactId = Opaque<string, "ArtifactId">;
export type CommitId = Opaque<string, "CommitId">;
export type SteeringRequestId = string;
/** A caller-owned ID for one idempotent Redirect submission. */
export type RedirectRequestId = string;
export type ToolResumeRequestId = string;

/** A strict decoder for one opaque string ID at an external boundary. */
export interface OpaqueIdDecoder<Value extends string> {
  readonly decode: (input: unknown) => Value;
  readonly is: (input: unknown) => input is Value;
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: "commissary";
    readonly validate: (
      input: unknown,
    ) =>
      | { readonly value: Value; readonly issues?: undefined }
      | { readonly issues: readonly [{ readonly message: string }] };
    readonly types?: { readonly input: unknown; readonly output: Value };
  };
}

function opaqueIdDecoder<Value extends string>(name: string): OpaqueIdDecoder<Value> {
  const is = (input: unknown): input is Value => typeof input === "string" && input.length > 0;
  const decode = (input: unknown): Value => {
    if (!is(input)) {
      throw new TypeError(`${name} must be a non-empty string`);
    }
    return input;
  };
  return Object.freeze({
    decode,
    is,
    "~standard": Object.freeze({
      version: 1 as const,
      vendor: "commissary" as const,
      validate: (input: unknown) =>
        is(input)
          ? { value: input }
          : { issues: [{ message: `${name} must be a non-empty string` }] as const },
    }),
  });
}

/** Decode a non-empty installed Agent revision identifier. */
export const AgentRevision = opaqueIdDecoder<AgentRevision>("AgentRevision");
/** Decode a non-empty Thread identifier. */
export const ThreadId = opaqueIdDecoder<ThreadId>("ThreadId");
/** Decode a non-empty Branch identifier. */
export const BranchId = opaqueIdDecoder<BranchId>("BranchId");
/** Decode a non-empty Message Entry identifier. */
export const MessageEntryId = opaqueIdDecoder<MessageEntryId>("MessageEntryId");
/** Decode a non-empty Run identifier without granting Agent authority. */
export const RunId = opaqueIdDecoder<DecodedRunId>("RunId");
/** Decode a non-empty process-bound Execution identifier. */
export const ExecutionId = opaqueIdDecoder<ExecutionId>("ExecutionId");
/** Decode a non-empty fenced Execution Claim token. */
export const ExecutionClaimToken = opaqueIdDecoder<ExecutionClaimToken>("ExecutionClaimToken");
/** Decode a non-empty Tool Call identifier. */
export const ToolCallId = opaqueIdDecoder<ToolCallId>("ToolCallId");
/** Decode a non-empty Tool Attempt identifier. */
export const ToolAttemptId = opaqueIdDecoder<ToolAttemptId>("ToolAttemptId");
/** Decode a non-empty Artifact identifier. */
export const ArtifactId = opaqueIdDecoder<ArtifactId>("ArtifactId");
/** Decode a non-empty durable Commit identifier. */
export const CommitId = opaqueIdDecoder<CommitId>("CommitId");

export function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const object = value as { readonly [key: string]: JsonValue };
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key]!)}`)
    .join(",")}}`;
}

export function freeze<Value>(value: Value): Readonly<Value> {
  return Object.freeze(value);
}
