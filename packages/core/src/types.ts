declare const opaqueType: unique symbol;

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
export type RunId = Opaque<string, "RunId">;
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
