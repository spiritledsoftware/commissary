# Own the provider-neutral Model protocol

Commissary owns one plain-data Model Request, Model Message, Content Part, Message Data, Model Event, and Model Response protocol; Model adapters translate provider SDK and Effect AI values at the seam, and Machine-relevant behavior is represented by core semantic events rather than provider metadata. Provider adapters expose typed constructors for their namespaced Provider Options, which core forwards opaquely; raw string-keyed option bags and global module augmentation are excluded, while file-like durable content uses Artifact References that storage adapters own and Model adapters materialize transiently. `Runtime.admit` and `Runtime.steer` accept the canonical Model Message without Agent input schemas, and completed Runs return a Model Response without Agent output contracts; application conversion and output validation remain with hosts or reusable integrations.

The built-in Model runtime translates the canonical protocol to and from Effect AI. Official provider integrations supply Effect AI provider implementations internally while exposing only pure-JavaScript configuration and opaque Model contributions; a provider's Effect AI service is an implementation detail, not the public Model contract.

Each official provider integration is packaged independently from core and depends only on the provider-specific Effect AI package it needs. Core depends on Effect AI's provider-neutral language-model interfaces but does not bundle OpenAI, Anthropic, Codex OAuth, or other provider implementations.

Provider-integration authors use Effect AI directly and use `@commissary/effect/ai` only for the Commissary-specific canonical-protocol bridge and opaque Model contribution. Ordinary provider packages may depend on that subpath internally, but application code using their pure-JavaScript constructors does not import Effect-facing interfaces.

`@commissary/effect/ai` accepts Effect AI `Model` values rather than anonymous LanguageModel Layers so provider and model identity are always available for diagnostics and compatibility. Custom Effect AI authors wrap their LanguageModel Layer with Effect AI's `Model.make`, while custom vanilla-JavaScript implementations continue to use core `Model.define`.

Core retains `Model.define` as the advanced pure-JavaScript implementation seam for host test doubles, local Models, and providers not implemented through Effect AI. Official provider integrations use Effect AI, but tests can execute the real Machine and canonical protocol without network access or an Effect-facing application interface.

The canonical protocol includes a Reasoning Part and corresponding streaming events for provider-returned reasoning summaries or explanations. Core preserves Reasoning Parts separately from assistant text in durable Model Messages and replays them through compatible Model adapters; hosts decide whether and how to display them, and core makes no claim that they expose hidden chain-of-thought.

The canonical protocol also includes a normalized Source Part for provider-returned URL and document citations. Source Parts remain ordered separately from text and reasoning, are preserved in durable Model Messages, and expose only provider-neutral source fields; provider-specific replay state may use Provider Data, but raw provider source objects do not become normalized Source Part fields.

A provider-completed refusal or content-filtered response remains a successful Model Response. Its provider-neutral Finish Reason and any refusal explanation are preserved as model-visible assistant content, the Message is committed to history, and the Run finishes normally; a refusal is not a Failure, Interruption, or Defect.

A `pause` Finish Reason is provider-requested continuation rather than a completed Run or retryable error. The Machine commits the returned assistant Message and advances to another Model invocation in the same Run, subject to ordinary Step and stopping policy.

A content-policy rejection that occurs before the provider returns a Model Response instead becomes a terminal provider-neutral Model Failure. The failure preserves safe structured diagnostics without exposing provider SDK errors; retrying requires changed input, Agent composition, or Branch history rather than re-executing the unchanged Run.

Provider rejection of an otherwise valid canonical Model Request for a context limit, unsupported option, or provider-side validation also produces a terminal Model Failure with provider-neutral diagnostics. By contrast, an adapter that mistranslates the canonical request into a malformed provider payload has violated its contract and produces a Defect.

When a provider adapter declares that it cannot translate an otherwise valid canonical Tool or structured-output schema because the provider lacks the required capability, execution ends with a Provider Compatibility Interruption. The host may select a compatible provider or install compatible Agent composition and explicitly execute the same Run again; a declared capability mismatch is neither a Model Failure nor a Defect.

A Model adapter's declared invalid-output or structured-output error produces a Model Output Interruption when another sample may succeed. Core preserves provider-neutral diagnostics and usage but commits no malformed Model Response. An adapter implementation that cannot decode a valid provider response remains a Defect.

Each Content Part may carry optional Provider Data: a namespaced, versioned payload owned by one provider integration. Core preserves Provider Data with that exact Part in durable Model Messages but never renders it as content or interprets it. Only the matching provider adapter reads it when translating replay, allowing signatures, continuation tokens, and similar provider-private state to remain bound to the Part they authenticate without leaking into another provider's prompt. Provider Data is distinct from message-scoped, model-visible Message Data and request-scoped Provider Options.

An adapter that recognizes Provider Data but declares its version unsupported, or requires Provider Data that is absent, ends the Execution Attempt with a Provider Compatibility Interruption. It must not silently omit required replay state. Provider Data owned by another adapter is ignored, while a previously validated payload that is now malformed indicates corruption or an invariant violation and is a Defect.

File Parts contain Artifact References rather than inline bytes. The host supplies an Artifact Store independently from its Thread Store; one storage adapter may back both contracts with the same database or filesystem, but core never silently stores blobs in Message Entries. An Effect AI-backed Model persists returned file bytes through the Artifact Store before exposing or committing the File Part.

If a request needs an Artifact Reference or a Model returns file bytes while no Artifact Store is configured, the Execution Attempt ends with an Artifact Storage Required Interruption. Core preflights the dependency when the need is knowable; if output creates the need only after invocation, core preserves incurred usage but commits no partial Model Response or inline bytes.
