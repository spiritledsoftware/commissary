---
status: accepted
---

# pnpm installs, and Vite+ runs the toolchain

The repository installs its dependencies with pnpm instead of Bun, and Vite+ (`vite-plus`, its CLI `vp`) replaces the
separate tools around them: `vp run` (Vite Task) runs the tasks in place of Turborepo, `vp test` runs Vitest, `vp lint`
and `vp fmt` run Oxlint and Oxfmt, `vp build` and `vp dev` run Vite, and `vp staged` with Vite+'s Git hooks
(`vp config`) replaces Husky and lint-staged. This supersedes ADR 0046's choice of Bun; tsrs stays the typechecker,
Effect-patched as ADR 0047 has it, and tsrslint stays Oxlint's type-aware backend.

**pnpm.** `pnpm-workspace.yaml` holds what the root `package.json` and `bunfig.toml` held for Bun, with comments:
the packages, the catalog, `overrides`, `patchedDependencies` (the Alchemy patch, renamed to pnpm's file name),
`allowBuilds` in place of `trustedDependencies`, and a minimum release age of one day. `pnpm-lock.yaml` was imported
from `bun.lock` through a `yarn.lock` Bun wrote (`pnpm import` reads no `bun.lock`), so every resolved version was
kept. pnpm's store is global and its `node_modules` links into it, as Bun's global store did. `effect-tsgo patch`
moves the installed tsrs binary aside and copies the patched one in, a new file, so it never writes the store's copy.
Alchemy's CLI now runs on Node.js (it hands itself to Bun only when Bun launched it), so `@effect/platform-bun` and the
override that held its `@effect/platform-node-shared` are gone.

**Vite+.** `vp migrate` wrote the root `vite.config.ts` from `.oxlintrc.json` and `.oxfmtrc.jsonc`, added `vite-plus`
to every package, pointed the catalog's `vite` at Vite+'s core and `vitest` at the Vitest it bundles, and rewrote the
test files' `vitest` imports to `vite-plus/test` and the lint plugins' `@oxlint/plugins` to `vite-plus/lint/plugins`.
The packages keep their own `vitest.config.ts`. Vite+ is held at 1.4.0, the last release that bundles Vitest 5.0.x:
three workerd tests still fail on Vitest 5.1 with `@cloudflare/vitest-plugin` 1.8.0 (docs/DEVELOPMENT.md, "Dependency
notes"), the reason Vitest was already held at 5.0.x.

**Type-aware lint.** Vite+ sets `OXLINT_TSGOLINT_PATH` to the `oxlint-tsgolint` it bundles only when the caller has
not set it, so `tools/oxlint.sh` sets it to tsrslint's binary and runs `vp lint`, as it ran `oxlint` before.

**Tasks.** Vite Task records the files each task reads and runs it again when one changes, so the `transit` task and
the per-package `turbo.json` input lists have no counterpart: a change in `packages/contract` re-runs the `typecheck`
of the packages that import it, found by the files tsrs read. `typecheck` and `build` are cached
(`node_modules/.vite/task-cache`, one per worktree). `test` is not: a cached task runs in a cleaned environment, which
would drop the local test budget's `COMMISSARY_TEST_*`, and a package script cannot name variables to keep. Tests and
typechecks run with `--parallel`, since the packages are source-only and wait on nothing of each other's.

## Measurements

On an 8-core Apple Silicon laptop (2026-11-12), one run each:

- **Typecheck**, `pnpm run typecheck` (16 tasks): uncached 5.5 s, all cached 0.7 s.
- **Lint**, `tools/oxlint.sh` through `vp lint` with tsrslint: 6.3 s, peak resident memory 1.7 GB. It reports the same
  diagnostics as `oxlint` 1.91 did, but for two `no-unnecessary-type-assertion` warnings Vite+'s Oxlint 1.89 does not
  report.
- **Install** with a warm store and no `node_modules`, the `prepare` script included: 5.2 s.
- **Tests**, `pnpm run test` (12 packages, two at once): 7 min, all passing.

## Consequences

- The toolchain's versions move together with `vite-plus`: its Oxlint (1.89) and Oxfmt (0.74) are older than the
  standalone ones the repository had (1.91 and 0.76) until Vite+ can move past 1.4.0. One file
  (`apps/web/src/lib/spend.ts`) is formatted differently by 0.74.
- Locally, `pnpm run test` re-runs every package each time, where Turborepo answered an unchanged package from its
  cache. CI ran without a cache before and still does.
- `vp run` starts a package's script in the package's directory with the caller's `PWD`; the workerd projects reset it
  (`tools/vitest/workerd.ts`) so workerd does not warn on every start.
- Git hooks live in `.vite-hooks/`; `vp config` (in `prepare`) installs Vite+'s dispatcher and sets `core.hooksPath`.
  `VP_GIT_HOOKS=0` skips them, as `HUSKY=0` did (Vite+ still honours `HUSKY=0`).
- CI sets up Node.js, pnpm and Vite+ with `voidzero-dev/setup-vp`, whose dependency cache is pnpm's store, keyed by
  `pnpm-lock.yaml`; pnpm checks each package against the lockfile's hash. The jobs that hold deploy credentials still
  neither read nor write it.
- Dependabot updates the `npm` ecosystem, which covers pnpm. It does not move the catalog's `vite` alias of Vite+'s
  core, which moves by hand with `vite-plus`.
- `vp check` is not this repository's check: its type check is Oxlint's (`typeCheck`), which ADR 0046 turned off in
  favour of tsrs. The checks stay `pnpm run typecheck` and `pnpm run lint`.

## Considered Options

- **Keeping Bun and adopting Vite+ alone.** Vite+ supports Bun, but its workspace, catalog and override handling is
  written around pnpm first, and the sibling repository it follows (t3code) runs it on pnpm.
- **Vite+ 1.6 with Vitest 5.1.** It bundles newer Oxlint and Oxfmt, but three workerd tests fail on Vitest 5.1, with
  both the pinned plugin (1.6.0) and its latest release (1.8.0).
- **`vp lint` with its bundled oxlint-tsgolint.** It needs no wrapper, but brings back the second TypeScript (7.0) and
  the higher memory use that ADR 0047 left behind.
- **Turning type-aware linting off**, as t3code does. It would drop `no-unsafe-type-assertion` and the typed
  correctness rules that the `// SAFETY:` comments answer.
- **Caching `test`** through a task in each package's `vite.config.ts`, which can name variables to keep. It would
  move each package's Vitest settings into a new config file, for a cache CI does not use.
