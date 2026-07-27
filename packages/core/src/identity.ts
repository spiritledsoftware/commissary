import type { AgentId, AgentRevision, BranchId, RunId, ThreadId } from "./types.js";

export interface AgentReference<Id extends string = string> {
  readonly id: AgentId<Id>;
  readonly revision: AgentRevision;
}

export interface RunIdentity<Id extends string = string> {
  readonly runId: RunId;
  readonly threadId: ThreadId;
  readonly branchId: BranchId;
  readonly agent: AgentReference<Id>;
}
