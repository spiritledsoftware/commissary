import type { RunIdentity } from "../identity.js";
import type { ModelRequest, ModelTool } from "../protocol.js";
import type { RuntimeModel } from "../render.js";
import type { PreparedModelWork, PreparedToolWork } from "../runtime.js";
import type { ExecutionSnapshot, StoredToolCall } from "../store.js";
import type { DynamicTool, ToolExecutionMode, ToolRuntimeDefinition } from "../tool.js";
import type { ToolCallId } from "../types.js";

/** One static or dynamic Tool available during an Execution. */
export type RuntimeTool =
  | {
      readonly type: "static";
      readonly definition: ToolRuntimeDefinition;
    }
  | {
      readonly type: "dynamic";
      readonly providerId: string;
      readonly definition: DynamicTool;
      readonly modelTool: ModelTool;
    };

/** State shared by prepared Model and Tool work. */
export interface PreparedStateBase {
  readonly snapshot: ExecutionSnapshot;
  readonly run: RunIdentity;
  readonly tools: ReadonlyMap<string, RuntimeTool>;
  readonly resolveDynamicProvider: (
    providerId: string,
  ) => Promise<ReadonlyMap<string, RuntimeTool>>;
}

/** Private state for one prepared Model invocation. */
export interface PreparedModelState extends PreparedStateBase {
  readonly prepared: PreparedModelWork;
  readonly model: RuntimeModel;
  readonly request: ModelRequest;
}

/** Private state for one prepared Tool batch. */
export interface PreparedToolState extends PreparedStateBase {
  readonly prepared: PreparedToolWork;
  readonly outcomes: Map<ToolCallId, StoredToolCall>;
  readonly executionMode: ToolExecutionMode;
}

/** Private state for Runtime-prepared work. */
export type PreparedState = PreparedModelState | PreparedToolState;

/** Test whether prepared state contains Model work. */
export function isPreparedModelState(state: PreparedState): state is PreparedModelState {
  return state.prepared.type === "model";
}

/** Test whether prepared state contains Tool work. */
export function isPreparedToolState(state: PreparedState): state is PreparedToolState {
  return state.prepared.type === "tools";
}
