import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { testWorkerOptions } from "../../tools/vitest/test-workers.ts";

/** Bindings of a self-hosted Commissary (`COMMISSARY_MODE` unset), the deployment every test but `test/hosted/` runs against. */
const SELF_HOSTED_BINDINGS = {
  ACCESS_TEAM_DOMAIN: "",
  ACCESS_AUD: "",
  PLATFORM_ADMIN_EMAILS: "",
  PLATFORM_ADMIN_SERVICE_TOKENS: "",
  // End-to-end tests through `exports.default.fetch` authenticate with the dev bypass, which only applies to
  // loopback hosts (`http://localhost/...`) while ACCESS_TEAM_DOMAIN/ACCESS_AUD stay empty; other hosts still
  // fail closed (`https://commissary.test/...` answers 500 without Access settings).
  ACCESS_DEV_BYPASS: "true",
  META_MINT_URL: "",
  // No own hosts: the outbound guard learns the test request's host from the request.
  OWN_HOSTS: "",
  // Fixed test key of the keyed `auth_index` (deployed: an Alchemy `Random`, alchemy.run.ts), the app's test key.
  AUTH_INDEX_KEY: "commissary-test-auth-index-key-0123456789abcdef0123456789abcdef01234",
  // Fixed test secrets keys of the state Worker's classes, which the test Worker runs (test/worker.ts).
  SECRETS_KEY: "commissary-test-secrets-key-0123456789abcdef0123456789abcdef012345",
  SECRETS_KEY_PREVIOUS: "commissary-test-previous-secrets-key-0123456789abcdef012345678901",
};

/**
 * Commissary Cloud (`COMMISSARY_MODE=cloud`, ADR 0026): API keys only, under per-plan rate ceilings low enough to reach.
 * No dev bypass: requests go to `https://commissary.test`.
 */
const HOSTED_BINDINGS = {
  ...SELF_HOSTED_BINDINGS,
  ACCESS_DEV_BYPASS: "",
  COMMISSARY_MODE: "cloud",
  PLATFORM_ADMIN_EMAILS: "root@example.com",
  PLATFORM_ADMIN_SERVICE_TOKENS: "admin-token.access",
  // Pay as you go through Polar (#237): test values. No test reaches Polar: no org here has a Polar customer.
  POLAR_ACCESS_TOKEN: "polar_oat_test",
  POLAR_PRODUCT_ID: "prod_payg",
  POLAR_SERVER: "sandbox",
  // The OAuth server for MCP clients (#200), on the test host, as on a stage with one host.
  MCP_OAUTH_ISSUER: "https://commissary.test",
  MCP_OAUTH_RESOURCE: "https://commissary.test/mcp",
};

/**
 * Requests per minute an org may send on the client API of the Commissary Cloud test Worker, by plan (the deployed
 * ceilings are 60 and 600, `REQUEST_RATE_CEILING`; test/hosted/rate-limit.test.ts).
 */
const HOSTED_TEST_FREE_RATE_LIMIT = 5;

const HOSTED_TEST_PAYG_RATE_LIMIT = 8;

// The test Worker mirrors the deployed API Worker declared in alchemy.run.ts (compatibility settings and binding
// names); there is no Wrangler configuration file. Its entry (test/worker.ts) is the API Worker's handler plus the state
// Worker's Durable Objects, so both run in one isolate (#135): `durableObjects` names classes the entry exports, where
// the deployed API Worker binds them by script name.
const worker = (bindings: Record<string, string>, hosted: boolean) =>
  cloudflareTest({
    main: "./test/worker.ts",
    miniflare: {
      compatibilityDate: "2026-08-01",
      compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
      // Same module types as the deployed bundle (alchemy.run.ts): tokenizer ranks are `Data` modules (ArrayBuffer).
      modulesRules: [{ type: "Data", include: ["**/*.bin"] }],
      durableObjects: {
        CONTROL_PLANE: { className: "ControlPlane", useSQLite: true },
        SESSION_STATE: { className: "SessionState", useSQLite: true },
        PLATFORM: { className: "Platform", useSQLite: true },
        // The sandbox toolkit's sessions (#222), which the ControlPlane reaches as on every deployment.
        SANDBOX_SESSION: { className: "SandboxSession", useSQLite: true },
        // The agent runs (#227): the API Worker's own class, as deployed.
        AGENT_RUN: { className: "AgentRun", useSQLite: true },
        // The schedule triggers (#231): the API Worker's own class, as deployed.
        AGENT_SCHEDULE: { className: "AgentSchedule", useSQLite: true },
      },
      kvNamespaces: hosted ? ["CACHE", "OAUTH_KV"] : ["CACHE"],
      d1Databases: ["USAGE"],
      // Dynamic Workers, where a sandbox session's just-bash runs (ADR 0043: every deployment has them).
      workerLoaders: { LOADER: {} },
      ...(hosted
        ? {
            ratelimits: {
              FREE_RATE_LIMIT: {
                namespace_id: "1001",
                simple: { limit: HOSTED_TEST_FREE_RATE_LIMIT, period: 60 as const },
              },
              PAYG_RATE_LIMIT: {
                namespace_id: "1002",
                simple: { limit: HOSTED_TEST_PAYG_RATE_LIMIT, period: 60 as const },
              },
            },
          }
        : {}),
      bindings,
    },
  });

export default defineConfig({
  test: {
    // The local test budget (tools/vitest/test-workers.ts): Vitest's default workers in CI.
    ...testWorkerOptions(),
    // The first test in each file pays for module transformation inside workerd; keep generous timeouts.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    projects: [
      {
        extends: true,
        plugins: [worker(SELF_HOSTED_BINDINGS, false)],
        test: {
          name: "self-hosted",
          include: ["test/**/*.test.ts"],
          exclude: ["test/hosted/**"],
        },
      },
      {
        extends: true,
        plugins: [worker(HOSTED_BINDINGS, true)],
        test: { name: "hosted", include: ["test/hosted/**/*.test.ts"] },
      },
    ],
  },
});
