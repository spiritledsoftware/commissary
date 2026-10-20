import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { BUNDLE_ALIASES } from "../../infra/bundle.ts";
import { BASE_COOKIE_PREFIX } from "../../infra/settings.ts";
import { testWorkerOptions } from "../../tools/vitest/test-workers.ts";

/**
 * Commissary Cloud (`COMMISSARY_MODE=cloud`, ADR 0026), the only mode the auth Worker runs in (ADR 0030): Better Auth
 * signs people in with GitHub and Google (stubbed through the global `fetch` in the tests) and Turnstile guards sign-up.
 * The auth host is `https://auth.commissary.test`, the app host `https://app.commissary.test`, both under the base
 * domain `commissary.test`, the session cookie's scope, so the cookie is named apart (`__Secure-commissary.*`) as on a
 * deployed stage with that layout (test/support.ts, ADR 0031).
 */
const BINDINGS = {
  APP_ORIGIN: "https://app.commissary.test",
  AUTH_COOKIE_DOMAIN: "commissary.test",
  AUTH_COOKIE_PREFIX: BASE_COOKIE_PREFIX,
  BETTER_AUTH_SECRET: "commissary-test-better-auth-secret-0123456789abcdef0123456789abcd",
  SIGN_IN_GITHUB_CLIENT_ID: "github-client-id",
  SIGN_IN_GITHUB_CLIENT_SECRET: "github-client-secret",
  SIGN_IN_GOOGLE_CLIENT_ID: "google-client-id",
  SIGN_IN_GOOGLE_CLIENT_SECRET: "google-client-secret",
  TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
  TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
  // What the state Worker's classes read, which the test Worker runs (test/worker.ts); the app's test values.
  COMMISSARY_MODE: "cloud",
  ACCESS_TEAM_DOMAIN: "",
  ACCESS_AUD: "",
  PLATFORM_ADMIN_EMAILS: "root@example.com",
  PLATFORM_ADMIN_SERVICE_TOKENS: "",
  META_MINT_URL: "",
  AUTH_INDEX_KEY: "commissary-test-auth-index-key-0123456789abcdef0123456789abcdef01234",
  SECRETS_KEY: "commissary-test-secrets-key-0123456789abcdef0123456789abcdef012345",
};

// The test Worker mirrors the deployed auth Worker declared in alchemy.run.ts (compatibility settings and binding
// names); there is no Wrangler configuration file. Its entry (test/worker.ts) is the auth Worker plus the state Worker's
// Durable Objects, so both run in one isolate (#135): `durableObjects` names classes the entry exports, where the
// deployed auth Worker binds them by script name.
export default defineConfig({
  resolve: { alias: { ...BUNDLE_ALIASES } },
  plugins: [
    cloudflareTest({
      main: "./test/worker.ts",
      miniflare: {
        compatibilityDate: "2026-08-01",
        compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
        // Same module types as the deployed bundles (alchemy.run.ts): the state Worker's tokenizer ranks.
        modulesRules: [{ type: "Data", include: ["**/*.bin"] }],
        durableObjects: {
          CONTROL_PLANE: { className: "ControlPlane", useSQLite: true },
          SESSION_STATE: { className: "SessionState", useSQLite: true },
          PLATFORM: { className: "Platform", useSQLite: true },
        },
        d1Databases: ["SIGN_IN"],
        bindings: BINDINGS,
      },
    }),
  ],
  test: {
    name: "hosted",
    include: ["test/**/*.test.ts"],
    // The local test budget (tools/vitest/test-workers.ts): Vitest's default workers in CI.
    ...testWorkerOptions(),
    // The first test in each file pays for module transformation inside workerd; keep generous timeouts.
    testTimeout: 30_000,
    // Each file's `installFakes` loads Better Auth once (slow under a full parallel run), outside the tests.
    hookTimeout: 120_000,
  },
});
