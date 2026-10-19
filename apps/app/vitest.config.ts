import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { BUNDLE_ALIASES } from "../../infra/bundle.ts";

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
  // Fixed test key of the keyed `auth_index` (deployed: an Alchemy `Random`, alchemy.run.ts); 64 characters, so
  // tests that configure Access (where shorter keys are refused, packages/models/src/management/auth-index.ts) can use it too.
  AUTH_INDEX_KEY: "commissary-test-auth-index-key-0123456789abcdef0123456789abcdef01234",
  // Fixed test secrets keys (deployed: an Alchemy `Random`, alchemy.run.ts), 64 characters like the minted ones. The
  // previous key lets tests start a ControlPlane whose data key is still wrapped by it (a rotation, @commissary/state's
  // secrets/).
  SECRETS_KEY: "commissary-test-secrets-key-0123456789abcdef0123456789abcdef012345",
  SECRETS_KEY_PREVIOUS: "commissary-test-previous-secrets-key-0123456789abcdef012345678901",
};

/**
 * Commissary Cloud (`COMMISSARY_MODE=cloud`, ADR 0026, `src/hosted/`): people sign in on the auth host (the auth Worker,
 * ADR 0030, tested in apps/auth), which the app Worker asks over `AUTH`: here a fake the test Worker binds itself
 * (test/worker.ts `FakeSignIn`). No dev bypass: requests go to `https://commissary.test`. (The per-org rate limit is the
 * client API's: the API Worker's, apps/api/vitest.config.ts.)
 */
const HOSTED_BINDINGS = {
  ...SELF_HOSTED_BINDINGS,
  ACCESS_DEV_BYPASS: "",
  COMMISSARY_MODE: "cloud",
  PLATFORM_ADMIN_EMAILS: "root@example.com",
  PLATFORM_ADMIN_SERVICE_TOKENS: "admin-token.access",
  AUTH_ORIGIN: "https://auth.commissary.test",
  OWNED_ORG_LIMIT: "3",
};

// The test Worker mirrors the deployed ones declared in alchemy.run.ts (compatibility settings and binding names); there
// is no Wrangler configuration file. Its entry (test/worker.ts) is the app Worker's handler plus the state Worker's
// Durable Objects, so both run in one isolate (#135): `durableObjects` names classes the entry exports, where the
// deployed app binds them by script name.
const worker = (bindings: Record<string, string>) =>
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
      assets: {
        // The control panel's build (`pnpm build`), as deployed. No test reads it (a missing folder serves nothing): the
        // tests that need a panel bind their own `ASSETS`, so it is not an input of the test task (turbo.json).
        directory: "../web/dist",
        binding: "ASSETS",
        routerConfig: { invoke_user_worker_ahead_of_assets: true },
      },
      bindings,
    },
  });

export default defineConfig({
  resolve: { alias: { ...BUNDLE_ALIASES } },
  test: {
    // The first test in each file pays for module transformation inside workerd; keep generous timeouts.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    projects: [
      {
        extends: true,
        plugins: [worker(SELF_HOSTED_BINDINGS)],
        test: {
          name: "self-hosted",
          include: ["test/**/*.test.ts"],
          exclude: ["test/hosted/**"],
        },
      },
      {
        extends: true,
        plugins: [worker(HOSTED_BINDINGS)],
        test: { name: "hosted", include: ["test/hosted/**/*.test.ts"] },
      },
    ],
  },
});
