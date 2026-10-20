// State's tests run in workerd (@cloudflare/vitest-plugin) against its Durable Object classes on real SQLite storage:
// the test Worker (test/worker.ts) exports the ControlPlane (the org-wide base composed with dummy area parts), the
// Platform registry and SessionState. Compatibility settings as the deployed Worker's (alchemy.run.ts,
// apps/app/vitest.config.ts); the bindings are the ones `StateObjectEnv` names (test/env.d.ts).
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { testWorkerOptions } from "../../tools/vitest/test-workers.ts";

export default defineConfig({
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
        // A self-hosted stage under test: no Access settings (the dev secrets key would be accepted), no platform
        // admins, and fixed secrets keys like the Worker's tests' (the previous one lets a test start a ControlPlane
        // whose data key it still wraps).
        bindings: {
          ACCESS_TEAM_DOMAIN: "",
          ACCESS_AUD: "",
          PLATFORM_ADMIN_EMAILS: "",
          PLATFORM_ADMIN_SERVICE_TOKENS: "",
          SECRETS_KEY: "commissary-test-secrets-key-0123456789abcdef0123456789abcdef012345",
          SECRETS_KEY_PREVIOUS: "commissary-test-previous-secrets-key-0123456789abcdef012345678901",
        },
      },
    }),
  ],
  test: {
    name: "state",
    include: ["test/**/*.test.ts"],
    // The local test budget (tools/vitest/test-workers.ts): Vitest's default workers in CI.
    ...testWorkerOptions(),
    // CI's shards reach every package's run; a shard may get none of this package's files.
    passWithNoTests: true,
    // The first test in each file pays for module transformation inside workerd; keep generous timeouts.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
