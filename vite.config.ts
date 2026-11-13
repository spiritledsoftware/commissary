// Vite+ (ADR 0049): the format (`fmt`, Oxfmt) and lint (`lint`, Oxlint) settings of the whole repository, and the
// checks of staged files at commit (`staged`). The packages' Vitest settings stay in their own vitest.config.ts, and
// the control panel's Vite settings in apps/web/vite.config.ts. docs/DEVELOPMENT.md, "Lint and format".
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

// Oxlint's type-aware backend: tsrs's `tsrs-lint`, not the oxlint-tsgolint Vite+ bundles (ADR 0050). Oxlint runs the
// executable OXLINT_TSGOLINT_PATH names, and Vite+ fills it in with its own only when unset. Assigned here, not in a
// wrapper or the shell, so every Vite+ entry point that loads this config (`vp lint`, `vp staged`, `vp lint --lsp`)
// gets it, agents and worktrees included, and an inherited (possibly stale) value is replaced.
process.env.OXLINT_TSGOLINT_PATH = fileURLToPath(
  new URL(
    `node_modules/.bin/tsrs-lint${process.platform === "win32" ? ".cmd" : ""}`,
    import.meta.url,
  ),
);

/** The `@commissary/<package>/testing` helpers stay in test files. */
const TESTING_ONLY = {
  regex: "^@commissary/[^/]+/testing$",
  message: 'A package\'s ./testing helpers are for test files only (docs/DEVELOPMENT.md, "Tests").',
};

/** Packages depend on nothing in apps/. */
const NO_APPS = {
  regex: "(^|/)apps/",
  message: "Packages import nothing from apps/*: an app depends on packages, never the reverse.",
};

/** The sandbox's Cloudflare libraries load lazily, behind its provider. */
const SANDBOX_LAZY = {
  regex: "^(@cloudflare/computer|just-bash)(/|$)",
  message:
    "@cloudflare/computer and just-bash stay behind Cloudflare's sandbox provider (packages/tools/src/sandbox/cloudflare/, #222), which loads them lazily.",
};

/** The org-wide state reaches no area. */
const STATE_NO_AREAS = {
  regex: "^@commissary/(models|billing|tools)(/|$)",
  message:
    "The org-wide state imports nothing from an area: an area reaches it through its ControlPlane part (#134, #148).",
};

/** `no-restricted-imports` with these patterns. */
const restrictImports = (...patterns: ReadonlyArray<{ regex: string; message: string }>) =>
  ["error", { patterns }] as const;

export default defineConfig({
  // `vp staged`, run by .vite-hooks/pre-commit: the staged files formatted, then linted (type-aware, through
  // tsrs-lint). The Effect diagnostics surface at pre-push (`pnpm run typecheck`) or in CI (ADR 0047).
  staged: {
    "*": "vp fmt --no-error-on-unmatched-pattern",
    "*.{ts,mts,cts,js,mjs,cjs}": "vp lint --quiet --no-error-on-unmatched-pattern",
  },
  fmt: {
    ignorePatterns: [
      ".repos",
      // Vendored oxlint plugin (tools/oxlint/anti-slop/UPSTREAM.md), kept in its upstream formatting
      "tools/oxlint/anti-slop",
      // Historical Go research notes, kept as written
      "docs/research",
      "node_modules",
      "dist",
      ".alchemy",
      "pnpm-lock.yaml",
      "worker-configuration.d.ts",
      "packages/*/test/fixtures",
      "packages/models/src/registry/catalog",
      // The integrations.sh snapshot, written by `pnpm run toolkits:sync`
      "packages/tools/src/catalog/integrations-sh.json",
      // Its credentials, one source per line, written by the same script
      "packages/tools/src/catalog/integrations-sh-credentials.json",
      // Design decision records written by the impeccable tooling
      ".impeccable",
      // Codex corpus requests are compact on purpose: Go forwards some raw JSON text (tool_use input) verbatim.
      "tools/fixturegen/translator/corpus/codex-*.json",
      // Gemini/Interactions corpus requests are compact on purpose: Go embeds some raw JSON text verbatim.
      "tools/fixturegen/translator/corpus/*-gemini.json",
      "tools/fixturegen/translator/corpus/gemini-*.json",
      "tools/fixturegen/translator/corpus/interactions-interactions.json",
      // Antigravity corpus requests are compact on purpose (raw JSON text embedded verbatim by Go).
      "tools/fixturegen/translator/corpus/antigravity-*.json",
    ],
  },
  lint: {
    options: {
      // Rules that need type information, through tsrs-lint (OXLINT_TSGOLINT_PATH above, ADR 0050).
      typeAware: true,
      // TypeScript's own errors are tsrs's (`pnpm run typecheck`, ADR 0046): one checker, one TypeScript version.
      typeCheck: false,
    },
    plugins: ["typescript", "unicorn", "oxc"],
    jsPlugins: [
      {
        name: "anti-slop",
        specifier: "./tools/oxlint/anti-slop/index.ts",
      },
      {
        name: "anti-slop-effect",
        specifier: "./tools/oxlint/anti-slop/effect/index.ts",
      },
      {
        name: "boundaries",
        specifier: "./tools/oxlint/boundaries/index.ts",
      },
      // Vite+'s own rules (`vite-plus/prefer-vite-plus-imports` below).
      {
        name: "vite-plus",
        specifier: "vite-plus/oxlint-plugin",
      },
    ],
    categories: {
      correctness: "error",
      suspicious: "warn",
    },
    rules: {
      "typescript/no-explicit-any": "error",
      "no-console": "error",
      "no-underscore-dangle": "warn",
      "oxc/no-accumulating-spread": "error",
      "anti-slop/no-array-filter-map": "error",
      "anti-slop/no-reduce-accumulator-copy": "error",
      "anti-slop/no-chained-type-assertions": "error",
      "anti-slop/no-conditional-empty-object-spread": "warn",
      "anti-slop/no-known-value-widening": "error",
      "anti-slop/no-module-mocking": "error",
      "anti-slop/no-object-parameters": "error",
      "anti-slop/no-reflect-apply": "error",
      "anti-slop/no-reflect-get": "error",
      "anti-slop/no-runtime-typeof": "warn",
      "anti-slop/no-shape-in-symbol-names": "error",
      "anti-slop/no-unknown-parameters": "error",
      "anti-slop/no-unknown-returns": "error",
      "anti-slop/no-unknown-type-aliases": "error",
      "anti-slop/no-unsafe-dictionary-type": "error",
      "anti-slop/no-widen-then-assert": "error",
      "anti-slop/require-readable-spacing": "error",
      "anti-slop/require-safety-comment-for-type-assertion": "error",
      "anti-slop-effect/no-manual-effect-error-tag": "error",
      "anti-slop-effect/no-manual-tag-comparison": "error",
      "anti-slop-effect/no-manual-tagged-construction": "error",
      "anti-slop-effect/no-service-constructor-imports": "warn",
      "anti-slop-effect/prefer-effect-match": "error",
      "boundaries/models-imports": "error",
      "boundaries/billing-imports": "error",
      "boundaries/org-scoped-kv": "error",
      "boundaries/tools-imports": "error",
      "no-restricted-imports": restrictImports(TESTING_ONLY),
      // The test files import Vitest through Vite+ (`vite-plus/test`) and the lint plugins its Oxlint API
      // (`vite-plus/lint/plugins`), which match the versions Vite+ bundles (ADR 0049).
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    ignorePatterns: [
      "node_modules",
      "dist",
      ".alchemy",
      ".repos",
      ".worktrees",
      "worker-configuration.d.ts",
      "packages/*/test/fixtures",
      ".agent/**",
      ".agents/**",
      ".claude/**",
      ".codex/**",
      ".continue/**",
      ".cursor/**",
      ".gemini/**",
      ".opencode/**",
      ".pi/**",
      ".roo/**",
      ".windsurf/**",
      "tools/oxlint/anti-slop/**",
    ],
    overrides: [
      {
        files: ["apps/*/test/**", "packages/*/test/**"],
        rules: {
          "anti-slop/require-safety-comment-for-type-assertion": "off",
          "anti-slop/no-chained-type-assertions": "off",
          "anti-slop/no-unsafe-dictionary-type": "off",
          "typescript/no-unsafe-type-assertion": "off",
          "no-restricted-imports": "off",
        },
      },
      {
        files: ["packages/**"],
        rules: { "no-restricted-imports": restrictImports(TESTING_ONLY, SANDBOX_LAZY, NO_APPS) },
      },
      {
        files: ["packages/tools/src/sandbox/cloudflare/**"],
        rules: { "no-restricted-imports": restrictImports(TESTING_ONLY, NO_APPS) },
      },
      {
        files: ["packages/state/src/**"],
        rules: {
          "no-restricted-imports": restrictImports(
            TESTING_ONLY,
            SANDBOX_LAZY,
            NO_APPS,
            STATE_NO_AREAS,
          ),
        },
      },
      {
        files: ["packages/*/test/**"],
        rules: { "no-restricted-imports": restrictImports(NO_APPS) },
      },
    ],
  },
});
