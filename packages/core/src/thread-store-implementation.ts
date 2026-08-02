import {
  TransactionConflictError,
  type BaseStoreOperatorTypes,
  type Collection,
  type CreateInput,
  type RecordDefinition,
  type SelectedRecord,
  type Store,
  type StoreCollections,
  type TransactionStore,
} from "@commissary/store";

import type { AgentReference } from "./identity.js";
import { coreRecordDefinitions } from "./store-records.js";
import type { ModelMessage, ModelRunUsage, ModelUsage, RunUsage } from "./protocol.js";
import type {
  AbortResult,
  AcceptedRun,
  BranchConflict,
  Clock,
  Interruption,
  RedirectResult,
  RunConflict,
  RunResult,
  SteeringResult,
  SuspendedRunResult,
  ToolResumeConflict,
  ToolResumeRequestConflict,
} from "./runtime.js";
import {
  addThreadStoreCreateHooks,
  type AppendMessagesInput,
  type BranchRecord,
  type CommitModelInvocationInput,
  type CommitModelInvocationStoreResult,
  type CommitStepInput,
  type CommitToolResultsInput,
  type CompleteToolCallInput,
  type ContinueSettlementInput,
  type ContinueSettlementStoreResult,
  type CoreRecordDefinitions,
  type ClaimRenewalResult,
  type CoreStoreOperatorTypes,
  type ClaimResult,
  type ExecutionClaim,
  type ExecutionControl,
  type ExecutionSnapshot,
  type FinalizeRunStoreInput,
  type FinalizeRunStoreResult,
  type GuardedStoreResult,
  type MessageEntry,
  type PendingRedirect,
  type PendingSteering,
  type RecordDelegatedToolCallInput,
  type RecordModelCallInput,
  type RecordToolInputInput,
  type RunRecord,
  type RunResultRecord,
  type StoredToolCall,
  type SubmitRunStoreInput,
  type SuspendToolCallInput,
  type ThreadRecord,
  type SuspendRunStoreResult,
  type ThreadRecordDefinitions,
  type ThreadStore,
  type ThreadStoreHooks,
  type ThreadStoreRunSnapshot,
  type ToolResumeContext,
} from "./store.js";
import {
  ExecutionClaimToken,
  ThreadId,
  type BranchId,
  type CommitId,
  type ExecutionId,
  type JsonValue,
  type MessageEntryId,
  type RedirectRequestId,
  type RunId,
  type SteeringRequestId,
  type ToolCallId,
  type ToolResumeRequestId,
} from "./types.js";

interface ControlWaiter {
  readonly token: ExecutionClaimToken;
  readonly resolve: (control: ExecutionControl) => void;
  readonly reject: (cause: unknown) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

interface ControlNotification {
  readonly runId: RunId;
  readonly control: ExecutionControl;
  readonly token?: ExecutionClaimToken;
}

interface ResumeRequestRecord {
  readonly runId: RunId;
  readonly requestId: ToolResumeRequestId;
  readonly fingerprint: string;
  readonly result: AcceptedRun;
}

interface ToolCallGraph {
  readonly calls: Map<ToolCallId, StoredToolCall>;
  readonly order: ToolCallId[];
  readonly delegated: Map<ToolCallId, Map<string, ToolCallId>>;
  readonly resumable: Set<ToolCallId>;
  nextSequence: number;
}

interface SteeringRequestRecord {
  readonly runId: RunId;
  readonly requestId: SteeringRequestId;
  readonly fingerprint: string;
  readonly result: SteeringResult;
}

interface RedirectRequestRecord {
  readonly runId: RunId;
  readonly requestId: RedirectRequestId;
  readonly fingerprint: string;
  readonly result: RedirectResult;
}

/** Dependencies for the Core-owned Thread Store specialization. */
export interface CoreThreadStoreOptions<
  Definitions extends ThreadRecordDefinitions,
  Operators extends CoreStoreOperatorTypes = BaseStoreOperatorTypes,
> {
  /** Transaction Store over the complete effective Core and Custom Record catalog. */
  readonly backend: TransactionStore<Definitions, Operators>;
  /** Backend clock used for Claim expiry calculations. */
  readonly clock?: Pick<Clock, "now">;
  /** Host before-create hooks for effective Record inputs. */
  readonly hooks?: ThreadStoreHooks<Definitions>;
}

type CoreRecordName = keyof CoreRecordDefinitions;
type CoreStoredRecord = Readonly<Record<string, unknown>>;

const coreRecordKeyFields = {
  thread: ["id"],
  branch: ["id"],
  message: ["id"],
  run: ["id"],
  toolCall: ["runId", "toolCallId"],
  executionClaim: ["runId"],
  executionFence: ["runId"],
  pendingSteering: ["runId", "sequence"],
  pendingRedirect: ["runId", "sequence"],
  runCommandSequence: ["runId"],
  toolCallSequence: ["runId"],
  runSubmission: ["runId"],
  toolResumeRequest: ["runId", "requestId"],
  steeringRequest: ["runId", "requestId"],
  redirectRequest: ["runId", "requestId"],
  commit: ["commitId"],
  finalizationOutcome: ["commitId"],
  modelCommitOutcome: ["commitId"],
  settlementOutcome: ["commitId"],
} as const satisfies Readonly<Record<CoreRecordName, readonly string[]>>;

function mergePersistedCoreRecord(
  name: CoreRecordName,
  stored: CoreStoredRecord,
  current: CoreStoredRecord,
): CoreStoredRecord {
  const merged: Record<string, unknown> = { ...stored, ...current };
  for (const field of Object.keys(coreRecordDefinitions[name].fields)) {
    if (!Object.hasOwn(current, field)) {
      delete merged[field];
    }
  }
  return Object.freeze(merged);
}
interface CoreThreadStoreStateOptions<
  Definitions extends ThreadRecordDefinitions,
  Operators extends CoreStoreOperatorTypes,
> {
  readonly store: Store<Definitions, Operators>;
  readonly clock?: Pick<Clock, "now">;
  readonly controlWaiters: Map<RunId, Set<ControlWaiter>>;
}

function canonical(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  return `{${Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(",")}}`;
}

function requestKey(runId: RunId, requestId: string): string {
  return canonical([runId, requestId]);
}

function same(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function requireThreadStoreState<Value>(value: Value | undefined, description: string): Value {
  if (value === undefined) {
    throw new Error(`Thread Store state is missing ${description}`);
  }
  return value;
}

function terminal(status: RunRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "aborted";
}

function addTokenCount(left: number | undefined, right: number | undefined): number | undefined {
  return left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
}

function emptyModelUsage(): ModelUsage {
  return Object.freeze({
    input: Object.freeze({}),
    output: Object.freeze({}),
  });
}

function addUsage(current: ModelUsage | undefined, delta: ModelUsage): ModelUsage {
  const inputTotal = addTokenCount(current?.input.total, delta.input.total);
  const inputUncached = addTokenCount(current?.input.uncached, delta.input.uncached);
  const cacheRead = addTokenCount(current?.input.cacheRead, delta.input.cacheRead);
  const cacheWrite = addTokenCount(current?.input.cacheWrite, delta.input.cacheWrite);
  const outputTotal = addTokenCount(current?.output.total, delta.output.total);
  const outputText = addTokenCount(current?.output.text, delta.output.text);
  const outputReasoning = addTokenCount(current?.output.reasoning, delta.output.reasoning);
  const totalTokens = addTokenCount(current?.totalTokens, delta.totalTokens);
  return Object.freeze({
    input: Object.freeze({
      ...(inputTotal === undefined ? {} : { total: inputTotal }),
      ...(inputUncached === undefined ? {} : { uncached: inputUncached }),
      ...(cacheRead === undefined ? {} : { cacheRead }),
      ...(cacheWrite === undefined ? {} : { cacheWrite }),
    }),
    output: Object.freeze({
      ...(outputTotal === undefined ? {} : { total: outputTotal }),
      ...(outputText === undefined ? {} : { text: outputText }),
      ...(outputReasoning === undefined ? {} : { reasoning: outputReasoning }),
    }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  });
}

function emptyRunUsage(): RunUsage {
  return Object.freeze({
    total: emptyModelUsage(),
    models: Object.freeze([]),
  });
}

async function recordDelegatedToolCallInStore<
  Definitions extends ThreadRecordDefinitions,
  Operators extends CoreStoreOperatorTypes,
>(
  store: Store<Definitions, Operators>,
  now: () => number,
  input: RecordDelegatedToolCallInput,
): Promise<GuardedStoreResult<StoredToolCall>> {
  // SAFETY: ThreadRecordDefinitions preserves each built-in Core Collection output while allowing additional host fields.
  const runs = store.collections.run as unknown as Collection<
    CoreRecordDefinitions["run"],
    Operators
  >;
  const claims = store.collections.executionClaim as unknown as Collection<
    CoreRecordDefinitions["executionClaim"],
    Operators
  >;
  const toolCalls = store.collections.toolCall as unknown as Collection<
    CoreRecordDefinitions["toolCall"],
    Operators
  >;
  const toolCallSequences = store.collections.toolCallSequence as unknown as Collection<
    CoreRecordDefinitions["toolCallSequence"],
    Operators
  >;
  const [runRecords, claimRecords, relevantCallRecords, sequenceRecords] = await Promise.all([
    runs.find({
      where: (fields, operators) => operators.eq(fields.id, input.claim.runId),
    }),
    claims.find({
      where: (fields, operators) => operators.eq(fields.runId, input.claim.runId),
    }),
    toolCalls.find({
      where: (fields, operators) =>
        operators.and(
          operators.eq(fields.runId, input.claim.runId),
          operators.or(
            operators.eq(fields.toolCallId, input.parentToolCallId),
            operators.eq(fields.toolCallId, input.toolCallId),
            operators.and(
              operators.eq(fields.parentToolCallId, input.parentToolCallId),
              operators.eq(fields.delegationKey, input.key),
            ),
          ),
        ),
    }),
    toolCallSequences.find({
      where: (fields, operators) => operators.eq(fields.runId, input.claim.runId),
    }),
  ]);

  // SAFETY: Each result was selected through the matching built-in Core Record Definition above.
  const currentClaim = claimRecords[0] as ExecutionClaim | undefined;
  if (
    currentClaim?.token !== input.claim.token ||
    currentClaim.fence !== input.claim.fence ||
    currentClaim.executionId !== input.claim.executionId ||
    input.claim.expiresAt <= now()
  ) {
    return { type: "claim-lost" };
  }

  const run = runRecords[0] as RunRecord | undefined;
  if (run === undefined) {
    throw new Error(`Unknown Run '${input.claim.runId}'`);
  }
  if (terminal(run.status)) {
    return {
      type: "not-active",
      ...(run.result === undefined ? {} : { result: run.result }),
    };
  }
  if (run.abortRequested) {
    return {
      type: "abort-requested",
      ...(run.abortReason === undefined ? {} : { reason: run.abortReason }),
    };
  }

  // SAFETY: relevantCallRecords comes only from the effective Tool Call Collection, whose Core fields are compatible.
  const relevantCalls = relevantCallRecords as readonly StoredToolCall[];
  const parent = relevantCalls.find((call) => call.toolCallId === input.parentToolCallId);
  if (parent === undefined) {
    throw new Error(`Unknown Tool Call '${input.parentToolCallId}'`);
  }
  const current = relevantCalls.find(
    (call) => call.parentToolCallId === input.parentToolCallId && call.delegationKey === input.key,
  );
  if (current !== undefined) {
    if (
      current.toolName !== input.toolName ||
      current.providerId !== input.providerId ||
      !same(current.requestedInput, input.input)
    ) {
      throw new Error(`Delegation key '${input.key}' was reused with different data`);
    }
    return { type: "committed", value: current };
  }
  if (relevantCalls.some((call) => call.toolCallId === input.toolCallId)) {
    throw new Error(`Tool Call ID '${input.toolCallId}' is already in use`);
  }

  const sequenceRecord = sequenceRecords[0];
  const sequence = (sequenceRecord?.sequence ?? 0) + 1;
  if (sequenceRecord === undefined) {
    await toolCallSequences.create({
      runId: input.claim.runId,
      sequence,
    });
  } else {
    await toolCallSequences.update({
      where: (fields, operators) => operators.eq(fields.runId, input.claim.runId),
      set: { sequence },
    });
  }

  // SAFETY: The effective Tool Call Definition preserves all Core StoredToolCall output fields.
  const stored = (await toolCalls.create({
    toolCallId: input.toolCallId,
    runId: input.claim.runId,
    sequence,
    toolName: input.toolName,
    parentToolCallId: input.parentToolCallId,
    ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
    delegationKey: input.key,
    requestedInput: input.input,
    status: "pending",
    historyCommitted: false,
  })) as StoredToolCall;
  return { type: "committed", value: stored };
}

/** Core-owned Thread Store transitions over one adapter Transaction Store. */
class CoreThreadStore<
  Definitions extends ThreadRecordDefinitions,
  Operators extends CoreStoreOperatorTypes,
> {
  /** Every Core and Custom Collection in this Thread Store. */
  readonly collections: StoreCollections<Definitions, Operators>;
  readonly #now: () => number;
  readonly #baselineRecords = new Map<CoreRecordName, Map<string, CoreStoredRecord>>();
  readonly #threads = new Map<ThreadId, ThreadRecord>();
  readonly #branches = new Map<BranchId, BranchRecord>();
  readonly #entries = new Map<MessageEntryId, MessageEntry>();
  readonly #runs = new Map<RunId, RunRecord>();
  readonly #claims = new Map<RunId, ExecutionClaim>();
  readonly #fences = new Map<RunId, number>();
  readonly #pendingSteering = new Map<RunId, PendingSteering[]>();
  readonly #pendingRedirects = new Map<RunId, PendingRedirect[]>();
  readonly #commandSequences = new Map<RunId, number>();
  readonly #toolCalls = new Map<RunId, ToolCallGraph>();
  readonly #startFingerprints = new Map<RunId, string>();
  readonly #startSubmissions = new Map<RunId, AcceptedRun>();
  readonly #resumeRequests = new Map<string, ResumeRequestRecord>();
  readonly #steeringRequests = new Map<string, SteeringRequestRecord>();
  readonly #redirectRequests = new Map<string, RedirectRequestRecord>();
  readonly #commits = new Map<string, string>();
  readonly #finalizationOutcomes = new Map<CommitId, FinalizeRunStoreResult<Definitions>>();
  readonly #modelCommitOutcomes = new Map<
    CommitId,
    CommitModelInvocationStoreResult<Definitions>
  >();
  readonly #settlementOutcomes = new Map<CommitId, ContinueSettlementStoreResult<Definitions>>();
  readonly #controlWaiters: Map<RunId, Set<ControlWaiter>>;
  readonly #controlNotifications: ControlNotification[] = [];

  constructor(options: CoreThreadStoreStateOptions<Definitions, Operators>) {
    this.#now = options.clock?.now ?? Date.now;
    this.#controlWaiters = options.controlWaiters;
    this.collections = options.store.collections;
  }

  publishControlNotifications(): void {
    for (const notification of this.#controlNotifications) {
      for (const waiter of this.#controlWaiters.get(notification.runId) ?? []) {
        if (notification.token === undefined || waiter.token === notification.token) {
          this.#settleWaiter(notification.runId, waiter, notification.control);
        }
      }
    }
  }

  async loadState(): Promise<void> {
    // SAFETY: coreRecordKeyFields contains every and only Core Collection name, and each selected Record is converted below to the matching Core runtime shape.
    const names = Object.keys(coreRecordKeyFields) as CoreRecordName[];
    const loaded = new Map(
      await Promise.all(
        names.map(async (name) => {
          const records = await this.#collection(name).find();
          return [name, records.map((record) => record as CoreStoredRecord)] as const;
        }),
      ),
    );

    for (const name of names) {
      this.#rememberBaselineRecords(name, loaded.get(name) ?? []);
    }

    for (const record of loaded.get("thread") ?? []) {
      const thread = record as unknown as ThreadRecord;
      this.#threads.set(thread.id, thread);
    }
    for (const record of loaded.get("branch") ?? []) {
      const branch = record as unknown as BranchRecord;
      this.#branches.set(branch.id, branch);
    }
    for (const record of loaded.get("message") ?? []) {
      const entry = record as unknown as MessageEntry;
      this.#entries.set(entry.id, entry);
    }
    for (const record of loaded.get("run") ?? []) {
      const run = record as unknown as RunRecord;
      this.#runs.set(run.id, run);
      this.#toolCalls.set(run.id, {
        calls: new Map(),
        order: [],
        delegated: new Map(),
        resumable: new Set(),
        nextSequence: 0,
      });
    }
    for (const record of loaded.get("executionClaim") ?? []) {
      const claim = record as unknown as ExecutionClaim;
      this.#claims.set(claim.runId, claim);
    }
    for (const record of loaded.get("executionFence") ?? []) {
      const fence = record as unknown as {
        readonly runId: RunId;
        readonly fence: number;
      };
      this.#fences.set(fence.runId, fence.fence);
    }
    for (const record of loaded.get("pendingSteering") ?? []) {
      const pending = record as unknown as PendingSteering & {
        readonly runId: RunId;
      };
      const values = this.#pendingSteering.get(pending.runId) ?? [];
      values.push({ sequence: pending.sequence, message: pending.message });
      this.#pendingSteering.set(pending.runId, values);
    }
    for (const values of this.#pendingSteering.values()) {
      values.sort((left, right) => left.sequence - right.sequence);
    }
    for (const record of loaded.get("pendingRedirect") ?? []) {
      const pending = record as unknown as PendingRedirect & {
        readonly runId: RunId;
      };
      const values = this.#pendingRedirects.get(pending.runId) ?? [];
      values.push({ sequence: pending.sequence, message: pending.message });
      this.#pendingRedirects.set(pending.runId, values);
    }
    for (const values of this.#pendingRedirects.values()) {
      values.sort((left, right) => left.sequence - right.sequence);
    }
    for (const record of loaded.get("runCommandSequence") ?? []) {
      const sequence = record as unknown as {
        readonly runId: RunId;
        readonly sequence: number;
      };
      this.#commandSequences.set(sequence.runId, sequence.sequence);
    }

    const toolCalls = [...(loaded.get("toolCall") ?? [])]
      .map((record) => record as unknown as StoredToolCall)
      .sort((left, right) => left.sequence - right.sequence);
    for (const call of toolCalls) {
      let graph = this.#toolCalls.get(call.runId);
      if (graph === undefined) {
        graph = {
          calls: new Map(),
          order: [],
          delegated: new Map(),
          resumable: new Set(),
          nextSequence: 0,
        };
        this.#toolCalls.set(call.runId, graph);
      }
      this.#setCall(graph, call);
    }
    for (const record of loaded.get("toolCallSequence") ?? []) {
      const sequence = record as unknown as {
        readonly runId: RunId;
        readonly sequence: number;
      };
      const graph = this.#toolCalls.get(sequence.runId);
      if (graph !== undefined) {
        graph.nextSequence = Math.max(graph.nextSequence, sequence.sequence);
      }
    }
    for (const record of loaded.get("runSubmission") ?? []) {
      const submission = record as unknown as {
        readonly runId: RunId;
        readonly fingerprint: string;
        readonly result: AcceptedRun;
      };
      this.#startFingerprints.set(submission.runId, submission.fingerprint);
      this.#startSubmissions.set(submission.runId, submission.result);
    }
    for (const record of loaded.get("toolResumeRequest") ?? []) {
      const request = record as unknown as ResumeRequestRecord;
      this.#resumeRequests.set(requestKey(request.runId, request.requestId), request);
    }
    for (const record of loaded.get("steeringRequest") ?? []) {
      const request = record as unknown as SteeringRequestRecord;
      this.#steeringRequests.set(requestKey(request.runId, request.requestId), request);
    }
    for (const record of loaded.get("redirectRequest") ?? []) {
      const request = record as unknown as RedirectRequestRecord;
      this.#redirectRequests.set(requestKey(request.runId, request.requestId), request);
    }
    for (const record of loaded.get("commit") ?? []) {
      const commit = record as unknown as {
        readonly commitId: CommitId;
        readonly fingerprint: string;
      };
      this.#commits.set(commit.commitId, commit.fingerprint);
    }
    for (const record of loaded.get("finalizationOutcome") ?? []) {
      const outcome = record as unknown as {
        readonly commitId: CommitId;
        readonly outcome: FinalizeRunStoreResult<Definitions>;
      };
      this.#finalizationOutcomes.set(outcome.commitId, outcome.outcome);
    }
    for (const record of loaded.get("modelCommitOutcome") ?? []) {
      const outcome = record as unknown as {
        readonly commitId: CommitId;
        readonly outcome: CommitModelInvocationStoreResult<Definitions>;
      };
      this.#modelCommitOutcomes.set(outcome.commitId, outcome.outcome);
    }
    for (const record of loaded.get("settlementOutcome") ?? []) {
      const outcome = record as unknown as {
        readonly commitId: CommitId;
        readonly outcome: ContinueSettlementStoreResult<Definitions>;
      };
      this.#settlementOutcomes.set(outcome.commitId, outcome.outcome);
    }
  }

  async persistState(): Promise<void> {
    // SAFETY: coreRecordKeyFields contains every and only Core Collection name.
    for (const name of Object.keys(coreRecordKeyFields) as CoreRecordName[]) {
      await this.#persistCollection(name, this.#currentRecords(name));
    }
  }

  #collection(name: CoreRecordName): Collection<RecordDefinition, Operators> {
    // SAFETY: ThreadRecordDefinitions guarantees a Collection for every Core Record name.
    return this.collections[name] as unknown as Collection<RecordDefinition, Operators>;
  }

  #rememberBaselineRecords(name: CoreRecordName, records: readonly CoreStoredRecord[]): void {
    const keyed = new Map<string, CoreStoredRecord>();
    for (const record of records) {
      keyed.set(this.#recordKey(name, record), record);
    }
    this.#baselineRecords.set(name, keyed);
  }

  #rememberCreatedRecord(name: CoreRecordName, record: CoreStoredRecord): void {
    let baseline = this.#baselineRecords.get(name);
    if (baseline === undefined) {
      baseline = new Map();
      this.#baselineRecords.set(name, baseline);
    }
    baseline.set(this.#recordKey(name, record), record);
  }

  #recordKey(name: CoreRecordName, record: CoreStoredRecord): string {
    return canonical(coreRecordKeyFields[name].map((field) => Reflect.get(record, field)));
  }

  #currentRecords(name: CoreRecordName): readonly CoreStoredRecord[] {
    // SAFETY: Every map below contains records loaded from, or created through, its matching Core Collection.
    switch (name) {
      case "thread":
        return [...this.#threads.values()] as unknown as CoreStoredRecord[];
      case "branch":
        return [...this.#branches.values()] as unknown as CoreStoredRecord[];
      case "message":
        return [...this.#entries.values()] as unknown as CoreStoredRecord[];
      case "run":
        return [...this.#runs.values()] as unknown as CoreStoredRecord[];
      case "toolCall":
        return [...this.#toolCalls.values()].flatMap((graph) =>
          graph.order.map(
            (toolCallId) => graph.calls.get(toolCallId) as unknown as CoreStoredRecord,
          ),
        );
      case "executionClaim":
        return [...this.#claims.values()] as unknown as CoreStoredRecord[];
      case "executionFence":
        return [...this.#fences].map(([runId, fence]) => ({ runId, fence }));
      case "pendingSteering":
        return [...this.#pendingSteering].flatMap(([runId, pending]) =>
          pending.map((value) => ({ runId, ...value })),
        );
      case "pendingRedirect":
        return [...this.#pendingRedirects].flatMap(([runId, pending]) =>
          pending.map((value) => ({ runId, ...value })),
        );
      case "runCommandSequence":
        return [...this.#commandSequences].map(([runId, sequence]) => ({
          runId,
          sequence,
        }));
      case "toolCallSequence":
        return [...this.#toolCalls].map(([runId, graph]) => ({
          runId,
          sequence: graph.nextSequence,
        }));
      case "runSubmission":
        return [...this.#startFingerprints].map(([runId, fingerprint]) => ({
          runId,
          fingerprint,
          result: requireThreadStoreState(
            this.#startSubmissions.get(runId),
            `Run Submission '${runId}'`,
          ),
        }));
      case "toolResumeRequest":
        return [...this.#resumeRequests.values()] as unknown as CoreStoredRecord[];
      case "steeringRequest":
        return [...this.#steeringRequests.values()] as unknown as CoreStoredRecord[];
      case "redirectRequest":
        return [...this.#redirectRequests.values()] as unknown as CoreStoredRecord[];
      case "commit":
        return [...this.#commits].map(([commitId, fingerprint]) => ({
          commitId,
          fingerprint,
        }));
      case "finalizationOutcome":
        return [...this.#finalizationOutcomes].map(([commitId, outcome]) => ({
          commitId,
          outcome,
        }));
      case "modelCommitOutcome":
        return [...this.#modelCommitOutcomes].map(([commitId, outcome]) => ({
          commitId,
          outcome,
        }));
      case "settlementOutcome":
        return [...this.#settlementOutcomes].map(([commitId, outcome]) => ({
          commitId,
          outcome,
        }));
    }
  }

  async #persistCollection(
    name: CoreRecordName,
    currentRecords: readonly CoreStoredRecord[],
  ): Promise<void> {
    const collection = this.#collection(name);
    const baseline = this.#baselineRecords.get(name) ?? new Map();
    const current = new Map<string, CoreStoredRecord>();

    for (const record of currentRecords) {
      const key = this.#recordKey(name, record);
      const stored = baseline.get(key);
      current.set(
        key,
        stored === undefined ? record : mergePersistedCoreRecord(name, stored, record),
      );
    }

    for (const [key, stored] of baseline) {
      if (!current.has(key)) {
        await collection.delete({
          where: this.#recordWhere(name, stored),
        });
      }
    }

    for (const [key, record] of current) {
      const stored = baseline.get(key);
      if (stored === undefined) {
        await collection.create(record);
        continue;
      }
      if (same(stored, record)) {
        continue;
      }
      const set: Record<string, JsonValue | undefined> = {};
      for (const field of new Set([...Object.keys(stored), ...Object.keys(record)])) {
        const previous = Reflect.get(stored, field);
        const next = Reflect.get(record, field);
        if (!same(previous, next)) {
          // SAFETY: Core state contains JSON-compatible selected Field values or undefined for omission.
          set[field] = next as JsonValue | undefined;
        }
      }
      await collection.update({
        set,
        where: this.#recordWhere(name, stored),
      });
    }
  }

  #recordWhere(
    name: CoreRecordName,
    record: CoreStoredRecord,
  ): NonNullable<
    NonNullable<Parameters<Collection<RecordDefinition, Operators>["delete"]>[0]>["where"]
  > {
    return (fields, operators) =>
      operators.and(
        ...coreRecordKeyFields[name].map((field) =>
          // SAFETY: Core Record key fields are required JSON-compatible selected values.
          operators.eq(Reflect.get(fields, field), Reflect.get(record, field) as JsonValue),
        ),
      );
  }
  async createThread(
    record: CreateInput<Definitions["thread"]>,
  ): Promise<SelectedRecord<Definitions["thread"]>> {
    const requestedId = Reflect.get(record, "id");
    if (typeof requestedId === "string" && requestedId.length > 0) {
      const requestedThreadId = ThreadId.decode(requestedId);
      const current = this.#threads.get(requestedThreadId);
      if (current !== undefined) {
        // SAFETY: This Thread was loaded through the effective Thread Definition and retains all host fields.
        return current as unknown as SelectedRecord<Definitions["thread"]>;
      }
    }

    const stored = await this.collections.thread.create(record);
    const storedId = ThreadId.decode(Reflect.get(stored, "id"));
    // SAFETY: The effective Thread Definition preserves the built-in Thread fields used by Core.
    this.#threads.set(storedId, stored as unknown as ThreadRecord);
    this.#rememberCreatedRecord("thread", stored as CoreStoredRecord);
    return stored;
  }

  async readThread(threadId: ThreadId): Promise<SelectedRecord<Definitions["thread"]> | undefined> {
    // SAFETY: Every cached Thread was loaded through the effective Thread Definition and retains host fields.
    return this.#threads.get(threadId) as SelectedRecord<Definitions["thread"]> | undefined;
  }

  async createBranch(input: {
    readonly branch: CreateInput<Definitions["branch"]>;
    readonly from?: MessageEntryId;
  }): Promise<SelectedRecord<Definitions["branch"]>> {
    // SAFETY: The public create input preserves every built-in Branch input field required by Core.
    const branchInput = input.branch as unknown as BranchRecord;
    if (!this.#threads.has(branchInput.threadId)) {
      throw new Error(`Unknown Thread '${branchInput.threadId}'`);
    }
    const current = this.#branches.get(branchInput.id);
    if (current !== undefined) {
      if (!same(current, branchInput)) {
        throw new Error(`Branch '${branchInput.id}' already exists with different data`);
      }
      // SAFETY: This Branch was loaded through the effective Branch Definition and retains all host fields.
      return current as unknown as SelectedRecord<Definitions["branch"]>;
    }
    if (input.from !== undefined) {
      const entry = this.#entries.get(input.from);
      if (entry === undefined || entry.threadId !== branchInput.threadId) {
        throw new Error(`Unknown source Message '${input.from}'`);
      }
    }
    const draft = Object.freeze({
      ...input.branch,
      ...(input.from === undefined ? {} : { head: input.from }),
    });
    // SAFETY: The draft contains the supplied effective input plus the Core-owned head field.
    const stored = await this.collections.branch.create(
      draft as CreateInput<Definitions["branch"]>,
    );
    // SAFETY: The effective Branch Definition preserves every built-in Branch output used by Core.
    const branch = stored as unknown as BranchRecord;
    this.#branches.set(branch.id, branch);
    this.#rememberCreatedRecord("branch", stored as CoreStoredRecord);
    return stored;
  }

  readBranch(input: {
    readonly threadId: ThreadId;
    readonly branchId: BranchId;
  }): PromiseLike<BranchRecord | undefined> {
    const branch = this.#branches.get(input.branchId);
    return Promise.resolve(branch?.threadId === input.threadId ? branch : undefined);
  }

  renameBranch(input: {
    readonly threadId: ThreadId;
    readonly branchId: BranchId;
    readonly name: string;
  }): PromiseLike<BranchRecord> {
    const current = this.#branch(input.threadId, input.branchId);
    const branch = Object.freeze({ ...current, name: input.name });
    this.#branches.set(branch.id, branch);
    return Promise.resolve(branch);
  }

  readBranchHistory(input: {
    readonly threadId: ThreadId;
    readonly branchId: BranchId;
  }): PromiseLike<readonly MessageEntry[]> {
    const branch = this.#branch(input.threadId, input.branchId);
    const path: MessageEntry[] = [];
    let entryId = branch.head;
    while (entryId !== undefined) {
      const entry = this.#entries.get(entryId);
      if (entry === undefined || entry.threadId !== input.threadId) {
        throw new Error(`Broken Message path at '${entryId}'`);
      }
      path.push(entry);
      entryId = entry.parent;
    }
    return Promise.resolve(Object.freeze(path.reverse()));
  }

  appendMessages(input: AppendMessagesInput): PromiseLike<BranchRecord> {
    const fingerprint = this.#newCommit(input.commitId, input);
    if (fingerprint === undefined) {
      return Promise.resolve(this.#branch(input.threadId, input.branchId));
    }
    const branch = this.#branch(input.threadId, input.branchId);
    const expectedHead = input.expectedHead ?? branch.head;
    const updated = this.#append(input.threadId, input.branchId, expectedHead, input.entries);
    this.#commits.set(input.commitId, fingerprint);
    return Promise.resolve(updated);
  }

  submitRun(
    input: SubmitRunStoreInput<Definitions>,
  ): PromiseLike<AcceptedRun | BranchConflict | RunConflict> {
    const fingerprint = canonical({
      agent: input.agent,
      threadId: input.threadId,
      branchId: input.branchId,
      message: input.message,
      expectedHead: input.expectedHead,
      fields: input.fields,
    });
    const current = this.#runs.get(input.runId);
    if (current !== undefined) {
      if (this.#startFingerprints.get(input.runId) !== fingerprint) {
        return Promise.resolve({ type: "run-conflict", runId: input.runId });
      }
      const prior = requireThreadStoreState(
        this.#startSubmissions.get(input.runId),
        `Run Submission '${input.runId}'`,
      );
      return Promise.resolve(Object.freeze({ ...prior, admitted: false }));
    }

    const branch = this.#branch(input.threadId, input.branchId);
    if (input.expectedHead !== undefined && branch.head !== input.expectedHead) {
      return Promise.resolve({
        type: "branch-conflict",
        expectedHead: input.expectedHead,
        ...(branch.head === undefined ? {} : { actualHead: branch.head }),
      });
    }
    const expectedHead = input.expectedHead ?? branch.head;
    const updated = this.#append(input.threadId, input.branchId, expectedHead, [
      { id: input.entryId, message: input.message },
    ]);
    const run: RunRecord = Object.freeze({
      ...input.fields,
      id: input.runId,
      threadId: input.threadId,
      branchId: input.branchId,
      agent: input.agent,
      admittedHead: input.entryId,
      status: "active",
      abortRequested: false,
      settlementContinuations: 0,
    });
    this.#runs.set(run.id, run);
    this.#toolCalls.set(run.id, {
      calls: new Map(),
      order: [],
      delegated: new Map(),
      resumable: new Set(),
      nextSequence: 0,
    });
    const head = requireThreadStoreState(updated.head, `Branch head '${run.branchId}'`);
    const submission: AcceptedRun = Object.freeze({
      type: "accepted",
      runId: run.id,
      threadId: run.threadId,
      branchId: run.branchId,
      head,
      agent: run.agent,
      admitted: true,
    });
    this.#startFingerprints.set(run.id, fingerprint);
    this.#startSubmissions.set(run.id, submission);
    this.#commits.set(input.commitId, canonical(input));
    return Promise.resolve(submission);
  }

  submitToolResumes(input: {
    readonly runId: RunId;
    readonly agent: AgentReference;
    readonly expectedHead: MessageEntryId;
    readonly items: readonly {
      readonly toolCallId: ToolCallId;
      readonly toolName: string;
      readonly input: JsonValue;
    }[];
    readonly toolResumeRequestId?: string;
  }): PromiseLike<AcceptedRun | ToolResumeConflict | ToolResumeRequestConflict> {
    const run = this.#runs.get(input.runId);
    if (run === undefined || !same(run.agent, input.agent)) {
      return Promise.resolve({
        type: "tool-resume-conflict",
        runId: input.runId,
        toolCallIds: input.items.map((item) => item.toolCallId),
      });
    }
    const fingerprint = canonical({ agent: input.agent, items: input.items });
    if (input.toolResumeRequestId !== undefined) {
      const key = requestKey(input.runId, input.toolResumeRequestId);
      const prior = this.#resumeRequests.get(key);
      if (prior !== undefined) {
        if (prior.fingerprint !== fingerprint) {
          return Promise.resolve({
            type: "tool-resume-request-conflict",
            runId: input.runId,
            toolResumeRequestId: input.toolResumeRequestId,
          });
        }
        return Promise.resolve(Object.freeze({ ...prior.result, admitted: false }));
      }
    }
    const currentBranch = this.#branch(run.threadId, run.branchId);
    if (currentBranch.head !== input.expectedHead) {
      return Promise.resolve({
        type: "tool-resume-conflict",
        runId: input.runId,
        toolCallIds: input.items.map((item) => item.toolCallId),
      });
    }

    const graph = this.#graph(input.runId);
    const calls = graph.calls;
    const conflicts: ToolCallId[] = [];
    for (const item of input.items) {
      const call = calls.get(item.toolCallId);
      if (
        call === undefined ||
        call.toolName !== item.toolName ||
        call.status !== "suspended" ||
        call.suspension === undefined ||
        (call.suspension.resumeInput !== undefined &&
          !same(call.suspension.resumeInput, item.input))
      ) {
        conflicts.push(item.toolCallId);
      }
    }
    if (conflicts.length > 0 || terminal(run.status)) {
      return Promise.resolve({
        type: "tool-resume-conflict",
        runId: input.runId,
        toolCallIds: conflicts.length > 0 ? conflicts : input.items.map((item) => item.toolCallId),
      });
    }

    let admitted = false;
    for (const item of input.items) {
      const call = calls.get(item.toolCallId);
      if (call === undefined || call.suspension === undefined) {
        throw new Error(`Thread Store state is missing Tool Suspension '${item.toolCallId}'`);
      }
      const suspension = call.suspension;
      if (suspension.resumeInput === undefined) {
        admitted = true;
        this.#setCall(
          graph,
          Object.freeze({
            ...call,
            suspension: Object.freeze({
              ...suspension,
              resumeInput: item.input,
            }),
          }),
        );
      }
    }
    this.#runs.set(run.id, Object.freeze({ ...run, status: "active" }));
    const branch = this.#branch(run.threadId, run.branchId);
    const result: AcceptedRun = Object.freeze({
      type: "accepted",
      runId: run.id,
      threadId: run.threadId,
      branchId: run.branchId,
      head: requireThreadStoreState(branch.head, `Branch head '${run.branchId}'`),
      agent: run.agent,
      admitted,
    });
    if (input.toolResumeRequestId !== undefined) {
      this.#resumeRequests.set(requestKey(input.runId, input.toolResumeRequestId), {
        runId: input.runId,
        requestId: input.toolResumeRequestId,
        fingerprint,
        result,
      });
    }
    return Promise.resolve(result);
  }

  acceptSteering(input: {
    readonly agent: AgentReference;
    readonly runId: RunId;
    readonly message: ModelMessage;
    readonly steeringRequestId?: SteeringRequestId;
  }): PromiseLike<SteeringResult> {
    const run = this.#runs.get(input.runId);
    if (run === undefined || !same(run.agent, input.agent)) {
      return Promise.resolve({ type: "not-active", runId: input.runId });
    }
    const fingerprint = canonical(input.message);
    if (input.steeringRequestId !== undefined) {
      const key = requestKey(input.runId, input.steeringRequestId);
      const prior = this.#steeringRequests.get(key);
      if (prior !== undefined) {
        if (prior.fingerprint !== fingerprint) {
          return Promise.resolve({
            type: "steering-request-conflict",
            runId: input.runId,
            steeringRequestId: input.steeringRequestId,
          });
        }
        return Promise.resolve(
          prior.result.type === "accepted" ? { ...prior.result, admitted: false } : prior.result,
        );
      }
    }
    if (terminal(run.status)) {
      return Promise.resolve({ type: "not-active", runId: input.runId });
    }
    const pending = this.#pendingSteering.get(run.id) ?? [];
    const result: SteeringResult = {
      type: "accepted",
      runId: run.id,
      sequence: (this.#commandSequences.get(run.id) ?? 0) + 1,
      admitted: true,
    };
    this.#commandSequences.set(run.id, result.sequence);
    pending.push({ sequence: result.sequence, message: input.message });
    this.#pendingSteering.set(run.id, pending);
    if (input.steeringRequestId !== undefined) {
      this.#steeringRequests.set(requestKey(input.runId, input.steeringRequestId), {
        runId: input.runId,
        requestId: input.steeringRequestId,
        fingerprint,
        result,
      });
    }
    return Promise.resolve(result);
  }

  acceptRedirect(input: {
    readonly agent: AgentReference;
    readonly runId: RunId;
    readonly message: ModelMessage;
    readonly redirectRequestId?: RedirectRequestId;
  }): PromiseLike<RedirectResult> {
    const run = this.#runs.get(input.runId);
    if (run === undefined || !same(run.agent, input.agent)) {
      return Promise.resolve({ type: "not-active", runId: input.runId });
    }
    const fingerprint = canonical(input.message);
    if (input.redirectRequestId !== undefined) {
      const key = requestKey(input.runId, input.redirectRequestId);
      const prior = this.#redirectRequests.get(key);
      if (prior !== undefined) {
        if (prior.fingerprint !== fingerprint) {
          return Promise.resolve({
            type: "redirect-request-conflict",
            runId: input.runId,
            redirectRequestId: input.redirectRequestId,
          });
        }
        return Promise.resolve(
          prior.result.type === "accepted" ? { ...prior.result, admitted: false } : prior.result,
        );
      }
    }
    if (terminal(run.status)) {
      return Promise.resolve({ type: "not-active", runId: input.runId });
    }
    const pending = this.#pendingRedirects.get(run.id) ?? [];
    const result: RedirectResult = {
      type: "accepted",
      runId: run.id,
      sequence: (this.#commandSequences.get(run.id) ?? 0) + 1,
      admitted: true,
    };
    this.#commandSequences.set(run.id, result.sequence);
    pending.push({ sequence: result.sequence, message: input.message });
    this.#pendingRedirects.set(run.id, pending);
    if (input.redirectRequestId !== undefined) {
      this.#redirectRequests.set(requestKey(input.runId, input.redirectRequestId), {
        runId: input.runId,
        requestId: input.redirectRequestId,
        fingerprint,
        result,
      });
    }
    return Promise.resolve(result);
  }

  requestAbort(input: {
    readonly agent: AgentReference;
    readonly runId: RunId;
    readonly reason?: JsonValue;
  }): PromiseLike<AbortResult> {
    const run = this.#runs.get(input.runId);
    if (run === undefined || !same(run.agent, input.agent)) {
      return Promise.resolve({ type: "not-active", runId: input.runId });
    }
    if (run.result !== undefined) {
      return Promise.resolve({ type: "already-resolved", result: run.result });
    }
    if (!run.abortRequested) {
      this.#runs.set(
        run.id,
        Object.freeze({
          ...run,
          abortRequested: true,
          ...(input.reason === undefined ? {} : { abortReason: input.reason }),
        }),
      );
      this.#notifyControl(run.id, {
        type: "abort-requested",
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      });
    }
    return Promise.resolve({ type: "accepted", runId: run.id });
  }

  readRunSnapshot(input: {
    readonly agent: AgentReference;
    readonly runId: RunId;
  }): PromiseLike<ThreadStoreRunSnapshot<Definitions> | undefined> {
    const run = this.#runs.get(input.runId);
    if (run === undefined || !same(run.agent, input.agent)) {
      return Promise.resolve(undefined);
    }
    const branch = this.#branch(run.threadId, run.branchId);
    const calls = this.#orderedCalls(run.id);
    const snapshot = Object.freeze({
      run,
      head: requireThreadStoreState(branch.head, `Branch head '${run.branchId}'`),
      toolCalls: Object.freeze(
        calls.map((call) =>
          call.providerId === undefined ? call : Object.freeze({ ...call, dynamic: true as const }),
        ),
      ),
      suspensions: Object.freeze(
        calls
          .filter((call) => call.status === "suspended")
          .map((call) =>
            call.providerId === undefined
              ? Object.freeze({
                  toolCallId: call.toolCallId,
                  toolName: call.toolName,
                })
              : Object.freeze({
                  dynamic: true as const,
                  providerId: call.providerId,
                  toolCallId: call.toolCallId,
                  toolName: call.toolName,
                }),
          ),
      ),
      // SAFETY: The snapshot uses complete effective Run and Tool Call Records and the built-in public suspension projection.
    }) as unknown as ThreadStoreRunSnapshot<Definitions>;
    return Promise.resolve(snapshot);
  }

  readRunResult(input: {
    readonly agent: AgentReference;
    readonly runId: RunId;
  }): PromiseLike<RunResultRecord | undefined> {
    const run = this.#runs.get(input.runId);
    return Promise.resolve(
      run === undefined || !same(run.agent, input.agent)
        ? undefined
        : Object.freeze({
            agent: run.agent,
            ...(run.result === undefined ? {} : { result: run.result }),
          }),
    );
  }

  async readToolResumeContext(input: {
    readonly agent: AgentReference;
    readonly runId: RunId;
  }): Promise<ToolResumeContext | undefined> {
    const run = this.#runs.get(input.runId);
    if (run === undefined || !same(run.agent, input.agent)) {
      return undefined;
    }
    const branch = this.#branch(run.threadId, run.branchId);
    const path = await this.readBranchHistory({
      threadId: run.threadId,
      branchId: run.branchId,
    });
    return Object.freeze({
      run,
      transcript: Object.freeze(path.map((entry) => entry.message)),
      head: requireThreadStoreState(branch.head, `Branch head '${run.branchId}'`),
      toolCalls: Object.freeze(this.#orderedCalls(run.id)),
    });
  }

  async acquireExecutionClaim(input: {
    readonly agent: AgentReference;
    readonly runId: RunId;
    readonly executionId: ExecutionId;
    readonly leaseDurationMs: number;
  }): Promise<ClaimResult> {
    const run = this.#runs.get(input.runId);
    if (run === undefined) {
      return { type: "run-not-found" };
    }
    if (!same(run.agent, input.agent)) {
      return { type: "wrong-agent" };
    }
    const now = this.#now();
    const current = this.#claims.get(run.id);
    if (current !== undefined && current.expiresAt > now) {
      return { type: "already-claimed", expiresAt: current.expiresAt };
    }
    if (current !== undefined) {
      this.#notifyControl(run.id, { type: "claim-lost" }, current.token);
      this.#claims.delete(run.id);
    }
    const readyResume = this.#graph(run.id).resumable.size > 0;
    if (
      terminal(run.status) ||
      (run.status === "suspended" && !readyResume && !run.abortRequested)
    ) {
      return {
        type: "not-executable",
        ...(run.result === undefined ? {} : { result: run.result }),
      };
    }

    const previousFence = this.#fences.get(run.id);
    let fence = (previousFence ?? 0) + 1;
    if (previousFence === undefined) {
      // SAFETY: The required hook supplies any host create fields before strict Collection validation.
      const createdFence = await this.collections.executionFence.create({
        runId: run.id,
        fence,
      } as unknown as CreateInput<Definitions["executionFence"]>);
      // SAFETY: Compatible Core field overrides preserve the executionFence runId and fence outputs.
      const effectiveFence = createdFence as unknown as {
        readonly runId: RunId;
        readonly fence: number;
      };
      this.#fences.set(effectiveFence.runId, effectiveFence.fence);
      this.#rememberCreatedRecord("executionFence", createdFence as CoreStoredRecord);
      fence = effectiveFence.fence;
    } else {
      this.#fences.set(run.id, fence);
    }

    const claimDraft: ExecutionClaim = Object.freeze({
      runId: run.id,
      executionId: input.executionId,
      token: ExecutionClaimToken.decode(globalThis.crypto.randomUUID()),
      fence,
      expiresAt: now + input.leaseDurationMs,
    });
    let claim = claimDraft;
    if (current === undefined) {
      // SAFETY: The required hook supplies any host create fields before strict Collection validation.
      const createdClaim = await this.collections.executionClaim.create(
        claimDraft as unknown as CreateInput<Definitions["executionClaim"]>,
      );
      // SAFETY: Compatible Core field overrides preserve every Execution Claim output used by Core.
      claim = createdClaim as unknown as ExecutionClaim;
      this.#rememberCreatedRecord("executionClaim", createdClaim as CoreStoredRecord);
    }
    this.#claims.set(claim.runId, claim);
    return { type: "acquired", claim };
  }

  renewExecutionClaim(input: {
    readonly claim: ExecutionClaim;
    readonly leaseDurationMs: number;
  }): PromiseLike<ClaimRenewalResult> {
    if (!this.#validClaim(input.claim)) {
      return Promise.resolve({ type: "claim-lost" });
    }
    const run = this.#run(input.claim.runId);
    if (run.abortRequested) {
      return Promise.resolve({
        type: "abort-requested",
        ...(run.abortReason === undefined ? {} : { reason: run.abortReason }),
      });
    }
    const claim = Object.freeze({
      ...input.claim,
      expiresAt: this.#now() + input.leaseDurationMs,
    });
    this.#claims.set(claim.runId, claim);
    return Promise.resolve({ type: "renewed", claim });
  }

  waitForExecutionControl(input: {
    readonly claim: ExecutionClaim;
    readonly signal: AbortSignal;
  }): PromiseLike<ExecutionControl> {
    const immediate = this.#readControl(input.claim);
    if (immediate !== undefined) {
      return Promise.resolve(immediate);
    }
    return new Promise((resolve, reject) => {
      if (input.signal.aborted) {
        reject(input.signal.reason);
        return;
      }
      const waiters = this.#controlWaiters.get(input.claim.runId) ?? new Set<ControlWaiter>();
      const waiter: ControlWaiter = {
        token: input.claim.token,
        resolve,
        reject,
        signal: input.signal,
        onAbort: () => {
          waiters.delete(waiter);
          reject(input.signal.reason);
        },
      };
      waiters.add(waiter);
      this.#controlWaiters.set(input.claim.runId, waiters);
      input.signal.addEventListener("abort", waiter.onAbort, { once: true });
      const raced = this.#readControl(input.claim);
      if (raced !== undefined) {
        this.#settleWaiter(input.claim.runId, waiter, raced);
      }
    });
  }

  releaseExecutionClaim(claim: ExecutionClaim): PromiseLike<boolean> {
    if (!this.#sameClaim(claim)) {
      return Promise.resolve(false);
    }
    this.#claims.delete(claim.runId);
    return Promise.resolve(true);
  }

  async loadExecution(claim: ExecutionClaim): Promise<ExecutionSnapshot | undefined> {
    if (!this.#validClaim(claim)) {
      return undefined;
    }
    const run = this.#run(claim.runId);
    const branch = this.#branch(run.threadId, run.branchId);
    const path = await this.readBranchHistory({
      threadId: run.threadId,
      branchId: run.branchId,
    });
    return Object.freeze({
      run,
      branch,
      transcript: Object.freeze(path.map((entry) => entry.message)),
      head: requireThreadStoreState(branch.head, `Branch head '${run.branchId}'`),
      pendingSteering: Object.freeze([...(this.#pendingSteering.get(run.id) ?? [])]),
      pendingRedirects: Object.freeze([...(this.#pendingRedirects.get(run.id) ?? [])]),
      toolCalls: Object.freeze(this.#orderedCalls(run.id)),
    });
  }
  /** Read one Tool Call only while the supplied Execution Claim remains valid. */
  loadToolCall(
    claim: ExecutionClaim,
    toolCallId: ToolCallId,
  ): PromiseLike<StoredToolCall | undefined> {
    if (!this.#validClaim(claim)) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(this.#calls(claim.runId).get(toolCallId));
  }

  commitStep(input: CommitStepInput): PromiseLike<GuardedStoreResult<BranchRecord>> {
    const fingerprint = this.#newCommit(input.commitId, input);
    if (fingerprint === undefined) {
      const run = this.#run(input.claim.runId);
      return Promise.resolve({
        type: "committed",
        value: this.#branch(run.threadId, run.branchId),
      });
    }
    const failure = this.#guard(input.claim, input.expectedHead);
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }
    const run = this.#run(input.claim.runId);
    const branch = this.#append(run.threadId, run.branchId, input.expectedHead, input.entries);
    const consumedSteeringThrough = input.consumedSteeringThrough;
    if (consumedSteeringThrough !== undefined) {
      this.#pendingSteering.set(
        run.id,
        (this.#pendingSteering.get(run.id) ?? []).filter(
          (item) => item.sequence > consumedSteeringThrough,
        ),
      );
    }
    const consumedRedirectsThrough = input.consumedRedirectsThrough;
    if (consumedRedirectsThrough !== undefined) {
      this.#pendingRedirects.set(
        run.id,
        (this.#pendingRedirects.get(run.id) ?? []).filter(
          (item) => item.sequence > consumedRedirectsThrough,
        ),
      );
    }
    this.#commits.set(input.commitId, fingerprint);
    return Promise.resolve({ type: "committed", value: branch });
  }

  commitModelInvocation(
    input: CommitModelInvocationInput,
  ): PromiseLike<CommitModelInvocationStoreResult<Definitions>> {
    const fingerprint = this.#newCommit(input.commitId, input);
    if (fingerprint === undefined) {
      const outcome = this.#modelCommitOutcomes.get(input.commitId);
      if (outcome === undefined) {
        throw new Error(`Commit '${input.commitId}' has no stored Model outcome`);
      }
      return Promise.resolve(outcome);
    }
    const failure = this.#guard(input.claim, input.expectedHead);
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }
    const run = this.#run(input.claim.runId);
    if ((this.#pendingRedirects.get(run.id)?.length ?? 0) > 0) {
      const outcome = Object.freeze({ type: "work-ready" as const });
      this.#commits.set(input.commitId, fingerprint);
      this.#modelCommitOutcomes.set(input.commitId, outcome);
      return Promise.resolve(outcome);
    }
    const graph = this.#graph(run.id);
    const calls = graph.calls;
    for (const call of input.toolCalls) {
      if (calls.has(call.toolCallId)) {
        throw new Error(`Tool Call '${call.toolCallId}' already exists`);
      }
    }
    const branch = this.#append(run.threadId, run.branchId, input.expectedHead, [input.entry]);
    for (const call of input.toolCalls) {
      this.#setCall(
        graph,
        Object.freeze({
          toolCallId: call.toolCallId,
          runId: run.id,
          sequence: this.#nextToolSequence(graph),
          toolName: call.toolName,
          ...(call.providerId === undefined ? {} : { providerId: call.providerId }),
          requestedInput: call.input,
          status: "pending",
          historyCommitted: false,
          ...(call.providerData === undefined ? {} : { providerData: call.providerData }),
        }),
      );
    }
    this.#commits.set(input.commitId, fingerprint);
    const outcome = Object.freeze({
      type: "committed" as const,
      value: this.#effectiveBranch(branch),
    });
    this.#modelCommitOutcomes.set(input.commitId, outcome);
    return Promise.resolve(outcome);
  }

  recordModelCall(input: RecordModelCallInput): PromiseLike<GuardedStoreResult<RunUsage>> {
    const fingerprint = this.#newCommit(input.commitId, input);
    if (fingerprint === undefined) {
      return Promise.resolve({
        type: "committed",
        value: this.#run(input.claim.runId).usage ?? emptyRunUsage(),
      });
    }
    if (!this.#validClaim(input.claim)) {
      return Promise.resolve({ type: "claim-lost" });
    }
    const run = this.#run(input.claim.runId);
    if (terminal(run.status)) {
      return Promise.resolve({
        type: "not-active",
        ...(run.result === undefined ? {} : { result: run.result }),
      });
    }
    const current = run.usage ?? emptyRunUsage();
    const index = current.models.findIndex((entry) => entry.modelId === input.modelId);
    const previous = index < 0 ? undefined : current.models[index];
    const modelUsage =
      input.usage === undefined
        ? (previous?.usage ?? emptyModelUsage())
        : addUsage(previous?.usage, input.usage);
    const entry: ModelRunUsage = Object.freeze({
      modelId: input.modelId,
      calls: (previous?.calls ?? 0) + 1,
      reportedCalls: (previous?.reportedCalls ?? 0) + (input.usage === undefined ? 0 : 1),
      usage: modelUsage,
    });
    const models =
      index < 0
        ? Object.freeze([...current.models, entry])
        : Object.freeze(
            current.models.map((candidate, candidateIndex) =>
              candidateIndex === index ? entry : candidate,
            ),
          );
    const usage: RunUsage = Object.freeze({
      total: input.usage === undefined ? current.total : addUsage(current.total, input.usage),
      models,
    });
    this.#runs.set(run.id, Object.freeze({ ...run, usage }));
    this.#commits.set(input.commitId, fingerprint);
    return Promise.resolve({ type: "committed", value: usage });
  }

  recordToolInput(input: RecordToolInputInput): PromiseLike<GuardedStoreResult<StoredToolCall>> {
    const failure = this.#guard(input.claim);
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }
    const graph = this.#graph(input.claim.runId);
    const call = this.#call(graph.calls, input.toolCallId);
    if (call.effectiveInput !== undefined && !same(call.effectiveInput, input.input)) {
      throw new Error(`Effective input for Tool Call '${call.toolCallId}' changed`);
    }
    const stored = Object.freeze({
      ...call,
      effectiveInput: call.effectiveInput ?? input.input,
    });
    this.#setCall(graph, stored);
    return Promise.resolve({ type: "committed", value: stored });
  }

  recordDelegatedToolCall(
    input: RecordDelegatedToolCallInput,
  ): PromiseLike<GuardedStoreResult<StoredToolCall>> {
    const failure = this.#guard(input.claim);
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }
    const graph = this.#graph(input.claim.runId);
    const calls = graph.calls;
    this.#call(calls, input.parentToolCallId);
    const currentId = graph.delegated.get(input.parentToolCallId)?.get(input.key);
    const current = currentId === undefined ? undefined : this.#call(calls, currentId);
    if (current !== undefined) {
      if (
        current.toolName !== input.toolName ||
        current.providerId !== input.providerId ||
        !same(current.requestedInput, input.input)
      ) {
        throw new Error(`Delegation key '${input.key}' was reused with different data`);
      }
      return Promise.resolve({ type: "committed", value: current });
    }
    if (calls.has(input.toolCallId)) {
      throw new Error(`Tool Call ID '${input.toolCallId}' is already in use`);
    }
    const stored: StoredToolCall = Object.freeze({
      toolCallId: input.toolCallId,
      runId: input.claim.runId,
      sequence: this.#nextToolSequence(graph),
      toolName: input.toolName,
      parentToolCallId: input.parentToolCallId,
      ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
      delegationKey: input.key,
      requestedInput: input.input,
      status: "pending",
      historyCommitted: false,
    });
    this.#setCall(graph, stored);
    return Promise.resolve({ type: "committed", value: stored });
  }

  completeToolCall(input: CompleteToolCallInput): PromiseLike<GuardedStoreResult<StoredToolCall>> {
    const failure = this.#guard(input.claim);
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }
    const graph = this.#graph(input.claim.runId);
    const call = this.#call(graph.calls, input.toolCallId);
    const result =
      input.result.type === "success"
        ? Object.freeze({ ...input.result })
        : Object.freeze({
            ...input.result,
            failure:
              call.providerId === undefined
                ? Object.freeze({
                    type: "tool-failure" as const,
                    toolName: call.toolName,
                    toolCallId: call.toolCallId,
                    value: input.result.failure,
                  })
                : Object.freeze({
                    type: "tool-failure" as const,
                    dynamic: true as const,
                    providerId: call.providerId,
                    toolName: call.toolName,
                    toolCallId: call.toolCallId,
                    value: input.result.failure,
                  }),
          });
    if (call.result !== undefined) {
      if (!same(call.result, result)) {
        throw new Error(`Tool Call '${call.toolCallId}' completed with different results`);
      }
      return Promise.resolve({ type: "committed", value: call });
    }
    const terminal = {
      ...call,
      status: input.result.type === "success" ? ("succeeded" as const) : ("failed" as const),
      result,
    };
    delete terminal.suspension;
    const stored: StoredToolCall = Object.freeze(terminal);
    this.#setCall(graph, stored);
    return Promise.resolve({ type: "committed", value: stored });
  }

  suspendToolCall(input: SuspendToolCallInput): PromiseLike<GuardedStoreResult<StoredToolCall>> {
    const failure = this.#guard(input.claim);
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }
    const graph = this.#graph(input.claim.runId);
    const call = this.#call(graph.calls, input.toolCallId);
    const suspended = {
      ...call,
      status: "suspended" as const,
      suspension: Object.freeze({ ...input.suspension }),
    };
    delete suspended.result;
    const stored: StoredToolCall = Object.freeze(suspended);
    this.#setCall(graph, stored);
    return Promise.resolve({ type: "committed", value: stored });
  }

  commitToolResults(input: CommitToolResultsInput): PromiseLike<GuardedStoreResult<BranchRecord>> {
    const fingerprint = this.#newCommit(input.commitId, input);
    if (fingerprint === undefined) {
      const run = this.#run(input.claim.runId);
      return Promise.resolve({
        type: "committed",
        value: this.#branch(run.threadId, run.branchId),
      });
    }
    const failure = this.#guard(input.claim, input.expectedHead);
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }
    const run = this.#run(input.claim.runId);
    const graph = this.#graph(run.id);
    const calls = graph.calls;
    for (const entry of input.entries) {
      const call = this.#call(calls, entry.toolCallId);
      if (
        call.parentToolCallId !== undefined ||
        (call.status !== "succeeded" && call.status !== "failed")
      ) {
        throw new Error(`Tool Call '${call.toolCallId}' has no terminal top-level result`);
      }
    }
    const branch = this.#append(run.threadId, run.branchId, input.expectedHead, input.entries);
    for (const entry of input.entries) {
      const call = this.#call(calls, entry.toolCallId);
      this.#setCall(graph, Object.freeze({ ...call, historyCommitted: true }));
    }
    this.#commits.set(input.commitId, fingerprint);
    return Promise.resolve({ type: "committed", value: branch });
  }

  continueSettlement(
    input: ContinueSettlementInput,
  ): PromiseLike<ContinueSettlementStoreResult<Definitions>> {
    const fingerprint = this.#newCommit(input.commitId, input);
    if (fingerprint === undefined) {
      const outcome = this.#settlementOutcomes.get(input.commitId);
      if (outcome === undefined) {
        throw new Error(`Commit '${input.commitId}' has no stored settlement outcome`);
      }
      return Promise.resolve(outcome);
    }
    const failure = this.#guard(input.claim, input.expectedHead);
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }
    const run = this.#run(input.claim.runId);
    if ((this.#pendingRedirects.get(run.id)?.length ?? 0) > 0) {
      const outcome = Object.freeze({ type: "work-ready" as const });
      this.#commits.set(input.commitId, fingerprint);
      this.#settlementOutcomes.set(input.commitId, outcome);
      return Promise.resolve(outcome);
    }
    if ((this.#pendingSteering.get(run.id)?.length ?? 0) > 0) {
      this.#append(run.threadId, run.branchId, input.expectedHead, input.candidateEntries);
      const outcome = Object.freeze({ type: "work-ready" as const });
      this.#commits.set(input.commitId, fingerprint);
      this.#settlementOutcomes.set(input.commitId, outcome);
      return Promise.resolve(outcome);
    }
    if (run.settlementContinuations >= 32) {
      const outcome = Object.freeze({ type: "limit-reached" as const });
      this.#commits.set(input.commitId, fingerprint);
      this.#settlementOutcomes.set(input.commitId, outcome);
      return Promise.resolve(outcome);
    }
    const branch = this.#append(run.threadId, run.branchId, input.expectedHead, [
      ...input.candidateEntries,
      input.instructionEntry,
    ]);
    this.#runs.set(
      run.id,
      Object.freeze({
        ...run,
        settlementContinuations: run.settlementContinuations + 1,
      }),
    );
    this.#commits.set(input.commitId, fingerprint);
    const outcome = Object.freeze({
      type: "committed" as const,
      value: this.#effectiveBranch(branch),
    });
    this.#settlementOutcomes.set(input.commitId, outcome);
    return Promise.resolve(outcome);
  }

  suspendRun(input: {
    readonly claim: ExecutionClaim;
    readonly expectedHead: MessageEntryId;
    readonly result: SuspendedRunResult;
  }): PromiseLike<SuspendRunStoreResult> {
    const failure = this.#guard(input.claim, input.expectedHead);
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }
    if (this.#graph(input.claim.runId).resumable.size > 0) {
      return Promise.resolve({ type: "work-ready" });
    }
    const run = this.#run(input.claim.runId);
    this.#runs.set(run.id, Object.freeze({ ...run, status: "suspended" }));
    return Promise.resolve({ type: "committed", value: input.result });
  }

  finalizeRun(input: FinalizeRunStoreInput): PromiseLike<FinalizeRunStoreResult<Definitions>> {
    const fingerprint = this.#newCommit(input.commitId, input);
    if (fingerprint === undefined) {
      const outcome = this.#finalizationOutcomes.get(input.commitId);
      if (outcome === undefined) {
        throw new Error(`Commit '${input.commitId}' has no stored finalization outcome`);
      }
      return Promise.resolve(outcome);
    }
    if (!this.#validClaim(input.claim)) {
      return Promise.resolve({ type: "claim-lost" });
    }
    const run = this.#run(input.claim.runId);
    if (run.result !== undefined) {
      return Promise.resolve({ type: "not-active", result: run.result });
    }
    if (run.abortRequested && input.result.type !== "aborted") {
      return Promise.resolve({
        type: "abort-requested",
        ...(run.abortReason === undefined ? {} : { reason: run.abortReason }),
      });
    }
    const branch = this.#branch(run.threadId, run.branchId);
    if (branch.head !== input.expectedHead) {
      return Promise.resolve({ type: "head-changed", actualHead: branch.head! });
    }
    if (input.result.type !== "aborted" && (this.#pendingRedirects.get(run.id)?.length ?? 0) > 0) {
      const outcome = Object.freeze({ type: "work-ready" as const });
      this.#commits.set(input.commitId, fingerprint);
      this.#finalizationOutcomes.set(input.commitId, outcome);
      return Promise.resolve(outcome);
    }
    if (input.result.type !== "aborted" && (this.#pendingSteering.get(run.id)?.length ?? 0) > 0) {
      this.#append(run.threadId, run.branchId, input.expectedHead, input.entries);
      const outcome = Object.freeze({ type: "work-ready" as const });
      this.#commits.set(input.commitId, fingerprint);
      this.#finalizationOutcomes.set(input.commitId, outcome);
      return Promise.resolve(outcome);
    }
    this.#append(run.threadId, run.branchId, input.expectedHead, input.entries);
    if (input.abortUnresolvedTools) {
      const graph = this.#graph(run.id);
      for (const call of graph.calls.values()) {
        if (call.status !== "succeeded" && call.status !== "failed" && call.status !== "aborted") {
          const aborted = {
            ...call,
            status: "aborted" as const,
            result: Object.freeze({ type: "aborted" as const }),
          };
          delete aborted.suspension;
          this.#setCall(graph, Object.freeze(aborted));
        }
      }
    }
    const stored = Object.freeze({
      ...run,
      status: input.result.type,
      result: input.result,
      abortRequested: run.abortRequested || input.result.type === "aborted",
    });
    this.#runs.set(run.id, stored);
    this.#claims.delete(run.id);
    this.#commits.set(input.commitId, fingerprint);
    const outcome = Object.freeze({
      type: "committed" as const,
      value: input.result,
    });
    this.#finalizationOutcomes.set(input.commitId, outcome);
    return Promise.resolve(outcome);
  }

  recordInterruption(input: {
    readonly claim: ExecutionClaim;
    readonly interruption: Interruption;
  }): PromiseLike<GuardedStoreResult<Interruption>> {
    const failure = this.#guard(input.claim);
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }
    this.#claims.delete(input.claim.runId);
    return Promise.resolve({ type: "committed", value: input.interruption });
  }

  #newCommit(commitId: CommitId, input: unknown): string | undefined {
    const fingerprint = canonical(input);
    const prior = this.#commits.get(commitId);
    if (prior === undefined) {
      return fingerprint;
    }
    if (prior !== fingerprint) {
      throw new Error(`Commit '${commitId}' was reused with different data`);
    }
    return undefined;
  }

  #branch(threadId: ThreadId, branchId: BranchId): BranchRecord {
    const branch = this.#branches.get(branchId);
    if (branch === undefined || branch.threadId !== threadId) {
      throw new Error(`Unknown Branch '${branchId}' in Thread '${threadId}'`);
    }
    return branch;
  }

  #run(runId: RunId): RunRecord {
    const run = this.#runs.get(runId);
    if (run === undefined) {
      throw new Error(`Unknown Run '${runId}'`);
    }
    return run;
  }

  #graph(runId: RunId): ToolCallGraph {
    const graph = this.#toolCalls.get(runId);
    if (graph === undefined) {
      throw new Error(`Unknown Tool Call Graph for Run '${runId}'`);
    }
    return graph;
  }

  #calls(runId: RunId): Map<ToolCallId, StoredToolCall> {
    return this.#graph(runId).calls;
  }

  #orderedCalls(runId: RunId): StoredToolCall[] {
    const graph = this.#graph(runId);
    return graph.order.map((toolCallId) => this.#call(graph.calls, toolCallId));
  }

  #nextToolSequence(graph: ToolCallGraph): number {
    graph.nextSequence += 1;
    return graph.nextSequence;
  }

  #setCall(graph: ToolCallGraph, call: StoredToolCall): void {
    const current = graph.calls.get(call.toolCallId);
    if (current === undefined) {
      graph.order.push(call.toolCallId);
      graph.nextSequence = Math.max(graph.nextSequence, call.sequence);
      if (call.parentToolCallId !== undefined && call.delegationKey !== undefined) {
        let delegated = graph.delegated.get(call.parentToolCallId);
        if (delegated === undefined) {
          delegated = new Map();
          graph.delegated.set(call.parentToolCallId, delegated);
        }
        delegated.set(call.delegationKey, call.toolCallId);
      }
    }
    graph.calls.set(call.toolCallId, call);
    if (call.suspension?.resumeInput === undefined) {
      graph.resumable.delete(call.toolCallId);
    } else {
      graph.resumable.add(call.toolCallId);
    }
  }

  #call(calls: Map<ToolCallId, StoredToolCall>, toolCallId: ToolCallId): StoredToolCall {
    const call = calls.get(toolCallId);
    if (call === undefined) {
      throw new Error(`Unknown Tool Call '${toolCallId}'`);
    }
    return call;
  }

  #effectiveBranch(branch: BranchRecord): SelectedRecord<Definitions["branch"]> {
    // SAFETY: loadState starts with a complete effective selected Branch, and every Branch transition spreads that Record before changing Core fields.
    return branch as SelectedRecord<Definitions["branch"]>;
  }

  #append(
    threadId: ThreadId,
    branchId: BranchId,
    expectedHead: MessageEntryId | undefined,
    entries: readonly {
      readonly id: MessageEntryId;
      readonly message: ModelMessage;
    }[],
  ): BranchRecord {
    let branch = this.#branch(threadId, branchId);
    if (branch.head !== expectedHead) {
      throw new Error(`Branch '${branchId}' head changed`);
    }
    let parent = expectedHead;
    for (const value of entries) {
      const current = this.#entries.get(value.id);
      const entry: MessageEntry = Object.freeze({
        id: value.id,
        threadId,
        ...(parent === undefined ? {} : { parent }),
        message: value.message,
      });
      if (current !== undefined && !same(current, entry)) {
        throw new Error(`Message Entry '${value.id}' already exists with different data`);
      }
      this.#entries.set(entry.id, current ?? entry);
      parent = entry.id;
    }
    branch = Object.freeze({
      ...branch,
      ...(parent === undefined ? {} : { head: parent }),
    });
    this.#branches.set(branch.id, branch);
    return branch;
  }

  #sameClaim(claim: ExecutionClaim): boolean {
    const current = this.#claims.get(claim.runId);
    return (
      current?.token === claim.token &&
      current.fence === claim.fence &&
      current.executionId === claim.executionId
    );
  }

  #validClaim(claim: ExecutionClaim): boolean {
    return this.#sameClaim(claim) && claim.expiresAt > this.#now();
  }

  #guard(
    claim: ExecutionClaim,
    expectedHead?: MessageEntryId,
  ):
    | { readonly type: "claim-lost" }
    | { readonly type: "head-changed"; readonly actualHead: MessageEntryId }
    | { readonly type: "abort-requested"; readonly reason?: JsonValue }
    | { readonly type: "not-active"; readonly result?: RunResult }
    | undefined {
    if (!this.#validClaim(claim)) {
      return { type: "claim-lost" };
    }
    const run = this.#run(claim.runId);
    if (terminal(run.status)) {
      return {
        type: "not-active",
        ...(run.result === undefined ? {} : { result: run.result }),
      };
    }
    if (run.abortRequested) {
      return {
        type: "abort-requested",
        ...(run.abortReason === undefined ? {} : { reason: run.abortReason }),
      };
    }
    if (expectedHead !== undefined) {
      const branch = this.#branch(run.threadId, run.branchId);
      if (branch.head !== expectedHead) {
        return { type: "head-changed", actualHead: branch.head! };
      }
    }
    return undefined;
  }

  #readControl(claim: ExecutionClaim): ExecutionControl | undefined {
    if (!this.#validClaim(claim)) {
      return { type: "claim-lost" };
    }
    const run = this.#run(claim.runId);
    if (run.abortRequested) {
      return {
        type: "abort-requested",
        ...(run.abortReason === undefined ? {} : { reason: run.abortReason }),
      };
    }
    return undefined;
  }

  #notifyControl(runId: RunId, control: ExecutionControl, token?: ExecutionClaimToken): void {
    this.#controlNotifications.push({
      runId,
      control,
      ...(token === undefined ? {} : { token }),
    });
  }

  #settleWaiter(runId: RunId, waiter: ControlWaiter, control: ExecutionControl): void {
    this.#controlWaiters.get(runId)?.delete(waiter);
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve(control);
  }
}

const readOnlyThreadStoreOperations = new Set([
  "readThread",
  "readBranch",
  "readBranchHistory",
  "readRunSnapshot",
  "readRunResult",
  "readToolResumeContext",
  "loadExecution",
  "loadToolCall",
]);

async function executeCoreThreadStoreOperation<
  Definitions extends ThreadRecordDefinitions,
  Operators extends CoreStoreOperatorTypes,
>(
  options: CoreThreadStoreOptions<Definitions, Operators>,
  controlWaiters: Map<RunId, Set<ControlWaiter>>,
  methodName: string,
  args: readonly unknown[],
): Promise<unknown> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let committedState: CoreThreadStore<Definitions, Operators> | undefined;
    try {
      if (methodName === "recordDelegatedToolCall") {
        // SAFETY: createThreadStore exposes this branch only for the recordDelegatedToolCall method.
        const input = args[0] as RecordDelegatedToolCallInput;
        return await options.backend.transaction(async (transaction) => {
          const store = addThreadStoreCreateHooks(transaction, options.hooks);
          return recordDelegatedToolCallInStore(store, options.clock?.now ?? Date.now, input);
        });
      }

      if (methodName === "waitForExecutionControl") {
        const pending = await options.backend.transaction(async (transaction) => {
          const store = addThreadStoreCreateHooks(transaction, options.hooks);
          const state = new CoreThreadStore({
            store,
            controlWaiters,
            ...(options.clock === undefined ? {} : { clock: options.clock }),
          });
          await state.loadState();
          // SAFETY: createThreadStore exposes this branch only for waitForExecutionControl, whose method returns a PromiseLike.
          const wait = Reflect.apply(
            state.waitForExecutionControl,
            state,
            args,
          ) as Promise<unknown>;
          return { wait };
        });
        return await pending.wait;
      }

      const value = await options.backend.transaction(async (transaction) => {
        const store = addThreadStoreCreateHooks(transaction, options.hooks);
        const state = new CoreThreadStore({
          store,
          controlWaiters,
          ...(options.clock === undefined ? {} : { clock: options.clock }),
        });
        committedState = state;
        await state.loadState();
        const method = Reflect.get(state, methodName);
        if (typeof method !== "function") {
          throw new TypeError(`Unknown Thread Store operation '${methodName}'`);
        }
        const result = await Reflect.apply(method, state, args);
        if (!readOnlyThreadStoreOperations.has(methodName)) {
          await state.persistState();
        }
        return result;
      });
      committedState?.publishControlNotifications();
      return value;
    } catch (cause) {
      if (!(cause instanceof TransactionConflictError) || attempt === 3) {
        throw cause;
      }
    }
  }
  throw new Error("Unreachable Thread Store retry state");
}

/** Make a Core-owned Thread Store over one transactional backend. */
export function createThreadStore<
  Definitions extends ThreadRecordDefinitions = CoreRecordDefinitions,
  const Operators extends CoreStoreOperatorTypes = BaseStoreOperatorTypes,
>(options: CoreThreadStoreOptions<Definitions, Operators>): ThreadStore<Definitions, Operators> {
  const store = addThreadStoreCreateHooks(options.backend, options.hooks);
  const controlWaiters = new Map<RunId, Set<ControlWaiter>>();
  const methodCache = new Map<string, (...args: readonly unknown[]) => Promise<unknown>>();
  const hiddenMethods = new Set([
    "constructor",
    "loadState",
    "persistState",
    "publishControlNotifications",
  ]);
  const target = { collections: store.collections };

  // SAFETY: The Proxy exposes only Collection access and methods declared by ThreadStore from CoreThreadStore.prototype.
  return new Proxy(target, {
    get(current, property, receiver) {
      if (property === "collections") {
        return Reflect.get(current, property, receiver);
      }
      if (
        typeof property !== "string" ||
        hiddenMethods.has(property) ||
        typeof Reflect.get(CoreThreadStore.prototype, property) !== "function"
      ) {
        return undefined;
      }
      let method = methodCache.get(property);
      if (method === undefined) {
        method = (...args) =>
          executeCoreThreadStoreOperation(options, controlWaiters, property, args);
        methodCache.set(property, method);
      }
      return method;
    },
  }) as unknown as ThreadStore<Definitions, Operators>;
}
