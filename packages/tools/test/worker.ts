// The test Worker's entry (vitest.config.ts, project `tools`): test-only ControlPlanes, `@commissary/state`'s org-wide
// base composed with the Tools part the way a Worker composes it (`composeControlPlane`), the Platform registry and
// SessionState, on real SQLite storage. Tools' tests depend on no other area and on no app.
//
// `ControlPlane` is a deployment without built-in toolkits; `BrowserControlPlane` one with a fake Browser Run binding
// (#212) and the browser sessions' objects (#213: `BrowserSession`, whose browsers are a fake provider's),
// `OtherBrowserControlPlane` one whose browser toolkit has a fake second browser provider behind it, and
// `UpgradedControlPlane` one that gets the binding once its storage holds `UPGRADE_TO_BROWSER`: a test sets it and
// restarts the object, as a deploy that adds the binding does. `SandboxControlPlane` has the sandbox toolkit as every
// deployment has it (#222): Cloudflare's sandbox, on this Worker's `SandboxSession` objects, whose just-bash runs in a
// Dynamic Worker loaded through the test `LOADER`; `OtherSandboxControlPlane` has a fake second sandbox provider. The
// browser ones leave the sandbox out, so their toolkits are the browser's alone. `ComputerSandboxControlPlane` is a
// deployment that has the sandbox's computer (#223, the `COMPUTER` marker); the tests fake the container, so the
// session objects are the deployed class with a fake computer in its place (`FakeComputerSandboxSession`), which a
// session uses only when it opened with the computer, as deployed. `CrawlControlPlane` has its built-in toolkits from a
// deployment's bindings with a fake Browser Run binding and the account and API token of Browser Run's crawls (#270),
// whose REST API a test serves through the global `fetch` (`fake-crawl.ts`, `fake-fetch.ts`). `CloudControlPlane` is
// Commissary Cloud's, with a managed OAuth app for the toolkit catalog service `acme` (#207, `support/managed-apps.ts`).
import { env } from "cloudflare:workers";
import type { Clock } from "effect";
import { COMPUTER_MARKER } from "@commissary/core";
import { composeControlPlane } from "@commissary/state";
import type { ToolsControlPlane } from "../src/env.ts";
import { browserRun } from "../src/browser/browser-run.ts";
import { type BrowserSessionEnv, browserSessions } from "../src/browser/session-object.ts";
import type { BrowserSessionRecord } from "../src/usage/record.ts";
import { builtInProviders, ToolsPart } from "../src/state.ts";
import { fakeBrowserRun, fakeOtherProvider } from "./support/fake-browser.ts";
import { FakeComputerSandboxSession } from "./support/fake-computer.ts";
import { CRAWL_ACCOUNT, CRAWL_MAX_PAGES, CRAWL_TOKEN } from "./support/fake-crawl.ts";
import { FakeBrowserSession } from "./support/fake-session-object.ts";
import { fakeSandboxProvider } from "./support/fake-sandbox.ts";
import { cloudManagedApps } from "./support/managed-apps.ts";

export { Platform, SessionState } from "@commissary/state";

/**
 * The browser sessions' objects report their alarm's closes, with the browser time before them, to the ControlPlane
 * that opened them (#214): here the browser one, as only it opens sessions. A test of browser time sets what new
 * objects read the time from (`clock`, a `TestClock` it also gives the part, so both read one time from before a
 * session opens), and makes the next usage record writes or reports fail (`failRecords`, `failReports`), through an
 * instance's constructor in the objects' isolate (browser-time.test.ts).
 */
export class BrowserSession extends FakeBrowserSession {
  static clock: Clock.Clock | undefined;
  static failRecords = 0;
  static failReports = 0;

  constructor(ctx: DurableObjectState, sessionEnv: BrowserSessionEnv) {
    super(ctx, sessionEnv);

    if (BrowserSession.clock !== undefined) this.useClock(BrowserSession.clock);
  }

  protected override controlPlane(org: string): DurableObjectStub<ToolsControlPlane> {
    if (BrowserSession.failReports > 0) {
      BrowserSession.failReports -= 1;

      throw new Error("the ControlPlane could not be reached");
    }

    return env.BROWSER_CONTROL_PLANE.getByName(org);
  }

  protected override async writeRecord(record: BrowserSessionRecord): Promise<void> {
    if (BrowserSession.failRecords > 0) {
      BrowserSession.failRecords -= 1;

      throw new Error("the usage database could not be reached");
    }

    await super.writeRecord(record);
  }
}

// The sandbox's session objects, and the entrypoints their Dynamic Workers and computers reach, as the state Worker
// exports them.
export { SandboxEgress, WorkspaceProxy, WorkspaceServiceProxy } from "../src/state.ts";

export class SandboxSession extends FakeComputerSandboxSession {}

export class ControlPlane extends composeControlPlane({
  tools: (ctx, _env, core) => new ToolsPart(ctx, core),
}) {}

/** Commissary Cloud's ControlPlane, with a managed OAuth app for the catalog service `acme` (#207). */
export class CloudControlPlane extends composeControlPlane({
  tools: (ctx, _env, core) => new ToolsPart(ctx, core, {}, undefined, cloudManagedApps),
}) {}

export class BrowserControlPlane extends composeControlPlane({
  tools: (ctx, env: Cloudflare.Env, core) =>
    new ToolsPart(ctx, core, {
      browser: browserRun(fakeBrowserRun()),
      browserSessions: browserSessions(env.BROWSER_SESSIONS),
    }),
}) {}

export class OtherBrowserControlPlane extends composeControlPlane({
  tools: (ctx, env: Cloudflare.Env, core) =>
    new ToolsPart(ctx, core, {
      browser: fakeOtherProvider(),
      browserSessions: browserSessions(env.BROWSER_SESSIONS),
    }),
}) {}

/** The key whose value `true` gives an `UpgradedControlPlane` its `browser` binding when it next starts. */
export const UPGRADE_TO_BROWSER = "test:browser";

export class UpgradedControlPlane extends composeControlPlane({
  tools: (ctx, _env, core) =>
    new ToolsPart(
      ctx,
      core,
      ctx.storage.kv.get(UPGRADE_TO_BROWSER) === true
        ? { browser: browserRun(fakeBrowserRun()) }
        : {},
    ),
}) {}

/**
 * A deployment's built-in toolkits from its bindings, with Browser Run and the account token of its crawls (#270), which
 * take at most {@link CRAWL_MAX_PAGES} pages each.
 */
export class CrawlControlPlane extends composeControlPlane({
  tools: (ctx, env: Cloudflare.Env, core) =>
    new ToolsPart(
      ctx,
      core,
      builtInProviders({
        ...env,
        BROWSER: fakeBrowserRun(),
        BROWSER_RUN_ACCOUNT_ID: CRAWL_ACCOUNT,
        BROWSER_RUN_API_TOKEN: CRAWL_TOKEN,
        COMMISSARY_CRAWL_MAX_PAGES: String(CRAWL_MAX_PAGES),
      }),
    ),
}) {}

/** A deployment's built-in toolkits from its bindings, without Browser Run: the sandbox toolkit only. */
export class SandboxControlPlane extends composeControlPlane({
  tools: (ctx, env: Cloudflare.Env, core) => new ToolsPart(ctx, core, builtInProviders(env)),
}) {}

/** A deployment that attached the sandbox's computer: the marker the deploy binds beside it (#223). */
export class ComputerSandboxControlPlane extends composeControlPlane({
  tools: (ctx, env: Cloudflare.Env, core) =>
    new ToolsPart(ctx, core, builtInProviders({ ...env, ...COMPUTER_MARKER })),
}) {}

export class OtherSandboxControlPlane extends composeControlPlane({
  tools: (ctx, _env, core) => new ToolsPart(ctx, core, { sandbox: fakeSandboxProvider() }),
}) {}

export default {
  fetch: () => new Response("Tools' test Worker serves no requests", { status: 404 }),
} satisfies ExportedHandler;
