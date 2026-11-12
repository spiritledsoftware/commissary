---
status: accepted, amends ADR-0047 and ADR-0049 (the type-aware backend)
---

# tsrs-lint is Oxlint's type-aware backend

tsrs now ships its own Oxlint backend: the `tsrs` package has a second bin, `tsrs-lint` (`tsrs --lint`), which Oxlint
runs the way it runs tsgolint (oxc-project/tsrs#378). It replaces tsrslint (`@maschwenk/tsrslint`), the stopgap ADR
0047 chose until this landed. `tools/oxlint.sh` points `OXLINT_TSGOLINT_PATH` at `node_modules/.bin/tsrs-lint` and
runs `vp lint`, and `@maschwenk/tsrslint` is gone.

The wrapper stays: Vite+ still sets `OXLINT_TSGOLINT_PATH` to the `oxlint-tsgolint` it bundles when the caller has not,
and Oxlint would look for a bin named `tsgolint` anyway.

## Consequences

- The type-aware rules run on the same tsrs, and so the same TypeScript, as the typecheck, and its version moves with
  the catalog's `tsrs` pin; there is no second package to keep in step. The installed tsrs is Effect-patched (ADR
  0047), but the lint run reports no Effect diagnostics: they stay in `pnpm run typecheck`.
- tsrs ships binaries for macOS (arm64, x64), Windows (x64, arm64) and Linux (glibc and musl, x64 and arm64), so
  `pnpm run lint` and the Git hooks now run everywhere `pnpm install` does, not only on Apple Silicon and glibc Linux.
- In an editor, set `OXLINT_TSGOLINT_PATH` to `node_modules/.bin/tsrs-lint`.
- Findings matched tsrslint 0.1.6's over the whole repository (tsrs 0.22.0-ts7.1.0-beta, 2026-11-12), but for one
  more `no-unnecessary-type-assertion` warning and a few `no-unsafe-type-assertion` messages that elide their types
  differently. Run time was the same, 5.7 s against 5.8 s back to back.
