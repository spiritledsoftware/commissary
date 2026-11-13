---
status: accepted, amends ADR-0047 and ADR-0049 (the type-aware backend); amended below (`vite.config.ts` selects the backend)
---

# tsrs-lint is Oxlint's type-aware backend

tsrs now ships its own Oxlint backend: the `tsrs` package has a second bin, `tsrs-lint` (`tsrs --lint`), which Oxlint
runs the way it runs tsgolint (oxc-project/tsrs#378). It replaces tsrslint (`@maschwenk/tsrslint`), the stopgap ADR
0047 chose until this landed. `tools/oxlint.sh` points `OXLINT_TSGOLINT_PATH` at `node_modules/.bin/tsrs-lint` and
runs `vp lint`, and `@maschwenk/tsrslint` is gone.

## Measurements

Over the whole repository on an Apple Silicon laptop (tsrs 0.22.0-ts7.1.0-beta, 2026-11-12), back to back: tsrs-lint
reported the same findings as tsrslint 0.1.6, but for one more `no-unnecessary-type-assertion` warning and a few
`no-unsafe-type-assertion` messages that elide their types differently. Run time was the same, 5.7 s against 5.8 s.

## Consequences

- The type-aware rules run on the same tsrs, and so the same TypeScript, as the typecheck, and move with the catalog's
  `tsrs` pin; there is no second package to keep in step. The installed tsrs is Effect-patched (ADR 0047), but the
  lint run reports no Effect diagnostics: they stay in `pnpm run typecheck`.
- tsrs ships binaries for macOS (arm64, x64), Linux (glibc and musl, x64 and arm64) and Windows x64, so on macOS and
  Linux `pnpm run lint` and the Git hooks no longer need Apple Silicon or glibc. `tools/oxlint.sh` is a Bash script,
  so on Windows they still need a POSIX shell such as WSL or Git Bash.
- In an editor, set `OXLINT_TSGOLINT_PATH` to the checkout's absolute `node_modules/.bin/tsrs-lint` (amended below:
  not needed for `vp lint --lsp`).

## Considered Options

- **Keeping tsrslint.** It works, but it is a third-party port that has to track tsrs on its own, and a second
  package in the toolchain group.
- **Dropping `tools/oxlint.sh`.** Vite+ sets `OXLINT_TSGOLINT_PATH` to the `oxlint-tsgolint` it bundles when the
  caller has not, so bare `vp lint` would run tsgolint, not tsrs-lint. The wrapper stays until Vite+ can be told
  which backend to run. (Superseded by the amendment below.)

## Amendment: `vite.config.ts` selects the backend

`tools/oxlint.sh` reached only callers that went through it. Bare `vp lint`, which agents run, and the `vp lint --lsp`
language server an editor or agent harness starts, ran on the bundled `oxlint-tsgolint`: the same findings on a
different TypeScript, and slower. Oxlint has no setting that selects its backend (oxc-project/tsrs#378 is still open),
but every Vite+ entry point that lints loads the root `vite.config.ts` before it starts Oxlint, and the variable the
config sets reaches it. So the config now assigns `OXLINT_TSGOLINT_PATH` to its own checkout's
`node_modules/.bin/tsrs-lint` (`tsrs-lint.cmd` on Windows, pnpm's shim there; untried) and the wrapper is gone:
`pnpm run lint` and `vp staged` run `vp lint`. `import.meta.url` still names the original file after Vite bundles the
config, so a worktree uses its own `node_modules`. The assignment replaces an inherited value instead of defaulting it
(`??=`), so a stale path from another checkout or an older layout cannot win; to compare backends, run `oxlint`
directly with the variable set. Process sampling showed `tsrs-lint headless`, and no `tsgolint`, under `vp lint` with
the variable unset and with it naming a missing file. Running the type-aware rules on Windows no longer needs a POSIX
shell, and an editor needs no `OXLINT_TSGOLINT_PATH` of its own if its Oxlint integration is `vp lint --lsp`.
