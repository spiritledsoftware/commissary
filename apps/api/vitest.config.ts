import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

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
      },
      kvNamespaces: ["CACHE"],
      d1Databases: ["USAGE"],
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
