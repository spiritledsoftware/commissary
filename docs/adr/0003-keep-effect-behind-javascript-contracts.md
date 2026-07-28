# Keep Effect behind JavaScript contracts

## JavaScript boundary

Core uses Effect internally. Public core and extension contracts use plain JavaScript values and functions.

Callbacks can return values or `PromiseLike` values. Streams use `AsyncIterable`. Cooperative cancellation uses `AbortSignal`.

Public schemas use Standard Schema and Codec values. Model-visible Tool inputs also provide Standard JSON Schema V1.

Operation contracts declare expected Failures as typed data. Core names unexpected exceptions, rejected Promises, invariant violations, and adapter faults as `Error` Defects. A Defect keeps the original value as its cause. Core does not require one generic `Result` wrapper for callbacks.

## Effect interfaces

Effect AI is the internal Model execution system. Core hides its `Effect`, `Layer`, `Stream`, `LanguageModel`, and `AiError` values behind the canonical Model protocol.

Application Effect interfaces live in `@commissary/effect`. The `@commissary/effect/ai` subpath contains the canonical Model bridge and adapter-author tools.

`EffectSchema.standard(schema)` adapts an Effect Schema to Standard Schema. `EffectSchema.modelInput(schema)` also adds Standard JSON Schema V1. Both helpers keep the inferred Effect Schema type.

`EffectCommissary.agent(agent)` returns an Effect-native Agent Client. Its operations return `Effect`, and `Execution.result` is an Effect value. The adapter uses the core Runtime and does not implement a second Runtime.

Operational errors use the Effect error channel. Declared Failures, Interruptions, suspensions, and successful completion stay in normal result values.

The Effect Stream Adapter at `@commissary/stream/effect` follows [ADR 0010](0010-fence-and-resolve-executions.md) and exposes an Effect `Stream`. Fiber interruption stops only the local wait or stream consumption. It does not abort the durable Run. The host must call `Execution.abort()` explicitly.

Each Execution owns one internal Effect Scope. It acquires each selected Model service at most once. It releases all Execution resources when the Execution ends.

## Packages and platforms

First-party onboarding starts with the plain JavaScript root APIs. A separate Effect example uses `@commissary/effect` and provider `effect` subpaths directly.

Packages are ESM-only and target ES2022. They have no CommonJS build.

V1 supports these targets:

- Node.js 22 and later.
- The current stable Bun.
- The current stable Deno.
- Modern browsers.
- Cloudflare Workers.

Release CI runs the shared conformance suite on each supported server or edge runtime. A Chromium smoke test checks the published browser artifacts. Another platform becomes supported only after CI covers it.

Core uses portable Web APIs. It does not use Node-specific APIs at portable boundaries.
