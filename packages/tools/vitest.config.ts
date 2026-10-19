// Tools' tests, two projects like Models': `tools-unit` runs the pure tests (`test/unit/`) in Node.js; `tools` runs the rest
// in workerd (@cloudflare/vitest-plugin) against the test Worker (test/worker.ts), whose ControlPlane is the org-wide
// base composed with the Tools part only. Compatibility settings as the deployed Worker's (alchemy.run.ts); the bindings
// are the ones test/env.d.ts declares, with the Worker tests' fixed keys.
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { nodePackageTests } from "../../tools/vitest/node-package.ts";

const unit = nodePackageTests("tools-unit");

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
              durableObjects: {
                CONTROL_PLANE: { className: "ControlPlane", useSQLite: true },
                SESSION_STATE: { className: "SessionState", useSQLite: true },
                PLATFORM: { className: "Platform", useSQLite: true },
              },
              // A self-hosted stage under test, as the Worker's tests bind it.
              bindings: {
                ACCESS_TEAM_DOMAIN: "",
                ACCESS_AUD: "",
                PLATFORM_ADMIN_EMAILS: "",
                PLATFORM_ADMIN_SERVICE_TOKENS: "",
                APP_DOMAIN: "app.example.com",
                // Fixed test keys (deployed: Alchemy `Random`s, alchemy.run.ts), as Models' tests bind them.
                SECRETS_KEY: "commissary-test-secrets-key-0123456789abcdef0123456789abcdef012345",
              },
            },
          }),
        ],
        test: {
          name: "tools",
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
