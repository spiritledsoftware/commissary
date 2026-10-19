// Billing's tests run in workerd (@cloudflare/vitest-plugin) against its Durable Object part on real SQLite storage: the
// test Worker (test/worker.ts) exports a ControlPlane (the org-wide base composed with the Billing part), the Platform
// registry and SessionState. Compatibility settings as the deployed Worker's (alchemy.run.ts, apps/app/vitest.config.ts);
// the bindings are the ones test/env.d.ts declares: Commissary Cloud, since Billing does nothing elsewhere (the tests
// that need a self-hosted Commissary pass their own view of `env`).
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./test/worker.ts",
      miniflare: {
        compatibilityDate: "2026-08-01",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: {
          CONTROL_PLANE: { className: "ControlPlane", useSQLite: true },
          SESSION_STATE: { className: "SessionState", useSQLite: true },
          PLATFORM: { className: "Platform", useSQLite: true },
        },
        bindings: {
          COMMISSARY_MODE: "cloud",
          ACCESS_TEAM_DOMAIN: "",
          ACCESS_AUD: "",
          PLATFORM_ADMIN_EMAILS: "",
          PLATFORM_ADMIN_SERVICE_TOKENS: "",
          APP_DOMAIN: "app.example.com",
          SECRETS_KEY: "commissary-test-secrets-key-0123456789abcdef0123456789abcdef012345",
          SECRETS_KEY_PREVIOUS: "commissary-test-previous-secrets-key-0123456789abcdef012345678901",
        },
      },
    }),
  ],
  test: {
    name: "billing",
    include: ["test/**/*.test.ts"],
    // CI's shards reach every package's run; a shard may get none of this package's files.
    passWithNoTests: true,
    // The first test in each file pays for module transformation inside workerd; keep generous timeouts.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
