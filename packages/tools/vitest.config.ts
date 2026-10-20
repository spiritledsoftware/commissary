// Tools' tests, two projects like Models': `tools-unit` runs the pure tests (`test/unit/`) in Node.js; `tools` runs the rest
// in workerd (@cloudflare/vitest-plugin) against the test Worker (test/worker.ts), whose ControlPlane is the org-wide
// base composed with the Tools part only (two more have a fake browser behind the browser toolkit, #212: the test Worker
// hands their Tools part a fake `browser` binding, so the config binds none), and three more have the sandbox toolkit
// (#222): one Cloudflare's, whose sessions are this Worker's `SandboxSession` objects running just-bash in Dynamic
// Workers of the test `LOADER`, one the same with the sandbox's computer (#223, its container faked), and one a fake
// second sandbox provider; one more has the agents toolkit (#229), over a fake directory of agents. Compatibility settings as the deployed Worker's (alchemy.run.ts);
// the bindings are the ones test/env.d.ts declares, with the Worker tests' fixed keys.
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { nodePackageTests } from "../../tools/vitest/node-package.ts";
import { testWorkerOptions } from "../../tools/vitest/test-workers.ts";

const unit = nodePackageTests("tools-unit");

const PLAYWRIGHT_CLIENT_PAGE =
  "node_modules/@cloudflare/playwright/lib/playwright-core/src/client/page.js";

export default defineConfig({
  test: {
    // The local test budget (tools/vitest/test-workers.ts: Vitest's default workers in CI). The workerd project, which
    // does not extend this config, takes the root's value, as `models-unit` and `tools-unit` set the same one.
    ...testWorkerOptions(),
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
                // Commissary Cloud's, with a managed OAuth app (#207).
                CLOUD_CONTROL_PLANE: { className: "CloudControlPlane", useSQLite: true },
                // The ControlPlane with a fake `browser` binding, and with a fake second browser provider (#212).
                BROWSER_CONTROL_PLANE: { className: "BrowserControlPlane", useSQLite: true },
                OTHER_BROWSER_CONTROL_PLANE: {
                  className: "OtherBrowserControlPlane",
                  useSQLite: true,
                },
                // One that gains the binding when a test says so, and restarts it (#212).
                UPGRADED_CONTROL_PLANE: { className: "UpgradedControlPlane", useSQLite: true },
                // One with Browser Run and the account token of its crawls (#270).
                CRAWL_CONTROL_PLANE: { className: "CrawlControlPlane", useSQLite: true },
                // The browser sessions' objects (#213), over a fake provider's browsers.
                BROWSER_SESSIONS: { className: "BrowserSession", useSQLite: true },
                // The sandbox toolkit with Cloudflare's sandbox, and with a fake second sandbox provider (#222).
                SANDBOX_CONTROL_PLANE: { className: "SandboxControlPlane", useSQLite: true },
                OTHER_SANDBOX_CONTROL_PLANE: {
                  className: "OtherSandboxControlPlane",
                  useSQLite: true,
                },
                // A deployment with the sandbox's computer (#223), whose container the session objects fake.
                COMPUTER_SANDBOX_CONTROL_PLANE: {
                  className: "ComputerSandboxControlPlane",
                  useSQLite: true,
                },
                // A deployment with the Agents area, whose agents a fake directory answers (#229).
                AGENTS_CONTROL_PLANE: { className: "AgentsControlPlane", useSQLite: true },
                SANDBOX_SESSION: { className: "SandboxSession", useSQLite: true },
                SESSION_STATE: { className: "SessionState", useSQLite: true },
                PLATFORM: { className: "Platform", useSQLite: true },
              },
              d1Databases: ["USAGE"],
              // The OAuth server's store for MCP clients (#200), which its tests hand `oauth/` in a config of their own:
              // the stage stays self-hosted (no `COMMISSARY_MODE`, `MCP_OAUTH_ISSUER` or `MCP_OAUTH_RESOURCE`), so
              // nothing else turns the OAuth server on; its flows are the app Worker's hosted tests'.
              // `CACHE`: the deployment's namespace, where the toolkit catalog's refreshed registry is kept (#207).
              kvNamespaces: ["OAUTH_KV", "CACHE"],
              // Dynamic Workers, where the sandbox's just-bash runs (ADR 0043: every deployment has them).
              workerLoaders: { LOADER: {} },
              // A self-hosted stage under test, as the Worker's tests bind it.
              bindings: {
                ACCESS_TEAM_DOMAIN: "",
                ACCESS_AUD: "",
                PLATFORM_ADMIN_EMAILS: "",
                PLATFORM_ADMIN_SERVICE_TOKENS: "",
                APP_DOMAIN: "app.example.com",
                // The API host, where toolkit sign-ins name Commissary's CIMD document (#202, `ToolsBindings`).
                API_DOMAIN: "api.example.com",
                // Fixed test keys (deployed: Alchemy `Random`s, alchemy.run.ts), as Models' tests bind them.
                SECRETS_KEY: "commissary-test-secrets-key-0123456789abcdef0123456789abcdef012345",
                // The sandbox's computer (#223): off, as on a deployment without its container; the ControlPlane
                // that has it adds the marker (`ComputerSandboxControlPlane`, test/worker.ts) and its session objects a
                // fake container (test/support/fake-container.ts).
                COMPUTER: "off",
                COMPUTER_INSTANCE: "standard-1",
              },
            },
          }),
        ],
        resolve: {
          alias: {
            // `@cloudflare/playwright`'s client page, internal to the package (not in its exports): the canary of
            // test/browser-run-sessions.test.ts checks it still has the snapshot the session tools read.
            "playwright-client-page": `${import.meta.dirname}/${PLAYWRIGHT_CLIENT_PAGE}`,
          },
        },
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
