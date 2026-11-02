---
status: accepted
---

# tsrslint runs oxlint's type-aware rules, and the Effect diagnostics move into the typecheck

oxlint's type-aware backend is tsrslint (`@maschwenk/tsrslint`) instead of oxlint-tsgolint. tsrslint is a port of tsgolint's rules to Rust on tsrs. oxlint runs the backend that `OXLINT_TSGOLINT_PATH` names, so `bun run lint` and lint-staged start oxlint through `tools/oxlint.sh`, which points the variable at the binary `tsrslint-path` prints. This is a stopgap until tsrs ships a backend of its own (oxc-project/tsrs#378). When it does, `oxlint` will find that backend in `node_modules/.bin`, and `@maschwenk/tsrslint` and the wrapper go away.

The Effect language service's diagnostics move from oxlint to the typecheck. `effect-tsgo patch --oxlint` worked by rewriting the Go tsgolint binary, which no longer runs, so the root `prepare` script runs `effect-tsgo patch --no-typescript --tsrs` instead. That patches the installed tsrs, and every program's `typecheck` then reports the Effect diagnostics. The plugin's settings live in `tsconfig.base.json`. They are the rule defaults, which are `@effect/tsgo`'s recommended preset, plus three rules that oxlint also ran because they sit in its `correctness` and `suspicious` categories: `anyUnknownInErrorContext` and `unsafeEffectTypeAssertion` as errors, and `strictEffectProvide` as a warning. Errors fail the typecheck. Warnings and suggestions are printed but do not change the exit code (`ignoreEffectWarningsInTscExitCode`). This amends ADR 0046, where oxlint kept the Effect diagnostics and `effect-tsgo tsrs` was a rejected option.

## Measurements

On an 8-core Apple Silicon laptop (2026-11-02), one run each:

- **Lint**, oxlint 1.87 over the repository with the Effect preset left out of both runs: oxlint-tsgolint 7.0.2004 took 20.5 s with a peak of 1.75 GB; tsrslint 0.1.6 took 14.3 s with a peak of 1.27 GB. With its Effect rules, the patched tsgolint peaked at 2.5 GB. Both backends reported the same 3,238 diagnostics. Seven `no-unsafe-type-assertion` messages print their types differently because tsrslint checks with TypeScript 7.1 and tsgolint with 7.0.
- **Typecheck**, `turbo run typecheck typecheck:root --force` with the patched tsrs: 5.5 s. The Effect diagnostics matched the 3,002 that oxlint reported, apart from three `multipleCatchTag` reports that point at a different line of the same span. Rules oxlint ran at `warn` but that default to suggestions, such as `schemaNumber` and `schemaClassMissingBrand`, are printed as suggestions.

## Consequences

- One TypeScript version, 7.1, now backs the typecheck, the type-aware lint rules and the Effect diagnostics. oxlint no longer has a copy of TypeScript 7.0 inside it.
- oxlint and oxfmt are no longer patched, so their versions no longer have to be ones `@effect/tsgo` supports. `@effect/tsgo` and tsrs still move together: each `@effect/tsgo` release patches a fixed list of tsrs versions (0.63.0 patches `0.20.1-ts7.1.0-beta`).
- `trustedDependencies` names `tsrs`, which `effect-tsgo patch` rewrites, in place of `oxlint` and `oxlint-tsgolint`. A trusted package stays in the checkout's own `node_modules/.bun`, so the patch never touches the copy that other checkouts link to in Bun's global store.
- `bun run typecheck` prints the Effect warnings and suggestions, about 3,000 of them, which `bun run lint` used to print.
- tsrslint ships binaries only for macOS arm64 and glibc Linux on x64 and arm64. CI and Apple Silicon Macs are covered; Intel Macs, Windows and musl Linux cannot run `bun run lint`.
- An editor's oxlint extension finds no `tsgolint` in `node_modules/.bin`. To run type-aware rules there, set `OXLINT_TSGOLINT_PATH` to the output of `bunx tsrslint-path`. The Effect diagnostics appear in an editor only if it uses the patched tsrs (`tsrs --lsp`) as its language server.

## Considered Options

- **Keeping oxlint-tsgolint until tsrs#378 lands.** It keeps the Effect rules in lint, but it also keeps a second copy of TypeScript (7.0) and the larger memory use.
- **Running `effect-tsgo diagnostics` over each program as a separate step.** It reproduces oxlint's Effect diagnostics, but it checks every program a second time with TypeScript-Go 7.0. That took about 18 s in parallel, which is more than the switch saves.
- **Dropping the Effect diagnostics until tsrs#378 lands.** This would lose the error-level rules, such as `floatingEffect`, `missingReturnYieldStar` and `missingStarInYieldEffectGen`.
- **`effect-tsgo tsrs` in each `typecheck` script instead of `patch --tsrs`.** It leaves `node_modules` untouched, but every package would need `@effect/tsgo`, and an editor running `tsrs --lsp` would get no Effect diagnostics.
