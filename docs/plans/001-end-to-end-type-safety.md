# Plan 001: Make host types honest from authoring through production packages

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. Touch only the files listed as in scope. If any STOP condition occurs, stop immediately and report. Do not improvise around obstacles. The reviewer maintains `docs/plans/README.md`; do not edit it.
>
> **Drift check (run first)**: `git diff --stat 26e5ffa..HEAD -- package.json turbo.json tsconfig.json packages docs/adr`
> If committed in-scope files changed, compare this plan with the live code and stop on a contract mismatch.
>
> **Working-tree overlay check**: the main worktree at `/home/ianpascoe/src/commissary` contains an approved, uncommitted Runtime modularization that is not in commit `26e5ffa`. Before implementation, verify this command in the main worktree:
>
> `sha256sum packages/core/src/runtime-implementation.ts packages/core/src/runtime/*.ts packages/core/test/runtime/*.ts | sha256sum`
>
> Expected digest: `9bd62e9e34490b8f741444051a6119da4e4adeffe46c13d6a55cc020794651bd  -`
>
> Copy only those Runtime files and directories into the isolated worktree, and delete the isolated worktree's old `packages/core/test/runtime.test.ts`. Do not copy `AGENTS.md`, `.omp/`, or any other main-worktree change. Re-run the digest inside the isolated worktree and require the same value before proceeding.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: none
- **Category**: migration / correctness / dx / tests
- **Planned at**: commit `26e5ffa`, 2026-07-30, plus the approved Runtime overlay identified above

## Why this matters

The current public types preserve many Agent contracts during definition but lose or misstate them at host seams. A client can read one Agent's Run through another Agent's failure type; Tool names are not correlated with Events or durable Tool state; dynamic Tools widen static resume types; durable Tool schemas admit non-JSON values; and `Codec.Encoded` can resolve to `never`. The Effect and Stream adapters also lose interface parity. Package manifests expose source files and do not prove the production declaration graph.

This is a clean pre-release cutover. Remove old names and migrate every caller. Do not add compatibility overloads, aliases, or deprecated paths.

## Current state

- `packages/core/src/commissary.ts:63-77` exposes `submit`, Run-ID-based execution/read/control methods, and an erased `subscribe(HookFragment)` method.
- `packages/core/src/commissary.ts:252-271` asserts untyped Runtime reads to the selected Agent's Failure union without verifying the stored Agent.
- `packages/core/src/runtime.ts:115-120` gives every command the same `SubmitResult`; `:166-169` erases the Agent Failure type from `AbortResult`; `:239-302` stores Tool names independently from Tool inputs, results, and Events.
- `packages/core/src/types.ts:15-29` defines distinct string brands, but no supported decoder. `RunId` does not carry an Agent type.
- `packages/core/src/codec.ts:10` uses `Definition extends Codec<unknown, infer Encoded>`, which fails for ordinary Codecs because `encode` is contravariant.
- `packages/core/src/runtime/protocol-parsing.ts:16-29` accepts any object whose enumerable values look like JSON. A direct runtime probe proved that `Date`, `Map`, and `Set` all return `true`; cycles recurse without a controlled result.
- `packages/core/src/tool.ts:253-315` allows Tool output, Failure, and resume schema outputs outside `JsonValue`, while `packages/core/src/runtime/tools.ts` sends those values through the faulty JSON guard.
- `packages/store-memory/src/index.ts:592-615` exposes one `input` field that changes meaning: it is requested input before effective input exists and effective input afterward. The Store already retains both internally.
- `packages/core/src/hook.ts:50-60` erases the Hook Point from `HookFragment`; Agent-specific static and dynamic Hook authoring is not available.
- `packages/effect/src/index.ts:63-88` omits `redirect`; `packages/stream/src/effect.ts:26-33` accepts only the core `AgentClient`.
- Package manifests point `exports` at `src`; package `tsconfig.json` files emit nothing.
- Typecheck baseline before this migration: `pnpm run typecheck` succeeds for all four packages.

Decisions that must not be reopened:

1. Breaking changes are allowed; no shims.
2. Public client methods are `createRun`, `resumeRun`, `execute`, `readRunSnapshot`, `readResult`, `steer`, `redirect`, `abort`, and `on`.
3. `createRun` saves work; only `execute` advances it.
4. Successful saved commands use `type: "accepted"`. Each method returns only its possible conflicts.
5. Agent-returned Run IDs carry the Agent definition. Decoded stored Run IDs are unbound. Wrong-Agent bound IDs fail at compile time; unbound IDs are checked atomically by Store operations.
6. Wrong-Agent or missing reads return `undefined`; `steer`, `redirect`, and `abort` return `not-active`; resume returns its existing conflict family; execute keeps `ExecutionUnavailableError` with `wrong-agent`.
7. Tool outputs and declared Tool Failures are JSON. Submitted resume values are JSON, then the resume schema may decode them for the callback.
8. Model-requested and Hook-effective Tool inputs are stored as JSON. The Tool input schema may decode effective JSON into a richer handler-only value; never store that decoded value.
9. Public Tool snapshots expose `requestedInput` and optional `effectiveInput` instead of one ambiguous `input`.
10. Terminal Tool Failures are tagged with `type: "tool-failure"`, literal Tool name, Tool Call ID, and JSON `value`.
11. Static Tool Events, results, snapshots, suspensions, and resume items are distributive unions correlated by literal Tool name. Dynamic branches use `dynamic: true` and required `providerId`; static branches use optional `dynamic?: false` and omit `providerId`.
12. Reusable static Hooks stay broadly typed. `Agent.define({ hooks })` adds Agent-specific static Hook authoring. `client.on(point, handler)` adds Agent-specific dynamic Hook authoring.
13. Keep distinct ID types. Export schema-like decoders for adapters. A decoded Run ID is unbound; the client performs the Agent check.
14. The Effect client mirrors core. Effect Stream accepts the Effect client directly.
15. Production builds use `tsc`, unbundled ES2022 ESM, declaration files, source maps, and declaration maps. Publish `dist` and `src`; exports point only to `dist`; no CommonJS.
16. The root stays private. The four packages become publish-ready but remain version `0.0.0`.

## Commands you will need

| Purpose                      | Command                                    | Expected on success         |
| ---------------------------- | ------------------------------------------ | --------------------------- |
| Install in isolated worktree | `pnpm install --frozen-lockfile`           | exit 0                      |
| Core typecheck               | `pnpm --filter @commissary/core typecheck` | exit 0, no errors           |
| Core tests                   | `pnpm --filter @commissary/core test`      | all tests pass              |
| Build                        | `pnpm run build`                           | four packages build, exit 0 |
| Workspace typecheck          | `pnpm run typecheck`                       | four packages pass          |
| Workspace tests              | `pnpm run test`                            | all package tests pass      |
| Format check                 | `pnpm run format:check`                    | exit 0                      |
| Lint                         | `pnpm run lint`                            | exit 0                      |
| Full verification            | `pnpm run verify`                          | exit 0                      |

## Suggested executor toolkit

- Read `skill://coding-standards` before changing TypeScript.
- Use LSP rename/references for exported symbols when the language server is available.
- Consult `.repos/vercel-ai/packages/ai/src/generate-text/tool-execution-events.ts` for distributive static/dynamic Tool event unions.
- Consult `.repos/opencode/packages/opencode/src/session/schema.ts` for branded ID decoders at adapter seams.
- Treat the current Runtime overlay as authoritative; do not restore the monolithic Runtime implementation or test file from commit `26e5ffa`.

## Scope

**In scope**:

- `package.json`, `turbo.json`, `tsconfig.json`, `pnpm-lock.yaml`
- Each `packages/*/package.json`, `packages/*/tsconfig.json`, and new `packages/*/tsconfig.build.json`
- `packages/core/src/index.ts`, `types.ts`, `identity.ts`, `schema.ts`, `codec.ts`, `fragment.ts`, `agent.ts`, `hook.ts`, `tool.ts`, `runtime.ts`, `store.ts`, `commissary.ts`, `protocol.ts`, `runtime-implementation.ts`, and `packages/core/src/runtime/*.ts`
- `packages/core/test/inference.test.ts`, test support, and `packages/core/test/runtime/*.ts`
- `packages/effect/src/*.ts`, `packages/effect/test/*.ts`
- `packages/stream/src/*.ts`, `packages/stream/test/*.ts`
- `packages/store-memory/src/index.ts`, `packages/store-memory/test/*.ts`
- Relevant ADRs under `docs/adr/` only after the implementation and smoke test pass
- New type/build/import contract fixtures under existing package test directories when needed

**Out of scope**:

- `AGENTS.md` and `.omp/` are user-owned changes; never copy, edit, delete, or commit them.
- Reference repositories under `.repos/` are read-only.
- No CommonJS output, bundler, remote package registry, release automation, changelog, compatibility layer, or unrelated runtime behavior change.
- Do not rejoin the split Runtime tests or extracted Runtime modules.

## Git workflow

- Branch: `advisor/001-end-to-end-type-safety`
- Commit logical steps with clear imperative messages.
- Do not push or open a PR.
- Do not merge into the user's branch; the reviewer decides the verdict and the user decides integration.

## Steps

### Step 1: Restore the approved Runtime overlay in the isolated worktree

Perform the overlay copy and checksum procedure from the header. Confirm the old monolithic `packages/core/test/runtime.test.ts` is absent. Confirm all nine `packages/core/src/runtime/*.ts` modules and seven `packages/core/test/runtime/*.ts` files exist. Install dependencies.

**Verify**:

- Overlay digest equals `9bd62e9e34490b8f741444051a6119da4e4adeffe46c13d6a55cc020794651bd`.
- `pnpm --filter @commissary/core typecheck` exits 0.
- `pnpm --filter @commissary/core test` reports 8 files and 66 tests passing before the type migration.

### Step 2: Add honest schema, Codec, JSON, and ID primitives

1. Fix `Codec.Encoded` by inferring the encoded return type structurally, without constraining the Codec value parameter to `unknown`. Add exact `Codec.Value` and `Codec.Encoded` compile tests.
2. Make the Runtime JSON predicate accept only JSON primitives, arrays, and plain objects with `Object.prototype` or `null` prototypes. Reject non-finite numbers, `undefined`, symbol/function/bigint values, class instances, `Date`, `Map`, `Set`, and cycles without recursion failure. Preserve valid shared non-cyclic references.
3. Separate Standard Schema input and output inference helpers. Model Tool input may decode JSON to a richer handler value. Durable Tool output and Failure schema outputs must extend `JsonValue`. Resume command input must be the schema's JSON input type; the resume callback receives its validated output type.
4. Add exported value decoders for each distinct opaque ID type. They accept `unknown`, require a non-empty string, and return the corresponding brand. Keep request IDs as caller-owned strings. Define an Agent-bound Run ID, an unbound decoded Run ID, and an internal any-owner Run ID so that:
   - a Run ID returned by Agent A is not assignable to Agent B;
   - an unbound decoded Run ID is accepted by any Agent client and checked at runtime;
   - Store/Runtime internals can hold heterogeneous Run IDs without widening the public client input.
5. Route core-generated IDs and first-party adapter/provider hydration through the decoders instead of scattered casts where the decoder proves the same fact. Keep any truly semantic adapter cast local with a concise safety comment.

**Verify**: core typecheck and focused inference/JSON tests pass. Add runtime tests proving `Date`, `Map`, `Set`, a class instance, and a cycle are rejected while a valid null-prototype object is accepted.

### Step 3: Deepen Agent and Hook type composition

1. Preserve the Hook Point type in `HookFragment` instead of erasing it.
2. Add Agent-derived Hook types for Tool Events and settlement Failures.
3. Extend `Agent.define` with an optional `hooks` callback. Contextually type its Hook constructors from the already inferred `fragments`; combine returned Hook fragments into the installed Agent without adding a second runtime Hook engine. Reusable standalone `Hook.*` constructors remain broadly typed.
4. Replace bound-client `subscribe` with `on(point, handler)`. Construct the Hook definition internally and return the idempotent unsubscribe function. Ensure `HookPoints.onExecutionEvent` and `onSettlement` specialize to Agent Events and Agent results. Other points retain their canonical core types unless a Tool-specific mapping can be derived honestly.
5. Add positive and negative compile contracts: exact static and dynamic handler inference; incompatible event/failure payloads rejected; notification handlers still return only `undefined`.

**Verify**: core inference tests and Hook behavior tests pass.

### Step 4: Correlate Tool contracts through events and durable state

1. Introduce distributive type helpers over `Agent.Tools<Definition>` for static Tool identity, Event, input, output, Failure, suspension, and resume item types. Do not flatten Tool name and payload into independent unions.
2. Add explicit dynamic branches with `dynamic: true`, `providerId: string`, open Tool name, and honest `unknown`/`JsonValue` values. Static branches use `dynamic?: false`; callers need not write `dynamic: false`.
3. Change Tool execution Events (`tool-started`, `tool-event`, `tool-suspended`, `tool-finished`), public Tool snapshots, public suspensions, and resume items to correlated static/dynamic unions.
4. Replace snapshot `input` with `requestedInput` and optional `effectiveInput`. Update the Thread Store contract and memory Store projection. Requested input is Model/delegation JSON. Effective input is the one-time Hook result, still JSON.
5. Change Tool execution order only as needed to preserve the intended invariant: run the one-time input Hook, validate/decode the resulting JSON, persist the JSON effective input after successful validation, and pass only the decoded value to the handler. On recovery, do not repeat the Hook; validate/decode the stored effective JSON again.
6. Keep submitted resume input as JSON in the command and Store. Validate it before acceptance, store the submitted JSON rather than the decoded value, and decode it again for the resume callback.
7. Wrap terminal Tool Failure values in a JSON object containing `type: "tool-failure"`, exact Tool name, Tool Call ID, and `value`. Derive the Agent Failure union from correlated static Tools plus the dynamic unknown branch, Model Failure, and Hook-blocked Failure.
8. Update Runtime, Hook transformations, Event delivery, Store contracts, Memory Store, stream types, and all tests together. Preserve operation ordering, generated ID order, Hook order, Event ordering/coalescing, and reverse Model Session close order outside the explicitly changed input persistence and public shapes.

**Verify**: core typecheck and all Runtime tests pass. Compile tests must prove name-based narrowing, reject crossed name/payload pairs, keep static resume input strict in the presence of a dynamic provider, distinguish requested/effective input, and expose the tagged terminal Tool Failure.

### Step 5: Replace the bound Agent client interface and enforce Agent authority

1. Replace public `submit` with `createRun` and `resumeRun`. Keep Runtime/Store implementation seams private where useful; do not retain public aliases.
2. `createRun` accepts start fields without a `type` property and returns only accepted, Branch conflict, or Run conflict. `resumeRun` accepts resume fields without a `type` property and returns only accepted, Tool resume conflict, or Tool resume request conflict.
3. Reuse `type: "accepted"` for successful create, resume, steer, and redirect results. Preserve `admitted` semantics.
4. Bind successful create/resume Run IDs to the Agent definition. Public execution, read, and control methods accept either the correct bound Run ID or an unbound decoded Run ID, never another Agent's bound Run ID.
5. Add expected Agent identity to Store operations that read or mutate an existing Run. Perform the check as part of the same Store operation. Wrong or missing Agent behavior is fixed by the approved contract:
   - reads return `undefined`;
   - steer, redirect, and abort return `not-active`;
   - resume returns its current Tool resume conflict family;
   - execute reports `ExecutionUnavailableError` with `wrong-agent`.
6. Keep result-only reads cheap: change the Store result-read return shape to include the stored `AgentReference` beside the result, rather than building a full Run snapshot.
7. Make `AbortResult` and all bound reads preserve the Agent Failure type.
8. Migrate every core caller and public-interface test. No old `submit`, `subscribe`, `StartRunCommand`, broad `SubmitResult`, or stale method call remains exported or used.

**Verify**: core typecheck and tests pass. Add compile rejection for passing Agent A's returned Run ID to Agent B. Add behavior tests for unbound correct-Agent reads/controls and every approved wrong-Agent result.

### Step 6: Restore Effect and Stream interface parity

1. Mirror every core Agent client method and result type in `EffectAgentClient`, including `createRun`, `resumeRun`, `redirect`, typed reads, typed abort, and `on`.
2. Preserve the plain JavaScript core as the only Runtime implementation.
3. Make `@commissary/stream/effect` accept `EffectAgentClient<Definition>` directly. Avoid a dependency cycle; a structural narrow interface is acceptable if it preserves exact Agent types and does not copy the Runtime.
4. Preserve correlated static/dynamic Events and tagged Failures through JavaScript Stream and Effect Stream.
5. Add adapter compile contracts with one Agent containing two static Tools, distinct Events/Failures, a suspension, a dynamic provider, and an Effect requirement. Test positive inference and rejected wrong commands/Run IDs.

**Verify**: Effect and Stream package typechecks/tests pass.

### Step 7: Add production package builds

1. Set the shared production target to ES2022 with the Web-standard libraries needed by portable code. Ensure package build configs do not rely on Node-only globals in portable source.
2. Add `tsconfig.build.json` to all four packages. Include only `src`; set `rootDir`, `outDir: dist`, `noEmit: false`, `declaration`, `declarationMap`, and `sourceMap`. Emit unbundled ESM.
3. Add package `build` scripts and root `build: turbo build`. Add Turbo build outputs and dependency ordering so core builds before dependent packages.
4. Keep root `private: true`. Remove `private` from the four packages, keep `0.0.0`, add `publishConfig.access: public`, and include both `dist` and `src` in `files`.
5. Point all package root/subpath exports to typed `dist` entries. Use `{ "types": ..., "import": ... }`. Do not export arbitrary source paths and do not add CommonJS.
6. Make typecheck/test tasks consume dependency builds through those production exports. Avoid stale-dist success by cleaning or rebuilding deterministically within the build task.
7. Update inter-package and subpath contract tests to import package names where they test host behavior. Keep source-relative imports only for private implementation tests.

**Verify**:

- `pnpm run build` creates JavaScript, `.d.ts`, `.js.map`, and `.d.ts.map` files for each public entry.
- `pnpm run typecheck` proves all four packages consume dependency `dist` exports.
- A built-package import check inside the repository imports every public root/subpath with Node and Bun and exits 0.
- `pnpm pack --dry-run` for each package lists `dist` and `src`, and does not list tests or unrelated workspace files.

### Step 8: Complete host compile contracts and migrate all callers

Build one host-shaped compile fixture per relevant package. Cover ordinary authoring without explicit generics, casts, `as const`, or `satisfies` where ADR 0016 promises it. Include:

- Tool/Agent value inference;
- `Codec.Value` and `Codec.Encoded`;
- create and resume result narrowing;
- wrong static Tool name/input rejection, including with a dynamic provider installed;
- Agent-bound and unbound Run IDs;
- typed execution Events, snapshots, terminal Tool Failures, suspensions, and abort results;
- Agent-specific static Hooks and `client.on`;
- Effect requirements and full client parity;
- JavaScript and Effect Stream output types;
- production package root and subpath imports.

Use `expectTypeOf` for exact positive contracts and `@ts-expect-error` for realistic rejected host calls. Tests must compile through public package entry points where possible. Remove every obsolete old-interface test helper.

**Verify**: all package typechecks and tests pass with the new compile contracts.

### Step 9: Smoke the working system, then update decisions and clean up

Run the built packages through the existing end-to-end Runtime scenario: Memory Thread Store, one Model, one Agent, create a Run, execute it, and observe the completed response. Extend it to read the typed result through an unbound decoded Run ID. Expected output includes `completed:smoke-ok`.

Only after that smoke passes:

1. Update the relevant ADRs to describe the final names and semantics: command methods/admission, Agent-bound Runs, Agent-specific Hooks, JSON Tool durability, static/dynamic correlation, and production package output. Do not create unrelated documentation.
2. Remove obsolete exports, aliases, stale helpers, old tests, and temporary build/import fixtures that are not permanent contract tests.
3. Run the formatter, lint, build, typecheck, tests, package import checks, pack dry-runs, and smoke scenario again.

**Verify**: `pnpm run verify` exits 0; built-package import checks and the Runtime smoke scenario exit 0.

## Test plan

Tests must defend observable contracts and plausible regressions:

- JSON predicate: valid nested/null-prototype JSON, non-finite numbers, undefined children, class instances, Date/Map/Set, and cycles.
- Codec extractor: non-unknown Value and narrow Encoded types.
- Client commands: exact result variants, accepted idempotent replay, and no old method names.
- Agent Run safety: compile-time cross-Agent rejection; runtime unbound correct/wrong Agent behavior for reads and every control method.
- Tool correlation: two static Tools with distinct names, inputs, outputs, Failures, Events, and suspensions; dynamic provider installed simultaneously.
- Tool persistence: requested input, Hook-effective JSON, decoded rich handler input, recovery without repeating the Hook, JSON resume storage and callback decoding.
- Tagged Tool Failure: durable value and bound host type.
- Hooks: reusable broad static Hook, Agent-specific static Hook, Agent-specific dynamic Hook, unsubscribe idempotency.
- Adapters: complete core/Effect method parity and both Stream variants.
- Builds: every declared export resolves from `dist`; packed file lists contain `dist` and `src` only as intended.

Use existing behavior tests in `packages/core/test/runtime/` as patterns. Do not test source text, cast counts, or incidental implementation structure.

## Done criteria

- [ ] The approved Runtime overlay is preserved; the monolithic Runtime/test files are not restored.
- [ ] No public compatibility alias for `submit` or `subscribe` remains.
- [ ] All agreed host interface and storage contracts are implemented.
- [ ] Every package builds ES2022 ESM JavaScript and declarations from `src` to `dist`.
- [ ] Package exports point to `dist`; packed packages include both `dist` and `src`.
- [ ] Cross-Agent Run misuse is rejected by types for bound IDs and safely rejected at runtime for unbound IDs.
- [ ] Non-JSON durable values and invalid object prototypes/cycles are rejected.
- [ ] Static Tool names remain correlated with payloads even with dynamic Tools installed.
- [ ] Core, Effect, Stream, and Memory Store callers use the clean new interface.
- [ ] `pnpm run verify` exits 0.
- [ ] Built-package import checks pass under Node and Bun.
- [ ] Package pack dry-runs contain only intended production/source files.
- [ ] Runtime smoke output is `completed:smoke-ok`.
- [ ] Only in-scope files are changed; `AGENTS.md`, `.omp/`, and `.repos/` are untouched.

## STOP conditions

Stop and report instead of improvising if:

- The main Runtime overlay digest differs before copying, or the overlay cannot be accessed from the isolated worktree.
- A decision above cannot be represented without exposing private Runtime modules as public exports.
- Agent checks cannot be performed atomically at the Store seam without a storage-contract change described here.
- Correct Tool input recovery would require rerunning the one-time Hook.
- TypeScript cannot preserve static Tool narrowing in the presence of the explicit `dynamic: true` branch.
- ES2022 unbundled ESM cannot load one of the declared public subpaths under current Node and Bun.
- An in-scope verification fails twice after a reasonable correction.
- The work appears to require editing user-owned `AGENTS.md`, `.omp/`, or read-only `.repos/` content.

## Maintenance notes

- Keep durable JSON types separate from handler-only decoded values. A future rich Tool business-output feature needs an explicit Codec/projection design; do not weaken `JsonValue` to add it.
- New Tool observability surfaces must derive from the same distributive static/dynamic mapping so name/payload correlation cannot drift.
- New Agent client methods that accept unbound Run IDs must carry expected Agent identity into the atomic Store operation.
- New package subpaths need matching `types` and `import` production exports plus built import coverage.
- Reviewers should inspect public declaration output, not only source inference.
