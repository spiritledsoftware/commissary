# Commissary

Commissary is a system for composable agents. It keeps durable Thread history separate from process-bound execution. An Agent renders the current Transcript before each Model invocation.

This file defines the domain terms. The ADRs in `docs/adr/` define the design rules and their reasons.

## Agents and composition

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

## Messages and history

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

## Threads and Runs

**Durable Entity Record**:
A stored value with its own durable identity and lifecycle. Threads, Branches, Message Entries, Runs, and Tool Calls are Durable Entity Records.
_Avoid_: Store command, snapshot, Execution Claim, pending command, all Thread Store values

**Thread**:
A durable identity. Its parent-linked Message Entries form a tree of agent work.
_Avoid_: Session, mutable conversation object, Branch

**Branch**:
A durably identified and human-named line of work in one Thread.
_Avoid_: Thread, global active leaf, linear transcript

**Store**:
The base persistence interface for typed Collections and query operators. Its readonly `collections` map lets its owner read and change every Record in its Collection Catalog directly.
_Avoid_: Thread Store, Commissary Instance, application database, hidden Core Collection, `collection(name)` method

**Record**:
A JSON-compatible object assembled from independently validated Record Fields.
_Avoid_: Domain object, raw database row, arbitrary JavaScript value

**Record Definition**:
The base `fields` map that defines one Collection. Each value is one Field Definition. Core and host field maps merge by Record and field name. A concrete adapter factory can accept its own wider typed definition.
_Avoid_: Whole-Record Schema, Record Extension, generic metadata object, adapter configuration standard

**Collection Catalog**:
The complete effective Core and Custom Record definitions available through the host Store's `collections` map.
_Avoid_: Collection Map, adapter-private table, subset of Core state, all physical storage

**Collection Map**:
The readonly `Store.collections` object keyed by every Record name in the Collection Catalog. Known names use dot access, and typed dynamic names use bracket access.
_Avoid_: Collection Catalog, `collection(name)` method, Collections placed directly on Store

**Runtime State Collection**:
A Core Collection for claims, pending commands, idempotency, finalization, or similar Runtime state. It is host-accessible and customizable. Direct host changes can break Runtime behavior.
_Avoid_: Hidden Collection, security boundary, safe host mutation, adapter-private table

**Runtime State Catalog**:
The fourteen Core Collections for `executionClaim`, `executionFence`, `pendingSteering`, `pendingRedirect`, `runCommandSequence`, `toolCallSequence`, `runSubmission`, `toolResumeRequest`, `steeringRequest`, `redirectRequest`, `commit`, `finalizationOutcome`, `modelCommitOutcome`, and `settlementOutcome`.
_Avoid_: Process-local control waiters, Tool Call graph indexes, hidden adapter state, optional Core subset

**Thread Store Backend**:
The Transaction Store over the same complete effective Collection Catalog exposed by the host-facing Thread Store. Core uses its `transaction` operation to implement Runtime transition rules. It can back a Thread Store only when the Core Runtime conformance suite passes with its actual operator semantics.
_Avoid_: Different private catalog, waived Core outcome, Thread Store, separate atomic capability, security boundary

**Record Field**:
One named top-level value in a Record.
_Avoid_: Complete Record, query expression, nested object path

**Field Schema**:
A deterministic, side-effect-free Standard Schema that validates and infers one Record Field for one or more Store operations. Store does not use it to enforce a rule between fields. Hooks and adapter generation own effectful value production.
_Avoid_: Effectful default, invocation-count dependency, Whole-Record Schema, cross-field validator, Zod-only contract

**Field Definition**:
Either one Field Schema used for select, create, and update, or an object with `select`, optional `create`, and optional `update` schemas. Missing `create` uses `select`. Missing `update` uses `create`.
_Avoid_: Whole-Record Schema, separate field extension helper

**Select Field Schema**:
The Field Schema used for full and projected reads, Store Operator field values, and final Record validation.
_Avoid_: Raw stored operator value, Create Field Schema, Update Field Schema, whole-Record validator

**Selected Field Value**:
The output of one Select Field Schema parse. Public Records and Store Operators use this value. Select parsing alone does not rewrite the stored create, generated, literal-update, or expression output.
_Avoid_: Raw stored field, automatically persisted select transform, repeated parse of one fallback field value

**Create Field Schema**:
The Field Schema used for one field in `create`. It falls back to the Select Field Schema.
_Avoid_: Complete create validator, Select Field Schema, adapter default

**Update Field Schema**:
The Field Schema used for a supplied literal field in `update`. It falls back to the Create Field Schema.
_Avoid_: Complete update validator, Select Field Schema, update expression

**Field Round-Trip Compatibility**:
The rule that every defined effective select, create, and update output must be accepted as input by the effective Select Field Schema. `undefined` means omission and is excluded. Static types check defined value shapes, and runtime select validation checks refinements.
_Avoid_: Output equality, unchecked defined transform, adapter conversion promise

**Missing Field**:
A Record Field whose key is absent. Read and create pass `undefined` to the effective Field Schema. A defined output supplies the value or default; an `undefined` output keeps the key absent. An omitted update field remains unchanged.
_Avoid_: `null`, own property with `undefined`, Unset Expression

**Adapter-Generated Field Value**:
An adapter-specific default that fills a field only after its Create Field Schema returns `undefined`. A defined host value always wins and cannot be overwritten. The generated value must pass the Select Field Schema.
_Avoid_: Adapter-owned field, write protection, `create: false`, overwritten host value

**Strict Record Parsing**:
The top-level rule that rejects each key absent from the Record definition or requested projection. Store does not pass through or silently strip unknown Record keys. Each Field Schema still owns parsing inside its field value.
_Avoid_: Passthrough Record, stripped unknown Record key, nested Field Schema policy

**Core Record**:
A Record with fields and a contract required by core. Every Core Record type merges host fields and remains directly accessible through its Collection. A host field with the same name as a built-in Core field is one compatible validation narrowing, not a second field.
_Avoid_: Custom Record, adapter-private row, duplicate shadow field, safe host mutation

**Core Create Draft**:
The built-in create values that core supplies for one Core-created Record. Every Core Record has one draft entry. Command Create Fields are merged into this unvalidated draft before its Before Create Hook runs.
_Avoid_: Validated create input, selected Record, adapter-generated value

**Command Create Fields**:
The typed `fields` bag on a Commissary command that directly creates a Core Record. It contains only host-added fields for that Record. Required custom create fields are required in this bag.
_Avoid_: Built-in command argument, complete Record input, internal create fallback

**Command Create Path**:
A public Commissary command whose input exposes a custom `fields` bag for the primary Record that it creates. Version 1 has command create paths for Thread, Branch, and Run. Records created only as command side effects use Internal Create Paths.
_Avoid_: Raw Collection create, command side effect, internal Runtime create

**Internal Create Path**:
A path where core creates a Record without a host-provided command input for that Record. Version 1 uses it for every Core Record except Thread, Branch, and Run. A required custom create field on this path requires a Before Create Hook.
_Avoid_: Command Create Path, raw Collection create, private Collection

**Before Create Hook**:
A host callback for one Collection. It receives an unvalidated Core or host create draft and returns the complete create input before strict Field Schema validation. It can replace built-in fields and runs once per create attempt. A command-only create path does not make the hook required.
_Avoid_: After-create event, adapter default, validation bypass, once-per-logical-operation promise

**Required Custom Create Field**:
A host-added field on a Core-created Record whose effective Create Field Schema input excludes `undefined`. A command create requires it in Command Create Fields. An Internal Create Path requires a Before Create Hook. If both paths exist, both requirements apply.
_Avoid_: Optional field, defaulted create field, adapter-generated value, runtime-only hook check

**Collection**:
A typed set of Records with required find, create, update, delete, and count operations. An adapter that can never perform one safely does not implement Store.
_Avoid_: Optional base CRUD method, always-unsupported CRUD method, Thread Store operation, database table, repository

**Collection Adapter Boundary**:
The public Collection API that each adapter implements directly. An adapter can use native storage operations, optional shared Fallback Helpers, or both. There is no required low-level driver below this boundary.
_Avoid_: Universal `scan` driver, mandatory Record replacement API, adapter-specific public CRUD shape

**Fallback Helper**:
An optional reusable implementation of Store behavior. An adapter calls it only when the adapter can supply the storage operations and atomicity that make the behavior safe.
_Avoid_: Required adapter primitive, automatic unsafe fallback, universal storage driver

**Store Async Boundary**:
The public boundary where every asynchronous Store-family method creates and returns a native Promise before validation or host callback execution. It never throws synchronously. Effect values and custom thenables stay behind adapters. A Store builder callback throw rejects the Promise with the same value.
_Avoid_: Synchronous method throw, `PromiseLike`, public Effect value, adapter-specific async result

**Base Store Cancellation**:
Version 1 Base Store CRUD and Transaction Store operations accept no `AbortSignal`. A future cancellation-capable Store must first define whether an aborted write can still commit, and an integration that needs it must require that Store type.
_Avoid_: Best-effort base cancellation, silent background write, cancellation without write outcome semantics

**Base Store Retry**:
The rule that the shared Store layer never retries CRUD. An adapter can retry internal I/O only when it preserves one logical operation and cannot duplicate a write. Hosts own higher-level retry policy.
_Avoid_: Hidden write retry, shared retry loop, duplicated create, Core Transaction Retry

**Store Observability**:
Logging, tracing, query plans, full-scan warnings, or native-versus-fallback events around Store work. Base Store emits none. A later primitive or higher-level wrapper can add them.
_Avoid_: Base side effect, automatic console warning, runtime capability registry

**Unbounded Find**:
A `find` call without `limit` that requests every matching Record. An adapter can reject it but cannot silently truncate it.
_Avoid_: Automatic page, silent maximum, partial result

**Store Operator**:
A typed query or update operation supplied by a Store Operator Set. The shared fallback and an adapter can use the same name with different behavior.
_Avoid_: Arbitrary JavaScript function, raw SQL function, untyped adapter hook

**Store Operator Set**:
All query and update operators supplied by one Store adapter. The Store passes them as one `op` object to every Collection callback. Fixed support is part of the type.
_Avoid_: Separate query and update operator objects, global operator registry, hidden adapter override

**Adapter Conformance Profile**:
Test-only input that states one adapter's operator semantics, string order, equal-value tie behavior, and query limits for shared conformance helpers. It is not available on Store values.
_Avoid_: Runtime capability registry, production Store metadata, undocumented adapter behavior

**Store Expression**:
A typed value returned by a Store Operator. It carries the Store Operator Set identity and one opaque callback-scope token. Store rejects an expression that escapes or is reused in another callback.
_Avoid_: Raw native expression, expression from another Store Operator Set, escaped expression, reused expression

**Store Capability Requirement**:
The primitive Store interface that an integration requires in its input type. A required wider feature uses a wider Store type, such as Transaction Store, instead of a runtime capability check.
_Avoid_: `supports` registry, capability matrix, accept-base-Store-then-probe

**Primitive Store Contract**:
A storage capability interface designed before its concrete adapters. Adapters implement it, and higher-level abstractions compose it.
_Avoid_: Common interface extracted from adapters, adapter API treated as the primitive, bottom-up contract discovery

**SQL Store**:
A future primitive Store contract for SQL capabilities. Its exact API and package are outside the current Store specification and will be designed before concrete SQL adapters.
_Avoid_: Contract extracted from SQL adapters, current specification deliverable, one adapter's API renamed as shared

**Store Error**:
The base Error class for expected Store operational failures. Specific subclasses identify validation, Hook, unsupported-operation, adapter I/O, transaction-conflict, and rollback failures. Successful result types do not include these errors.
_Avoid_: Adapter Contract Error, result union, one generic wrapper, Transaction Callback Failure

**Store Validation Error**:
An expected Store Error for invalid query, create, or update input or result. Its safe fields identify the Collection, operation, phase, optional field, and normalized issue paths. Field Schema issue messages are diagnostic data, not safe default telemetry.
_Avoid_: Rejected Record value, safe-to-log issue message, Adapter Contract Error, schema-library error object

**Store Hook Error**:
An expected Store Error that identifies a failed `beforeCreate` Hook and preserves the thrown value as its cause.
_Avoid_: Invalid Hook output, swallowed Hook failure, safe-to-log cause

**Store Adapter Error**:
An expected Store Error that identifies an adapter I/O failure and preserves the adapter failure as its cause.
_Avoid_: Adapter Contract Error, raw adapter error contract, safe-to-log cause

**Store Adapter Contract Error**:
A defect Error outside the Store Error hierarchy. It reports that an adapter returned invalid data, overwrote a host value, produced an impossible expression result, or broke its transaction contract.
_Avoid_: Expected Store Error, caller validation failure, unsupported operation, recoverable result

**Safe Store Error Metadata**:
Store-generated names, operations, phases, paths, features, violations, and write-state flags that can be logged without copying a complete input or Record. Field Schema issue messages, causes, callback failures, and rollback failures are excluded from default logging and telemetry.
_Avoid_: Complete Record, operation input, validation issue message, automatic cause logging, rejected field value

**Unsupported Store Operation**:
An expected `UnsupportedStoreOperationError` reported when an adapter cannot execute an operation safely for the supplied input or current backend state. Its fields identify the Collection, operation, and feature. An operator that is never supported is absent from the adapter type.
_Avoid_: Always-throwing typed operator, unsafe fallback, silent no-op, Defect, capability registry

**Store Query**:
A typed expression over effective selected Collection field values that uses Store Operators. Each referenced field first passes through its Select Field Schema. A parsed-missing value then normalizes to `null`. Nested object access uses Field Paths. Arrays expose no index paths.
_Avoid_: Raw stored value, arbitrary JavaScript predicate, SQL string, raw adapter query object, array-index path

**Field Path**:
An immutable nonempty tuple of object-key strings stored inside a field reference. It does not use dot-separated encoding and never contains an array index.
_Avoid_: Dotted string, escaped key syntax, array-index path, exported database column path

**Find Evaluation Order**:
The logical order `where`, lexicographic `orderBy`, `offset`, `limit`, and projection. The first order expression is primary. Without `orderBy`, result order is not portable.
_Avoid_: Projection before filtering, limit before offset, implicit identifier tie-breaker, stable unordered paging

**Fallback String Order**:
The case-sensitive, non-locale JavaScript string order used by fallback comparisons and sorting.
_Avoid_: Database collation promise, locale-aware order, case folding

**Update Expression**:
A typed Store Expression that calculates a field's new selected value during `update`. It reads effective selected field values. A raw literal beside expressions passes through the Update Field Schema, while an expression result passes through final Select Field Schema validation.
_Avoid_: Arbitrary JavaScript updater, raw stored field, Store Query, raw adapter expression object, update-schema bypass for a raw literal

**Update Evaluation Snapshot**:
The Record state before an update. Every fallback expression in one `set` callback reads this same state.
_Avoid_: Left-to-right assignment state, partially updated Record, callback property order

**Fallback Arithmetic**:
Update Expression arithmetic that uses JavaScript number behavior. A non-finite operand or result rejects the complete update with a Store Validation Error.
_Avoid_: Decimal arithmetic, database-native arithmetic promise, partial update

**Array Concat Expression**:
An Update Expression that concatenates two arrays and returns a readonly array of the union of both element types. It preserves runtime order and duplicates but does not preserve tuple positions.
_Avoid_: Tuple-shape promise, element coercion, set union

**Coalesce Expression**:
An Update Expression that returns its left value unless that value is `null` or missing. It evaluates its fallback only when needed. False, zero, and the empty string are defined values.
_Avoid_: Truthiness fallback, eager fallback evaluation, null-only fallback

**Conditional Update Expression**:
An Update Expression that evaluates one predicate and only the selected result branch.
_Avoid_: Eager branch evaluation, statement-level conditional, JavaScript callback

**Array Filter Expression**:
An Update Expression that keeps array elements selected by a predicate. The fallback preserves order and duplicates, uses Field Paths below the element root, exposes no array index, and uses the fallback Store Query rules for null and missing values.
_Avoid_: JavaScript callback, element index, parent Record access, array-index path

**Unset Expression**:
An Update Expression that removes an optional top-level Record field or optional object key inside `merge`. A key is optional when `{} extends Pick<Value, Key>` is true for its selected output type.
_Avoid_: Required field removal, schema-library metadata, `null`, path-based delete, complete Record deletion

**Thread Store**:
A Store specialization that exposes every Core and Custom Collection plus atomic durable operations implemented by core over a Thread Store Backend.
_Avoid_: Generic Store, public Instance property, Agent-selected persistence

**Memory Store**:
The `MemoryStore.make` factory and its generic process-local Transaction Store result. It accepts an explicit Record catalog and uses the shared memory storage engine.
_Avoid_: Memory Thread Store, conditional Core mode, second memory engine

**Memory Thread Store**:
The `MemoryThreadStore.make` factory and its process-local Thread Store result. It composes the shared memory Transaction Store engine with Core Records, Hooks, and operations. The engine locks each complete transaction and owns rollback.
_Avoid_: Generic Memory Store, duplicated Runtime rules, conditional factory return, durable storage

**Transaction Store**:
A Store specialization with one `transaction` operation. Its callback receives a Transaction View without `transaction`, so nesting is not supported. A wider adapter adds each capability that is safe inside the active transaction. Version 1 accepts no cancellation option. Overlapping transactions must act as if they ran one at a time, and two conflicting transactions cannot both commit. Each adapter enforces this rule in its storage system. One transaction call invokes its callback at most once. If the callback fails, the adapter discards all of its writes and then reports the same failure value. A failed rollback reports a Transaction Rollback Error.
_Avoid_: Sequential fallback, shared in-process lock, weaker overlap guarantee, hidden callback retry, `AbortSignal`

**Transaction View**:
The Store passed to a transaction callback. It uses the transaction's Records and operators, includes adapter capabilities that are safe inside the active transaction, and has no `transaction` method.
_Avoid_: Transaction Store, nested transaction, savepoint, independent Store

**Transaction Capability**:
An adapter feature that remains safe and bound to the active transaction. The adapter defines which wider capabilities its Transaction View includes.
_Avoid_: Nested `transaction`, capability used outside the active transaction, mandatory base Store feature

**Transaction Conflict**:
An expected `TransactionConflictError` reported when a transaction cannot commit without breaking the overlap guarantee. The Transaction Store does not rerun the callback. Core starts a new transaction for its storage-only work while fewer than three attempts have run.
_Avoid_: Adapter I/O failure, partial commit, hidden callback retry, Defect

**Transaction Rollback**:
The adapter-owned action that discards every write from a failed transaction callback. Each adapter uses its own storage mechanism. Core provides no shared rollback fallback. After rollback succeeds, Store preserves the callback failure. After rollback fails, stored state is unknown.
_Avoid_: Failed create cleanup, partial commit, Core rollback, shared rollback implementation

**Transaction Rollback Error**:
An expected Store Error for a failed Transaction Rollback. It contains the callback failure and rollback failure, sets `writesMayRemain` to `true`, and prevents a Core retry. Its failure values are not safe default telemetry.
_Avoid_: Transaction Callback Failure, Transaction Conflict, known clean state, automatic retry, safe metadata

**Transaction Callback Failure**:
The exact value that causes a transaction callback to fail. After rollback succeeds, `transaction` rejects with this value unchanged.
_Avoid_: Transaction Conflict, Store wrapper, rollback failure, Adapter I/O failure

**Core Transaction Retry**:
A new transaction started immediately by a specialized Thread Store operation after a Transaction Conflict. The Core callback only reads and writes Store data. One operation makes at most three transaction attempts: the first attempt and two retries.
_Avoid_: Adapter callback retry, unbounded retry, retry of external work

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

## Models and Tools

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

## Runtime and extension seams

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

**Stream Adapter**:
An adapter that changes Execution Events into a bounded, single-consumer stream.
_Avoid_: Core event queue, relay, replay log, transport

**Events Dropped Event**:
An adapter Event that reports how many buffered Events a Stream Adapter discarded.
_Avoid_: Error Event, durable gap marker, execution backpressure, core event

**Error Event**:
The `{ type: "error", error }` Execution Event that reports an error after an Execution starts.
_Avoid_: Failure, Interruption, thrown stream error, error-specific event name

## Contracts and results

**Codec**:
A reversible mapping between a durable domain value and its JSON-compatible form.
_Avoid_: Validation schema, store-specific serializer

**Failure**:
An expected typed result that an operation contract declares.
_Avoid_: Defect, thrown exception, model refusal

**Defect**:
An unexpected exception, invariant violation, or adapter fault outside declared results.
_Avoid_: Failure, Interruption, model refusal
