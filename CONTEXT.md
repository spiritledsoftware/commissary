# Commissary

Commissary is a composable agent-building system. It separates durable Thread history from process-bound execution so an Agent can be rendered from the current Transcript before each model invocation.

## Agents and composition

**Agent**:
A reusable definition whose executable form is rendered from the current Transcript.
_Avoid_: Live agent, runtime instance

**Agent ID**:
A caller-owned stable identity for resolving one Agent across processes and deployments.
_Avoid_: Agent Reference, display name, Thread ID

**Agent Revision**:
A deterministic identity for one Agent's installed static composition and stable contracts.
_Avoid_: Manual version, application release, per-invocation hash

**Agent Reference**:
A durable reference pairing an Agent ID with the Agent Revision that produced some work.
_Avoid_: In-memory Agent object, Agent ID alone, Model name

**Agent Compatibility**:
The determination that an installed Agent can safely continue deferred work produced by another Agent Revision.
_Avoid_: Revision equality, unchecked latest version, Execution Plan equality

**Agent Installation**:
The validation and fixation of an Agent's Hooks and stable contracts before execution.
_Avoid_: Render, model invocation, Agent Tree

**Agent Fragment**:
An opaque composable authoring value containing named Agent contributions.
_Avoid_: Plugin manifest, generic property bag, runtime object

**Render**:
The derivation of an Agent Tree from the current Transcript for one model invocation.
_Avoid_: Installation, execution, compilation

**Agent Tree**:
A declarative description of the Context, Model, and Tools selected for one model invocation.
_Avoid_: Agent configuration, Execution Plan, live agent

**Execution Plan**:
The immutable, fully resolved form of an Agent Tree for one model invocation.
_Avoid_: Agent Tree, mutable runtime, Agent Revision

**Context**:
A contribution of model-visible information derived during Render.
_Avoid_: Effect Context, dependency container, Transcript

**Context Tree**:
The ordered model-visible information selected for one model invocation.
_Avoid_: Effect Context, runtime environment, Transcript

## Messages and history

**Model Message**:
A provider-neutral role-bearing turn composed of ordered Content Parts and optional Message Data.
_Avoid_: Provider message, Signal, Message Entry

**Content Part**:
A typed provider-neutral piece of model-visible content, such as text, reasoning, a source, a file, a Tool call, or a Tool result.
_Avoid_: Provider event, Signal, Message Data

**Provider Data**:
A namespaced, versioned provider-owned payload attached to one Content Part, preserved for replay through the matching provider adapter but never rendered as content.
_Avoid_: Message Data, Provider Options, raw provider object

**Reasoning Part**:
A provider-returned reasoning summary or explanation preserved separately from ordinary assistant text.
_Avoid_: Hidden chain-of-thought, provider metadata, ordinary Text Part

**Source Part**:
A normalized provider-neutral citation or source reference returned by a Model, such as a URL or document source.
_Avoid_: Provider metadata, inline citation text, raw provider source object

**Message Data**:
A model-safe, namespaced, versioned payload attached to a Model Message and preserved with it in Thread history.
_Avoid_: Arbitrary metadata, Provider Options, secrets, credentials

**Message Entry**:
An immutable node in a Thread's history tree containing one canonical Model Message.
_Avoid_: Agent input, provider payload, custom entry

**Transcript**:
The ordered model-visible conversation projected from one Branch of Message Entries.
_Avoid_: Thread tree, provider payload, application database

**Artifact Reference**:
An opaque durable reference to file-like content used by Message Data and Content Parts.
_Avoid_: Inline bytes, external URL, provider file ID

**Artifact Store**:
The host-supplied persistence contract for bytes addressed by Artifact References.
_Avoid_: Thread Store, inline Message bytes, provider file storage

## Threads and Runs

**Thread**:
The durable identity whose parent-linked Message Entries form a tree of agent work.
_Avoid_: Session, mutable conversation object, Branch

**Branch**:
A durably identified, human-named line of work within a Thread.
_Avoid_: Thread, global active leaf, linear transcript

**Thread Store**:
The host-supplied persistence contract for Threads, Branches, Runs, Execution Claims, Message Entries, and their atomic transitions.
_Avoid_: Transcript, memory provider, Agent-selected persistence

**Run**:
One durably admitted effort to advance a Branch from a Message Entry or Tool resumption to a durable outcome.
_Avoid_: Thread, process, Execution Attempt

**Run Request ID**:
An optional caller-owned idempotency identity for Run admission.
_Avoid_: Run ID, Message Entry ID, Tool Call ID

**Run Admission**:
The durable result of creating or finding one Run and admitting its initial Message Entry.
_Avoid_: Job enqueue, execution start, Run Result

**Execution Attempt**:
One process-bound effort to advance an admitted Run.
_Avoid_: Run, Step, retry policy

**Execution Claim**:
An expiring fenced grant authorizing one Execution Attempt to advance a Run.
_Avoid_: Run ownership, job lease, unfenced lock

**Run Result**:
The durable resolved outcome of a Run together with its Run, Thread, Branch, head, and usage identities.
_Avoid_: Execution Attempt outcome, Transcript, Message Entries

**Step**:
One model invocation and the Tool executions it requests before the Machine advances again.
_Avoid_: Run, Message Entry, Tool Attempt

**Interruption**:
A typed recoverable reason that a Run cannot currently advance.
_Avoid_: Failure, Defect, Signal

**Stale Agent Interruption**:
An Interruption indicating that the installed Agent cannot safely continue deferred work created by an earlier Agent Revision.
_Avoid_: Failure, Defect, terminal Run Result, automatic retry

**Authentication Required Interruption**:
An Interruption indicating that a Model provider cannot proceed until the host explicitly obtains valid credentials.
_Avoid_: OAuth prompt, Tool Suspension, terminal Failure, automatic login

**Provider Compatibility Interruption**:
An Interruption indicating that the selected provider adapter cannot safely translate the canonical request or replay history because a required capability or Provider Data contract is unavailable.
_Avoid_: Model Failure, Defect, silent metadata loss

**Provider Unavailable Interruption**:
An Interruption indicating that a Model provider cannot currently serve the Run because of a transient condition or exhausted quota, with retry or reset timing preserved when available.
_Avoid_: automatic retry, terminal Failure, Authentication Required Interruption

**Model Output Interruption**:
An Interruption indicating that a Model produced invalid or schema-nonconforming output and another sample may succeed.
_Avoid_: Provider Unavailable Interruption, committed Model Response, adapter Defect

**Artifact Storage Required Interruption**:
An Interruption indicating that a Run needs to read or persist file content but the host supplied no Artifact Store.
_Avoid_: inline-byte fallback, Model Failure, Defect

**Steering**:
A command that contributes another canonical Model Message to an active Run between Steps.
_Avoid_: Follow-up Run, Tool resumption, Hook patch

**Steering Request ID**:
An optional caller-owned idempotency identity for a Steering submission.
_Avoid_: Run Request ID, Message Entry ID, content hash

**Pending Steering**:
A durably accepted Steering Message waiting for application at a safe Run boundary.
_Avoid_: Follow-up queue, Branch history, Tool Suspension

## Models and Tools

**Model**:
A capability that transforms one Model Request into a stream of Model Events.
_Avoid_: Provider configuration, raw LLM client, Effect AI LanguageModel

**Model Request**:
The provider-neutral input assembled from a Context Tree, Transcript, Tools, and model options.
_Avoid_: Provider payload, raw SDK request

**Model Event**:
A provider-neutral update emitted during one Model invocation.
_Avoid_: Signal, raw provider chunk, Model Response

**Model Response**:
The provider-neutral completed result of one Model invocation.
_Avoid_: Agent output, raw provider response, Run Result

**Finish Reason**:
The provider-neutral reason that a completed Model Response stopped, including refusal, content filtering, or provider-requested continuation.
_Avoid_: Run Result, Failure, Interruption

**Model Failure**:
A terminal provider-neutral Run failure produced when a Model provider rejects a request before returning a Model Response and changing the request is required.
_Avoid_: completed refusal, Interruption, Defect, raw provider error

**Provider Options**:
Typed namespaced request data interpreted by one Model provider and ignored by core.
_Avoid_: Core model setting, untyped metadata

**Provider Integration Instance**:
A host-bound value for one Model provider configuration and credential scope that creates Model contributions and exposes explicit authentication operations.
_Avoid_: Model, raw provider client, Effect Layer, global singleton

**Tool**:
A named model-callable capability with validated input, output, and declared outcomes.
_Avoid_: Host dependency, arbitrary function

**Provider Tool**:
A Tool executed by a Model provider within its Model invocation rather than by the Commissary Machine.
_Avoid_: Tool Provider, Provider Options, durable Tool Attempt

**Provider Callback Tool**:
A provider-defined Tool whose wire contract belongs to the Model provider but whose handler runs as a durable Commissary Tool Attempt.
_Avoid_: Provider Tool, provider-hosted execution, in-memory Effect AI callback

**Tool Provider**:
A declarative contribution that resolves Tools for one model invocation using dependencies captured by its factory.
_Avoid_: Static Tool, dependency container, effectful Agent Fragment

**Tool Call**:
A durable semantic request to invoke one Tool.
_Avoid_: Tool definition, provider call, Tool Attempt

**Tool Attempt**:
One process-bound execution of a Tool Call.
_Avoid_: Tool Call, Execution Attempt

**Tool Suspension**:
A nonterminal Tool outcome that durably pauses its Run pending compatible resumption.
_Avoid_: Tool result, Tool Failure, Interruption

**Tool Resume**:
A durable command supplying Codec-validated external input to one Tool Suspension so its Run may execute again.
_Avoid_: Steering, Tool result, immediate execution

**Tool Resume Request ID**:
An optional caller-owned idempotency identity for a Tool Resume.
_Avoid_: Tool Call ID, Run Request ID, suspension ID

**Tool Execution Context**:
The immutable core execution identity, cancellation, idempotency, and progress data supplied to one Tool Attempt.
_Avoid_: Effect Context, ambient state, dependency container, extension map

## Runtime and extension seams

**Commissary Instance**:
The host-bound application interface returned by `commissary`, owning Thread Store access, registered Agents, and Driver selection.
_Avoid_: Agent, Runtime, global singleton

**Agent Client**:
A typed interface binding one registered Agent to a Commissary Instance for durable commands and process-bound execution.
_Avoid_: Agent, Runtime Client, Run Handle

**Runtime**:
The invariant-preserving core module behind a Commissary Instance and its Runtime Clients.
_Avoid_: Commissary Instance, Machine, Driver, Execution Attempt

**Machine**:
The default state machine that advances Runs using safe policy defaults.
_Avoid_: Driver, Agent contribution, callback collection

**Runtime Operation**:
A typed phase action that preserves one local runtime invariant while exposing orchestration.
_Avoid_: Hook, Machine transition replacement, extension event

**Runtime Client**:
The capability through which a Driver invokes Runtime Operations.
_Avoid_: Provider client, mutable Runtime, Hook continuation

**Driver**:
A host-controlled orchestration of Runtime Operations.
_Avoid_: Machine plugin, Agent contribution

**Hook Point**:
A core-owned adaptation or Machine-decision seam with a point-specific event and composition law.
_Avoid_: Runtime Operation, extension event, Signal

**Hook**:
A process-bound installed handler for one Hook Point.
_Avoid_: Signal subscriber, Runtime Operation interceptor, durable callback

**Signal**:
An ephemeral observation of work performed by an Execution Attempt.
_Avoid_: Message Entry, Model Event, durable event

## Contracts and outcomes

**Codec**:
A reversible contract between a durable domain value and its JSON-compatible representation.
_Avoid_: Validation schema, store-specific serializer

**Failure**:
An expected typed outcome declared by an operation contract.
_Avoid_: Defect, thrown exception, model refusal

**Defect**:
An unexpected exception, invariant violation, or adapter fault outside declared outcomes.
_Avoid_: Failure, Interruption, model refusal
