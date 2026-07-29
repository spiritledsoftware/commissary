# Compose Machine policy through typed Hooks

## Hook construction

The public `Hook` namespace has one constructor for each closed Hook Point. For example, `Hook.beforeModelRequest(handler)` infers that point's event and permitted result.

`Hook.on(point, handler)` is the generic interface for adapter authors. Each constructor returns an opaque Hook value.

A host can install the same Hook as a static Agent Fragment or pass it to `client.subscribe(hook)`. Static Hooks contribute to Agent Revision. Dynamic Hooks are process-local and do not change the Agent contract or revision.

`client.subscribe` returns an idempotent unsubscribe function.

## Execution capture and order

At `execute`, core captures the current dynamic subscriptions. It runs installed static Hooks first. It then runs dynamic Hooks in subscription order.

This Hook set does not change during the Execution. A later subscription change affects only later Executions.

Hook composition uses these rules:

- A transformation is an ordered pipeline. Each Hook receives the current value.
- A block result stops the point.
- A decision point uses its defined update and stop rules.
- A notification runs every Hook in order.

A Hook combination is never a conflict by itself. A thrown exception or malformed result follows that Hook Point's error rule.

A notification handler must return `undefined`. It cannot return a patch by accident.

## Authority

Hooks can adapt preparation, Context, the root Model request and result stream, Tool input and result, retry, and settlement seams. Each Hook Point defines its exact authority.

Hooks receive no continuation or Runtime Client. They cannot invoke Runtime Operations, mutate an Execution Plan, intercept atomic Thread Store changes, or replace orchestration. Finalization is not hookable.

`onExecutionEvent` is the general process-local observation interface.

Model Hooks run once around the root Model invocation. Composite Model frames and child Model calls do not dispatch them. A provider adapter or Model implementation owns Hooks or middleware for its internal calls. This rule prevents duplicate transformations and keeps one public Model callback surface.

## Host commands

Hooks do not wrap Agent Client commands such as start, Steering, Redirect, resume, or abort. They also do not wrap Thread and Branch administration. The host owns these calls and can apply its own policy before it calls core.

An idempotent command replay never re-runs a Hook or applies current process policy to an accepted command.

## Request transformation and Model selection

`beforeModelRequest` is an ordered transformation pipeline over the root Model Request. A Hook can change Context, Messages, and Provider Options. It can remove installed Tools from the advertised Tool list.

Core validates every transformed request. A Hook cannot add or modify a Tool definition because core has no matching installed Tool to execute. It cannot replace the root Model.

A Hook can add a typed namespaced Routing Hint to Provider Options. A Composite Model can use that hint to choose one of its declared child Models. Core does not interpret the hint. Model selection remains in the Composite Model so resource handling, cancellation, Usage, and cycle checks stay in one path.

## Model stream and final-result transformation

For every Model invocation to which it applies, the Model stream Hook Point forms an ordered transformation pipeline over canonical Model Events. Transformation happens before Hook observation, Execution Event delivery, result derivation, and persistence. Core derives the candidate Model result from the transformed terminal Event.

Core withholds that terminal Event while the final-result Hooks run. Each final-result Hook receives the current candidate and can replace it, block it, or request a permitted retry. Core validates each replacement.

Core then emits one complete authoritative terminal Model Event and saves that exact result. A client can display earlier streamed Events as a preview, but it must replace that preview with the authoritative result. Core never silently changes only the saved copy.

A transformed stream must keep a valid canonical structure, including exactly one terminal Event and no later Events. An invalid transformation is a Defect.

## Tool result transformation

`afterToolExecution` runs after core validates a Tool success or declared Failure and before core saves it. Static and dynamic Tools use the same Hook Point.

The Hooks form an ordered transformation pipeline. Each Hook receives the current result and can replace it or block the phase. Core validates the replacement output, Failure, and rich content before it saves them atomically. A malformed Hook result is a Defect.

Suspensions and Defects do not enter this Hook Point.

## Settlement gate and observation

`beforeSettlement` runs when no Tool work, Steering, Redirect, or other required work remains and the Run would otherwise finish. It receives the candidate Run Result. A Hook can accept that result or return one canonical instruction that continues the same Run with another Step. It cannot replace the candidate result.

Core records the continuation instruction and increments a durable continuation count before it starts the next Step. It then re-enters the default Machine or custom Loop under the same Run and active Execution Claim. Recovery sees the committed instruction and does not re-run a completed gate cycle. Core allows at most 32 continuation Steps. If another continuation is requested at the ceiling, core ignores it and saves the current candidate result.

Each Settlement Gate handler has a 30-second deadline. On timeout, core publishes a Hook Error Event, treats that handler as accepting the candidate, and runs the remaining handlers. Another handler can still request continuation.

When every Hook accepts the candidate, core commits the exact result atomically. `onSettlement` receives that saved result as a read-only notification. Its return value is ignored, and it cannot mutate or reopen the Run.

## Hook kinds and errors

A `before…` Hook can return its declared patch or block result. An unexpected exception is a Defect.

An `after…` Hook receives a successful phase result before core uses or commits it. It can return only its declared patch or block result. A callback after persistence is an `on…` Hook, not an `after…` Hook.

An `on…` Hook only observes. Core isolates its exceptions and continues other observers. Core publishes an Error Event to each `onExecutionEvent` Hook except the Hook that failed.

If an observer throws while core delivers an Error Event, core isolates that exception and does not publish another Error Event. Observer errors never change the Run or Execution result.

## Retry and stopping policy

Core has no Budget, Limit, Stopping Policy, or durable Step limit. An integration can count leaf Model calls and Model Usage in one Execution. It can block another invocation through `beforeModelRequest`.

This state resets for each Execution. A limit across Executions belongs to the host's durable workflow.

`afterModelInvocation` can replace a retryable Model Interruption with a retry instruction and optional delay. The Machine waits with cancellation and calls the Model again in the same Execution Claim.

The default Machine requests no retry. If no Hook requests a retry, core records the Interruption and ends the Execution. Scheduling another Execution belongs to the host.
