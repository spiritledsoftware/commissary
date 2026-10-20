// Agents' tests run in workerd (@cloudflare/vitest-plugin) against its ControlPlane part on real SQLite storage: the
// test Worker (test/worker.ts) exports a ControlPlane (the org-wide base composed with the Agents part only), the
// Platform registry and SessionState. Compatibility settings as the deployed Worker's (alchemy.run.ts); the bindings
// are the ones test/env.d.ts declares, a self-hosted stage with the Worker tests' fixed keys, and the Dynamic Workers
// binding `LOADER` (`AgentsBindings`), whose presence is the area's: the part reads no binding of its own, and the app
// Worker checks the presence through its routes.
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
          // The agent runs (#227, `AgentsBindings`), with no client API behind them (test/worker.ts).
          AGENT_RUN: { className: "AgentRun", useSQLite: true },
        },
        // Dynamic Workers (ADR 0043): bound on every deployment, the Agents area's presence (#226).
        workerLoaders: { LOADER: {} },
        bindings: {
          ACCESS_TEAM_DOMAIN: "",
          ACCESS_AUD: "",
          PLATFORM_ADMIN_EMAILS: "",
          PLATFORM_ADMIN_SERVICE_TOKENS: "",
          // Fixed test key (deployed: an Alchemy `Random`, alchemy.run.ts), as the other areas' tests bind it.
          SECRETS_KEY: "commissary-test-secrets-key-0123456789abcdef0123456789abcdef012345",
        },
      },
    }),
  ],
  test: {
    name: "agents",
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
