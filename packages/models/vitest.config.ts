// Models' tests, two projects (#135): `models-unit` runs the pure tests (`test/unit/`) in Node.js; `models` runs the rest
// in workerd (@cloudflare/vitest-plugin) against the test Worker (test/worker.ts), whose ControlPlane is the org-wide
// base composed with the Models part. Compatibility settings and module rules as the deployed Worker's
// (alchemy.run.ts, apps/app/vitest.config.ts); the bindings are the ones test/env.d.ts declares, with the Worker tests'
// fixed keys.
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { nodePackageTests } from "../../tools/vitest/node-package.ts";

const unit = nodePackageTests("models-unit");

export default defineConfig({
  test: {
    // CI's shards reach every package's run; a shard may get none of this package's files.
    passWithNoTests: true,
    projects: [
      {
        ...unit,
        test: { ...unit.test, include: ["test/unit/**/*.test.ts"] },
      },
      {
        plugins: [
          cloudflareTest({
            main: "./test/worker.ts",
            miniflare: {
              compatibilityDate: "2026-08-01",
              compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
              // @commissary/translation's tokenizer ranks are `Data` modules (ArrayBuffer), as in the Worker's bundle.
              modulesRules: [{ type: "Data", include: ["**/*.bin"] }],
              durableObjects: {
                CONTROL_PLANE: { className: "ControlPlane", useSQLite: true },
                SESSION_STATE: { className: "SessionState", useSQLite: true },
                PLATFORM: { className: "Platform", useSQLite: true },
              },
              kvNamespaces: ["CACHE"],
              d1Databases: ["USAGE"],
              // A self-hosted stage under test, as the Worker's tests bind it (the harnesses configure Access).
              bindings: {
                ACCESS_TEAM_DOMAIN: "",
                ACCESS_AUD: "",
                PLATFORM_ADMIN_EMAILS: "",
                PLATFORM_ADMIN_SERVICE_TOKENS: "",
                ACCESS_DEV_BYPASS: "true",
                META_MINT_URL: "",
                OWN_HOSTS: "",
                // Fixed test keys (deployed: Alchemy `Random`s, alchemy.run.ts), 64 characters like the minted ones, so
                // tests that configure Access (where shorter keys are refused) can use them too. The previous secrets
                // key lets a test start a ControlPlane whose data key it still wraps.
                AUTH_INDEX_KEY:
                  "commissary-test-auth-index-key-0123456789abcdef0123456789abcdef01234",
                SECRETS_KEY: "commissary-test-secrets-key-0123456789abcdef0123456789abcdef012345",
                SECRETS_KEY_PREVIOUS:
                  "commissary-test-previous-secrets-key-0123456789abcdef012345678901",
              },
            },
          }),
        ],
        test: {
          name: "models",
          include: ["test/**/*.test.ts"],
          exclude: ["test/unit/**"],
          // The first test in each file pays for module transformation inside workerd; keep generous timeouts.
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
