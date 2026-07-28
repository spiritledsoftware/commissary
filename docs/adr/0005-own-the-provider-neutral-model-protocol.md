# Own the provider-neutral Model protocol

## Canonical protocol

Commissary owns one plain-data protocol for Model Requests, Model Messages, Content Parts, Model Events, and Model Responses. Model adapters translate provider values at this boundary.

Core uses semantic events for Machine behavior. It does not use provider metadata for core decisions.

Provider adapters define typed and namespaced Provider Options. Core passes these options without interpretation. Core does not accept raw string-keyed option bags or global type augmentation.

Start submissions and Steering accept canonical Model Messages. They do not use Agent input schemas. A completed Run returns a Model Response. Application output conversion and validation stay outside core.

## Provider packages

Core bundles no provider. The first-party provider packages are:

- `@commissary/openai`.
- `@commissary/openai-codex`.
- `@commissary/openai-compatible`.
- `@commissary/anthropic`.

Each package root exposes plain JavaScript configuration and opaque Model contributions. Each package also exposes an `effect` subpath. The first plain JavaScript example uses `@commissary/openai`. Other providers use separate guides.

Provider authors use Effect AI behind the bridge from [ADR 0003](0003-keep-effect-behind-javascript-contracts.md). The bridge accepts Effect AI `Model` values, not anonymous `LanguageModel` Layers. This rule keeps provider and Model identity available.

Core keeps `Model.define` as the advanced plain JavaScript implementation interface. It supports test doubles, local Models, and custom providers.

## Composite Models

An installed Agent resolves one root Model. A Composite Model declares each child Model and invokes it through the core nested invocation interface. The caller supplies a stable key for each child invocation.

Core rejects active Model invocation cycles. Core keeps cancellation, resource scope, Model Usage, Execution Events, Hooks, and error classification for every leaf call.

Core has no routing, fallback, decoration, cache, or capability-routing policy. Composite Models implement these policies.

A Composite Model can consume one child response without forwarding its Events. It can then call another child or use an unforwarded failure for fallback.

Forwarding a child Event that contributes to output commits the Composite Model to that child. It cannot switch children for that invocation. A later child failure propagates.

## Content and replay

The protocol keeps Reasoning Parts separate from assistant text. These Parts contain provider-returned summaries or explanations. They do not expose hidden chain-of-thought.

The protocol also has normalized Source Parts for URLs and documents. Raw provider source objects do not become Source Part fields.

A Content Part can contain Provider Data. This data has a namespace and version. Core preserves it on the same Part and does not render it as content.

Only the matching provider adapter reads Provider Data during replay. Other adapters ignore it. An unsupported or absent required version produces a Provider Compatibility Interruption. Corrupt validated data is a Defect.

Provider Options are request-scoped. Provider Data is provider-owned replay state. [ADR 0007](0007-store-versioned-data-with-core-messages.md) defines Message Data.

## Model outcomes

A completed refusal or content-filtered response is a successful Model Response. Core commits its assistant Message and Finish Reason.

A `pause` Finish Reason requests another Step in the same Run. It is not a Failure, Interruption, Tool Suspension, or retry.

A content-policy rejection before a completed response is a terminal Model Failure. A valid canonical request that the provider rejects also produces a Model Failure when the request must change.

Rate limits, transport failures, and provider internal failures produce a Provider Unavailable Interruption when the adapter classifies them as retryable. Quota exhaustion uses the same Interruption but does not request an automatic retry.

An unsupported canonical Tool schema or required replay contract produces a Provider Compatibility Interruption. Invalid Model output produces a Model Output Interruption when another sample can succeed.

An adapter translation or decoding bug is a Defect. Unknown Effect AI errors and impossible bridge states are also Defects. Core does not guess their recovery policy.

[ADR 0012](0012-compose-machine-policy-through-typed-hooks.md) defines Execution-local Model retries.

## Structured output and files

Core has no structured-output primitive or Model output schema. An integration can add instructions through Context, validate the response, and define retry policy.

File Parts contain Artifact References, not inline bytes. A Model adapter reads or writes bytes through the Artifact Store. It writes returned bytes before core exposes or commits the File Part.

[ADR 0004](0004-pass-dependencies-through-factories-and-closures.md) defines Artifact Store configuration and missing-store behavior.
