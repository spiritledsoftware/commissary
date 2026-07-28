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

Hooks can adapt preparation, Context, Model, provider, Tool, compaction, Branch, retry, Steering, abort, and settlement seams. Each Hook Point defines its exact authority.

Hooks receive no continuation or Runtime Client. They cannot invoke Runtime Operations, mutate an Execution Plan, intercept atomic Thread Store changes, or replace orchestration. Finalization is not hookable.

`onExecutionEvent` is the general process-local observation interface.

Model invocation Hooks wrap each leaf provider call. Composite Model frames do not dispatch these Hooks. This rule prevents policy bypass and duplicate request transformation.

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
