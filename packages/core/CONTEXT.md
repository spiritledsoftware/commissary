# Core

Core defines composable Agents, the provider-neutral Model and Tool protocol, durable Threads and Runs, and the Runtime that advances them.

## Language

### Agents and composition

**Agent**:
A reusable definition. Core renders its executable form from the current Transcript.
_Avoid_: Live agent, runtime instance

**Agent ID**:
A caller-owned stable ID that identifies one Agent across processes and deployments.
_Avoid_: Agent Reference, display name, Thread ID

**Agent Revision**:
A deterministic ID for an Agent's installed static composition and stable contracts.
_Avoid_: Manual version, application release, per-invocation hash

**Agent Reference**:
A durable pair of an Agent ID and the Agent Revision that produced the work.
_Avoid_: In-memory Agent object, Agent ID alone, Model name

**Agent Compatibility**:
A check that an installed Agent can safely continue deferred work from another Agent Revision.
_Avoid_: Revision equality, unchecked latest version, Execution Plan equality

**Agent Installation**:
The validation and fixation of an Agent's static Hooks and stable contracts.
_Avoid_: Render, model invocation, Agent Tree

**Agent Fragment**:
An opaque additive value that contains named Agent contributions. Its factory defines its customization options.
_Avoid_: Plugin manifest, generic property bag, runtime object, editable contribution collection

**Render**:
The derivation of an Agent Tree from the current Transcript for one Model invocation.
_Avoid_: Installation, execution, compilation

**Agent Tree**:
A declarative selection of Context, Model, and Tools for one Model invocation.
_Avoid_: Agent configuration, Execution Plan, live agent

**Execution Plan**:
The immutable and fully resolved form of an Agent Tree for one Model invocation.
_Avoid_: Agent Tree, mutable runtime, Agent Revision

**Context**:
Model-visible information that core derives during Render.
_Avoid_: Effect Context, dependency container, Transcript

**Context Tree**:
The ordered Context that core selects for one Model invocation.
_Avoid_: Effect Context, runtime environment, Transcript

### Messages and history

**Model Message**:
A provider-neutral turn with a role, ordered Content Parts, and optional Message Data.
_Avoid_: Provider message, Execution Event, Message Entry

**Content Part**:
A typed provider-neutral item of model-visible content. Examples include text, reasoning, sources, files, Tool calls, and Tool results.
_Avoid_: Provider event, Execution Event, Message Data

**Provider Data**:
A namespaced and versioned provider payload on one Content Part. Only the matching provider adapter uses it for replay.
_Avoid_: Message Data, Provider Options, raw provider object

**Reasoning Part**:
A provider-returned reasoning summary or explanation that is separate from assistant text.
_Avoid_: Hidden chain-of-thought, provider metadata, ordinary Text Part

**Source Part**:
A provider-neutral source reference from a Model, such as a URL or document.
_Avoid_: Provider metadata, inline citation text, raw provider source object

**Message Data**:
A model-visible, namespaced, and versioned payload on a Model Message. Thread history preserves it with that Message.
_Avoid_: Arbitrary metadata, Provider Options, secrets, credentials

**Message Entry**:
An immutable node in a Thread history tree. It contains one canonical Model Message.
_Avoid_: Agent input, provider payload, custom entry

**Transcript**:
The ordered model-visible conversation from one Branch of Message Entries.
_Avoid_: Thread tree, provider payload, application database

**Artifact Reference**:
An opaque durable reference to file content in Message Data or a Content Part.
_Avoid_: Inline bytes, external URL, provider file ID

**Artifact Store**:
The host-supplied persistence contract for bytes that Artifact References identify.
_Avoid_: Thread Store, inline Message bytes, provider file storage

**Artifact Store Error**:
An exported error for a failed Artifact Store read or write. It keeps the adapter error as its cause.
_Avoid_: Artifact Storage Required Interruption, provider file error, raw storage error contract

### Threads and Runs

**Durable Entity Record**:
A stored value with its own durable identity and lifecycle. Threads, Branches, Message Entries, Runs, and Tool Calls are Durable Entity Records.
_Avoid_: Store command, snapshot, Execution Claim, pending command, all Thread Store values

**Thread**:
A durable identity. Its parent-linked Message Entries form a tree of agent work.
_Avoid_: Session, mutable conversation object, Branch

**Branch**:
A durably identified and human-named line of work in one Thread.
_Avoid_: Thread, global active leaf, linear transcript

**Thread Store**:
A Store specialization that exposes every Core and Custom Collection plus atomic durable operations implemented by core over a Thread Store Backend.
_Avoid_: Generic Store, public Instance property, Agent-selected persistence

**Run**:
One durable effort to advance a Branch from a Message Entry or Tool resumption to a result.
_Avoid_: Thread, process, Execution

**Run ID**:
The durable ID of one Run. Core generates it unless the caller supplies it for idempotent submission.
_Avoid_: Execution ID, Resume Request ID, Thread ID

**Run Submission**:
The durable record of one new or existing Run and its initial Message or Tool resume inputs.
_Avoid_: Job enqueue, execution start, Run Result

**Run Snapshot**:
A typed point-in-time object that keeps snapshot state at the top level and the complete effective Run Record under `run`. Host-added and narrowed Core Run fields stay inside `run`, so `snapshot.head` and `snapshot.run.head` can be different values.
_Avoid_: Execution Snapshot, flattened Run Record, duplicated top-level Run fields, event replay, stream cursor

**Tool Call Snapshot**:
One item in a Run Snapshot's `toolCalls` array. It is the complete effective selected Stored Tool Call Record, with host-added fields, compatible Core field narrowings, and agent-aware field types directly on the item. It has no extra Record wrapper.
_Avoid_: `{ toolCall: record }` wrapper, Tool result only, untyped storage value

**Abort Request**:
A durable request to stop a nonterminal Run. Recording the request acknowledges it, but does not confirm final settlement.
_Avoid_: Process-local signal, immediate settlement acknowledgment, unguarded cancellation flag

**Execution**:
One process-bound effort to advance a submitted Run. It exposes IDs, an awaitable result, and an abort operation.
_Avoid_: Run, Step, retry policy

**Execution Unavailable Error**:
An exported call error that reports why `execute` could not start an Execution.
_Avoid_: Run Result, Interruption, generic Error message

**Execution Claim**:
An expiring fenced grant that lets one Execution advance a Run.
_Avoid_: Run ownership, job lease, unfenced lock

**Execution Claim Policy**:
The positive lease duration that core requests for an Execution Claim.
_Avoid_: Public heartbeat interval, Store-computed duration, infinite claim

**Execution Control Watch**:
An optional cancellable Thread Store operation that reports an Abort Request or lost Execution Claim.
_Avoid_: Mandatory pub/sub, correctness authority, public heartbeat

**Execution Claim Lost Error**:
An exported error that rejects an Execution result after the Execution loses its Claim.
_Avoid_: Aborted Run Result, Interruption, Execution Unavailable Error

**Unexpected Execution Error**:
An exported error for an undeclared exception during execution. It keeps the original value as its cause.
_Avoid_: Defect Error, Failure, Interruption, raw thrown value

**Run Result**:
The durable result of a Run. It includes the Run, Thread, Branch, head, Agent, and cumulative Model Usage.
_Avoid_: Execution result, Transcript, Message Entries

**Step**:
One Run-local Model invocation and its requested Tool executions. Core assigns a durable sequence number to each Step.
_Avoid_: Run, Message Entry, Tool Attempt

**Model Usage**:
Provider-reported optional token counts for input total, uncached input, cache reads, cache writes, output total, text output, reasoning output, and provider total. Core adds each count independently to one Run.
_Avoid_: Cost, budget, Step limit, exact provider billing, missing count treated as zero

**Run Usage**:
The cumulative Model Usage for one Run, with one combined total and a per-Model breakdown containing Model ID, call count, reported-Usage call count, and token counts.
_Avoid_: Single total, cost ledger, provider invoice, Composite Model summary

**Interruption**:
A typed recoverable reason that prevents a Run from advancing now.
_Avoid_: Failure, Defect, Execution Event

**Stale Agent Interruption**:
An Interruption that reports an incompatible Agent contract for deferred work.
_Avoid_: Failure, Defect, terminal Run Result, automatic retry

**Authentication Required Interruption**:
An Interruption that requires the host to obtain valid provider credentials.
_Avoid_: OAuth prompt, Tool Suspension, terminal Failure, automatic login

**Provider Compatibility Interruption**:
An Interruption that reports an unsupported provider capability or Provider Data contract.
_Avoid_: Model Failure, Defect, silent metadata loss

**Provider Unavailable Interruption**:
An Interruption for a temporary provider condition or exhausted quota. It can include retry or reset time.
_Avoid_: Automatic retry, terminal Failure, Authentication Required Interruption

**Model Output Interruption**:
An Interruption for invalid Model output when another sample can succeed.
_Avoid_: Provider Unavailable Interruption, committed Model Response, adapter Defect

**Artifact Storage Required Interruption**:
An Interruption that reports a required but absent Artifact Store.
_Avoid_: Inline-byte fallback, Model Failure, Defect

**Steering**:
A command that adds a canonical Model Message to an active Run between Steps.
_Avoid_: Follow-up Run, Tool resumption, Hook patch

**Redirect**:
A durable command that adds a canonical Model Message at the next safe Run boundary and requests cancellation of an active uncommitted Model invocation.
_Avoid_: Steering, Abort Request, Tool resumption

**Redirect Request ID**:
An optional caller-owned ID that makes one Redirect submission idempotent.
_Avoid_: Steering Request ID, Run ID, Message Entry ID

**Pending Redirect**:
An accepted durable Redirect Message that waits for an active uncommitted Model invocation to stop or for the next safe Run boundary.
_Avoid_: Pending Steering, Abort Request, committed Model Message

**Steering Request ID**:
An optional caller-owned ID that makes one Steering submission idempotent.
_Avoid_: Run ID, Message Entry ID, content hash

**Pending Steering**:
An accepted durable Steering Message that waits for a safe Run boundary.
_Avoid_: Follow-up queue, Branch history, Tool Suspension

### Models and Tools

**Model**:
A capability that changes one Model Request into a stream of Model Events.
_Avoid_: Provider configuration, raw LLM client, Effect AI LanguageModel

**Composite Model**:
A Model that uses declared child Models through core. It can route, sequence, decorate, or use fallback behavior.
_Avoid_: Second root Model contribution, direct child implementation call, core routing policy

**Root Model Invocation**:
The one core-owned invocation of the Execution Plan's Model. Model Hooks run once around it, even when a Composite Model invokes child Models.
_Avoid_: Leaf provider call, Composite child invocation, Step

**Model Request**:
The provider-neutral input that core builds from Context, Transcript, Tools, and Provider Options.
_Avoid_: Provider payload, raw SDK request

**Model Event**:
A provider-neutral update from one Model invocation.
_Avoid_: Execution Event, raw provider chunk, Model Response

**Model Stream Transformation**:
An ordered Hook pipeline that changes Model Events before core derives, publishes, or saves the Model result.
_Avoid_: Provider stream wrapper, post-delivery edit, Model Response replacement

**Model Response**:
The provider-neutral completed result of one Model invocation.
_Avoid_: Agent output, raw provider response, Run Result

**Authoritative Model Result**:
The complete terminal Model Event that core emits after final-result Hooks and then saves unchanged. Clients replace any streamed preview with this result.
_Avoid_: Streamed preview, host display edit, late Thread mutation

**Finish Reason**:
The provider-neutral reason that stopped a Model Response. Examples include refusal, content filtering, and provider-requested continuation.
_Avoid_: Run Result, Failure, Interruption

**Model Failure**:
A terminal Run Failure for a provider rejection that requires a changed request.
_Avoid_: Completed refusal, Interruption, Defect, raw provider error

**Provider Options**:
Typed and namespaced request data for one Model provider. Core does not interpret it.
_Avoid_: Core model setting, untyped metadata

**Routing Hint**:
A host-owned namespaced Provider Option that a Hook adds to a Model Request and a Composite Model can use to choose a declared child Model.
_Avoid_: Root Model replacement, core routing policy, provider model ID

**Provider Package**:
An official package that connects one Model provider to Commissary. Its root API is plain JavaScript.
_Avoid_: Provider implementation in core, Effect-only public API

**Provider Integration Instance**:
A host-owned value for one provider configuration and credential scope. It creates Model contributions and authentication operations.
_Avoid_: Model, raw provider client, Effect Layer, global singleton

**Tool**:
A named model-callable capability with validated input, JSON output, and declared results. Its output schema is optional. It can use host-owned clients captured through a factory or closure; core sees only its declared result.
_Avoid_: Host dependency, arbitrary function, core-owned inner Model call

**Canonical Tool Schema**:
The immutable Draft-07 JSON Schema that Agent Installation creates for a Tool input.
_Avoid_: Effect Schema, provider SDK schema, invocation-time conversion

**Tool Output**:
The durable JSON success value of one Tool Call. An optional output schema narrows its type and validates it.
_Avoid_: Tool Result Content, handler return, Tool Failure

**Tool Result Content**:
An ordered durable list of extra model-visible Content Parts that supplements one Tool Output or declared Tool Failure. Parent Tool invocations do not receive it.
_Avoid_: Tool Output, replacement result, UI-only metadata, inline Artifact bytes

**Tool Provider**:
A named value that resolves Tools for one Model invocation. Its factory captures its dependencies.
_Avoid_: Static Tool, global Tool registry, dependency container

**Dynamic Tool Contract**:
The complete output, Failure, Event, and Suspension behavior of one resolved dynamic Tool.
_Avoid_: Model Tool definition, Tool Provider, unvalidated execute function

**Tool Call**:
A durable semantic request from a Model or parent Tool to invoke one Tool.
_Avoid_: Tool definition, provider call, Tool Attempt

**Tool Call Graph**:
The durable acyclic graph of Model-requested and delegated Tool Calls in one Run.
_Avoid_: Branch transcript, Agent Tree, process-bound call stack

**Tool Execution Mode**:
A Tool-declared constraint that lets top-level Tool Calls in one Model-requested batch run concurrently or requires the complete batch to run in durable Tool Call order.
_Avoid_: Loop, Tool Attempt, provider concurrency

**Tool Attempt**:
One process-bound execution of a Tool Call. A Tool Call can have multiple Tool Attempts.
_Avoid_: Tool Call, Execution

**Tool Suspension**:
A nonterminal Tool result that pauses its Run. It includes encoded state for later resumption.
_Avoid_: Tool output, Tool Failure, Interruption

**Tool Resume**:
One durable resume input for one suspended Tool Call.
_Avoid_: Steering, Tool result, immediate execution

**Resume Request ID**:
An optional caller-owned ID that makes one atomic Tool Resume batch idempotent.
_Avoid_: Tool Call ID, Run ID, suspension ID

**Tool Execution Context**:
The immutable execution identity, cancellation, idempotency, and progress data for one Tool Attempt.
_Avoid_: Effect Context, ambient state, dependency container, extension map

### Runtime and extension seams

**Clock**:
An optional plain-JavaScript dependency for current time and cancellable sleep. Core uses it for local scheduling.
_Avoid_: Agent input, Transcript data, replacement for backend claim time

**ID Generator**:
An optional function that creates all core-owned opaque IDs. It receives no ID type.
_Avoid_: ID-kind registry, caller ID override, Agent-visible randomness

**Commissary Instance**:
The host interface from `commissary`. It binds one Thread Store and installs Agents when the host requests them.
_Avoid_: Agent, Runtime, Thread Store, global singleton

**Agent Client**:
A typed interface for one installed Agent. It provides durable commands, execution, and dynamic Hook subscriptions.
_Avoid_: Agent, Runtime Client, Run Handle

**Runtime**:
The core module that preserves invariants behind the Commissary Instance and Agent Clients.
_Avoid_: Commissary Instance, Machine, Loop, Execution

**Machine**:
The default state machine that advances Runs with safe policy defaults.
_Avoid_: Loop, Agent contribution, callback collection

**Runtime Operation**:
A typed phase action that preserves one Runtime invariant. It returns a value that only Runtime can create.
_Avoid_: Hook, Machine transition replacement, extension event

**Prepared Work**:
A Runtime-created choice of the next executable work for one claimed Run. It is either Model work or committed top-level Tool work.
_Avoid_: Prepared Run, Execution Snapshot, pending-work query

**Runtime Client**:
The capability that lets a Loop invoke Runtime Operations.
_Avoid_: Provider client, mutable Runtime, Hook continuation

**Loop**:
A host-controlled orchestration of Runtime Operations. It replaces the Machine decision loop.
_Avoid_: Machine plugin, Agent contribution, Driver

**Hook Point**:
A core-owned seam with a specific event, result, and composition rule.
_Avoid_: Runtime Operation, extension event, Execution Event

**Hook**:
A typed process-bound handler for one Hook Point. A Hook can change a value, make a decision, or observe work.
_Avoid_: Runtime Operation interceptor, host command wrapper, durable callback, live-mutated Execution policy

**Tool Result Hook**:
The Hook Point that can change or block a validated Tool success or declared Failure before core validates it again and saves it.
_Avoid_: Post-commit observer, Tool handler wrapper, persisted-result mutation

**Settlement Gate**:
The Hook Point that runs when a Run would finish. It can accept the candidate result or durably add one instruction for another Step in the same Run and active Execution.
_Avoid_: Settled-result mutation, unbounded follow-up loop, host command

**Settlement Continuation Ceiling**:
The maximum of 32 extra Steps that Settlement Gates can add. At the ceiling, core saves the current candidate result.
_Avoid_: Run Failure, general Step budget, host workflow limit

**Settlement Hook Deadline**:
The 30-second limit for one Settlement Gate handler. On timeout, core reports the Hook error and treats that handler as accepting the candidate result.
_Avoid_: Execution timeout, Run deadline, continuation ceiling

**Settlement Observer**:
The read-only Hook Point that receives a Run Result after core saves it.
_Avoid_: Settlement Gate, result transform, finalization blocker

**Dynamic Hook Subscription**:
A process-local Hook registration on an Agent Client. Each Execution captures the active registrations when it starts.
_Avoid_: Mid-Execution policy mutation, durable Hook, cross-process subscription

**Execution Event**:
An ephemeral observation of one Execution. Core dispatches it through the `onExecutionEvent` Hook Point.
_Avoid_: Message Entry, Model Event, durable event, derived text event

**Execution Event Record**:
A durable envelope that orders one Execution Event within a Run and identifies the Execution that emitted it.
_Avoid_: Execution Event, Message Entry, Run Snapshot

**Execution Event Store**:
An optional persistence contract that assigns Run-local sequences and durably appends ordered Execution Event Record batches before process-local observation.
_Avoid_: Thread Store, Stream Adapter, relay, transport

**Error Event**:
The `{ type: "error", error }` Execution Event that reports an error after an Execution starts.
_Avoid_: Failure, Interruption, thrown stream error, error-specific event name

### Contracts and results

**Codec**:
A reversible mapping between a durable domain value and its JSON-compatible form.
_Avoid_: Validation schema, store-specific serializer

**Failure**:
An expected typed result that an operation contract declares.
_Avoid_: Defect, thrown exception, model refusal

**Defect**:
An unexpected exception, invariant violation, or adapter fault outside declared results.
_Avoid_: Failure, Interruption, model refusal
