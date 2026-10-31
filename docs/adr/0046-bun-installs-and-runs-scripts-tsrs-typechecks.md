---
status: accepted
---

# Bun installs and runs scripts, tsrs typechecks, Vitest stays on Node.js

The repository installs its dependencies with Bun instead of pnpm, and its scripts run through `bun run`. `bun.lock` replaces `pnpm-lock.yaml`, migrated from it with every resolved version kept. What `pnpm-workspace.yaml` held moved into the root `package.json`: `workspaces` (the packages and the `catalog` that `catalog:` names), `overrides`, `patchedDependencies`, and `trustedDependencies` in place of `allowBuilds`. `bunfig.toml` holds the rest: the isolated linker (pnpm's layout, where a package sees only what it declares), Bun's global store (one copy of each package in Bun's cache, which every checkout and worktree links to) and a minimum release age of one day (pnpm's default). Bun's version is `packageManager`'s, which CI's `setup-bun` reads, pinned again in `mise.toml`. `docs/DEVELOPMENT.md` ("Dependency notes") says why each setting is there, which `pnpm-workspace.yaml` said in comments.

Every `typecheck` script runs `tsrs` instead of `tsc`, and `tsrs` replaces `typescript` in every package. tsrs is a Rust port of TypeScript 7 that takes `tsc`'s flags; it is pinned exactly in the catalog, because its version names the TypeScript release it ports (`0.20.1-ts7.1.0-beta` ports 7.1.0-beta), so an upgrade is a deliberate edit. oxlint keeps its type-aware rules and the Effect diagnostics (`effect-tsgo patch --oxlint`, unchanged) but no longer reports TypeScript's own errors (`options.typeCheck: false`): tsrs is the one TypeScript gate, and two checkers on two TypeScript versions (oxlint-tsgolint is built on 7.0) would report every error twice, or disagree.

Vitest and Vite keep running on Node.js: `bun run` starts a package's binary with the interpreter its first line names, which for them is `node`; so do the catalog sync scripts (`node tools/…`). alchemy's CLI hands itself to Bun when Bun launched it (it reads `npm_execpath`), so `bun run deploy`, `bun run dev` and the smoke test run alchemy on Bun, with `@effect/platform-bun` in the root's devDependencies; it depends on `@effect/platform-node-shared` with a caret, which the root `overrides` hold at `effect`'s version.

The same move was made in two sibling repositories first (cloudpid's ADR-0028 and pi-extensions' ADR 0011), whose measurements this one repeats for this repository.

## Measurements

On an 8-core Apple Silicon laptop (2026-10-31), one run each:

- **Typecheck**, `turbo run typecheck typecheck:root --force` (16 tasks, uncached): `tsc` 33.9 s, tsrs 7.3 s. tsrs reported no errors where `tsc` reported none, and catches an injected one.
- **Install** with a warm cache and no `node_modules`, the `prepare` script included: 2.5 s.

## Consequences

- tsrs is TypeScript 7.1 (a beta, at tsrs 0.20); editors use whatever language server they are set up with (`tsrs --lsp` is one). The `typescript` package is still installed, for commitlint's config loader, which declares it as a peer; nothing checks with it.
- Bun runs the root `prepare` script at every `bun install`, where pnpm skipped it when dependencies were up to date: each install re-patches oxlint (a no-op when already patched) and fast-forwards the reference repositories in `.repos/` (skipped when `CI` is set).
- `trustedDependencies` replaces Bun's default list, so it names every package whose install script runs: `esbuild` and `workerd` (their platform binaries), and `oxlint` and `oxlint-tsgolint`, whose files `effect-tsgo patch` rewrites in place. A trusted or patched package, with its dependencies, stays in the checkout's own `node_modules/.bun` instead of the global store, so patching it does not change the copy other checkouts on the machine link to. `@google/genai`, `protobufjs`, `@mongodb-js/zstd` and `node-liblzma` stay blocked, as `allowBuilds` had them.
- CI caches one `bun pm cache pack` file of the lockfile's packages (keyed by `bun.lock`), which needs no pruning: it never holds a package the lockfile dropped. Bun trusts its cache where pnpm checked each package against the lockfile's hash, so the jobs that hold deploy credentials still neither read nor write it.
- Dependabot updates the `bun` ecosystem instead of `npm`.
- `bun test` is Bun's own test runner, not this repository's tests: the scripts are always `bun run <script>`.

## Considered Options

- **Keeping pnpm and switching only the checker.** tsrs is most of the gain. Bun was chosen for one tool to install, run scripts and pin, as in the sibling repositories.
- **`effect-tsgo tsrs`**, the Effect-patched tsrs that `@effect/tsgo` ships (cloudpid's choice). It adds the Effect language service's diagnostics to the typecheck, which this repository already gets from oxlint; it would mean upgrading `@effect/tsgo` and the oxlint toolchain with it.
- **Keeping `typeCheck: true` in oxlint** as a second checker: redundant once tsrs checks every program, and on another TypeScript version.
- **Bun as Vitest's runtime too.** cloudpid measured its workerd test projects at twice the time under Bun, with a test failing every run; the workerd tests are most of this repository's CI time too.
- **Bun without the global store.** Simpler, but every worktree in `.worktrees/` would copy every package.
