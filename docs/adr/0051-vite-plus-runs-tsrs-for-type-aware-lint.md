---
status: accepted, supersedes ADR-0050; amends ADR-0049 (Vite+ moves to 1.7 with Vitest held at 5.0.x by overrides)
---

# Vite+ runs tsrs for type-aware lint

Vite+ 1.7 makes tsrs Oxlint's type-aware backend: `vite-plus` depends on `tsrs` itself and points
`OXLINT_TSGOLINT_PATH` at that package's `tsrs-lint` whenever the caller has not set it (oxc.rs, "Faster type-aware
linting with tsrs", 2026-11-17). The root `vite.config.ts` no longer assigns the variable: every Vite+ entry point that
lints (`vp lint`, `vp staged`, `vp lint --lsp`) runs the tsrs bundled with Vite+.

## Versions

- `vite-plus` 1.7.0 (Oxlint 1.94, Oxfmt 0.79), the catalog's `vite` at its core (`@voidzero-dev/vite-plus-core`
  8.3.8000, a new version scheme).
- The root `tsrs`, the typecheck, at 0.25.0-ts7.1.0-beta, the newest `@effect/tsgo` 0.70.0 patches. Vite+ pins its own,
  `7.1.0-beta.tsrs2`, a tsrs release under a new version scheme; both port the same TypeScript commit
  (`UPSTREAM.json`, 3e92363). The lint run is not Effect-patched, which costs nothing: ADR 0050 already left the
  Effect diagnostics to `pnpm run typecheck`.
- Vitest stays at 5.0.5. Vite+ 1.7 depends on Vitest 5.1.0, and the three workerd tests that held Vite+ at 1.4.0 still
  fail on 5.1, with `@cloudflare/vitest-plugin` 1.8.3 and 1.8.4 alike. `pnpm-workspace.yaml`'s `overrides` hold
  `vitest` and the `@vitest/*` packages Vite+ and Vitest depend on at 5.0.5; the full suite and smoke pass on it, with
  `@cloudflare/vitest-plugin` still at 1.6.0.

## Measurements

Over the whole repository on an Apple Silicon laptop (2026-11-18), warm: `vp lint` took 3.5 s to 4.4 s, against 6.7 s
with ADR 0050's `tsrs-lint` 0.22. Errors stayed at zero. Oxlint 1.94 reports 47 more warnings than 1.89, nearly all
`no-unnecessary-type-assertion`, whose message now also covers type arguments a generic call could infer; they come
from the newer Oxlint and tsrs, not the backend switch (pointing 1.94 at the root tsrs 0.25 reports the same count).

## Consequences

- No repository code selects the backend. An inherited `OXLINT_TSGOLINT_PATH` still wins over Vite+'s, so leave it
  unset; an editor whose Oxlint integration is `vp lint --lsp` needs nothing.
- Two tsrs builds are installed, Vite+'s and the root's. They move apart when one is upgraded without the other; keep
  them on the same TypeScript commit, and move the root's to Vite+'s version once `@effect/tsgo` patches it.
- The Vitest overrides go when the workerd tests pass on Vitest 5.1 (docs/DEVELOPMENT.md, "Dependency notes"); until
  then Dependabot ignores `vitest` 5.1 and later, but not `vite-plus`.

## Considered Options

- **Staying on Vite+ 1.4 with `vite.config.ts` selecting the backend** (ADR 0050). It works, but holds Oxlint and Oxfmt
  back and keeps a workaround that only exists because Vite+ preferred tsgolint.
- **Vite+ 1.7 with Vitest 5.1.** Three workerd tests fail on it (above).
- **The root `tsrs` at `7.1.0-beta.tsrs2`**, one tsrs for both. `@effect/tsgo` 0.70.0 does not patch it, so the
  typecheck would lose the Effect diagnostics (ADR 0047).
