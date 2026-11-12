# anti-slop provenance

- Source: https://github.com/dmmulroy/anti-slop
- Commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` (`Merge pull request #36 from K-Mistele/contrib/effect-tag-match-rules`), copied from
  `skills/install-anti-slop/assets/anti-slop` with its `scripts/install.mjs` on 2026-10-10.
- Installed entry points: `index.ts` (generic rules), `effect/index.ts` (Effect rules), registered in `vite.config.ts`'s
  `lint.jsPlugins`.
- Dependencies: `vite-plus/lint/plugins`, the plugin API of the Oxlint Vite+ bundles (in place of `@oxlint/plugins`,
  ADR 0049).
- Local deviations: the rules import `vite-plus/lint/plugins` instead of `@oxlint/plugins`; `no-module-mocking` also
  takes `vi` imported from `vite-plus/test` (Vite+'s re-export of Vitest). This copy is owned by this repository; edit
  rules here and record changes in this file.
