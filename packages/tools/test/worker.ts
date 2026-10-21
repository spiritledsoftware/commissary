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
// `AgentsControlPlane` has the agents toolkit (#229), as where the Agents area is, over a fake directory of the agents
// each member may run.
import { env } from "cloudflare:workers";
import type { Clock } from "effect";
import { COMPUTER_MARKER } from "@commissary/core";
import { composeControlPlane } from "@commissary/state";
import type { SpendAgent } from "@commissary/state/spend";
import type { ToolsControlPlane } from "../src/env.ts";
import { browserRun } from "../src/browser/browser-run.ts";
import { type BrowserSessionEnv, browserSessions } from "../src/browser/session-object.ts";
import type { SessionRecord } from "../src/usage/record.ts";
import { builtInProviders, type RunnableAgent, ToolsPart } from "../src/state.ts";
import { fakeBrowserRun, fakeOtherProvider } from "./support/fake-browser.ts";
import { FakeComputerSandboxSession } from "./support/fake-computer.ts";
import type { SandboxSessionEnv } from "../src/sandbox/cloudflare/session.ts";
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

  protected override async writeRecord(record: SessionRecord): Promise<void> {
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

/**
 * The sandbox sessions' objects report the computer time no call charged, from their alarms, to the ControlPlane
 * that opened them (#224): here the one with the computer, as only its sessions use one (a report reaching another
 * org's ControlPlane finds no session there, and charges nothing). A test of computer time sets what new objects read
 * the time from (`clock`, a `TestClock` it also gives the part) and makes the next usage record writes or reports fail
 * (`failRecords`, `failReports`), through an instance's constructor in the objects' isolate (computer-time.test.ts).
 * With `before224` set, every object answers as one from before #224 would: it takes no metering, so it meters
 * nothing and answers no computer time, and has no `stopForLimit`.
 */
export class SandboxSession extends FakeComputerSandboxSession {
  static clock: Clock.Clock | undefined;
  static failRecords = 0;
  static failReports = 0;
  static before224 = false;

  constructor(ctx: DurableObjectState, sessionEnv: SandboxSessionEnv) {
    super(ctx, sessionEnv);

    if (SandboxSession.clock !== undefined) this.useClock(SandboxSession.clock);
  }

  protected override controlPlane(org: string): DurableObjectStub<ToolsControlPlane> {
    if (SandboxSession.failReports > 0) {
      SandboxSession.failReports -= 1;

      throw new Error("the ControlPlane could not be reached");
    }

    return env.COMPUTER_SANDBOX_CONTROL_PLANE.getByName(org);
  }

  protected override async writeRecord(record: SessionRecord): Promise<void> {
    if (SandboxSession.failRecords > 0) {
      SandboxSession.failRecords -= 1;

      throw new Error("the usage database could not be reached");
    }

    await super.writeRecord(record);
  }

  /** `metering`, unless the object is one from before #224, which takes none. */
  static #taken<M>(metering: M): M | undefined {
    return SandboxSession.before224 ? undefined : metering;
  }

  override open(
    ...[caller, allowance, policy, metering, opener, untilPurged]: Parameters<
      FakeComputerSandboxSession["open"]
    >
  ) {
    return super.open(
      caller,
      allowance,
      policy,
      SandboxSession.#taken(metering),
      SandboxSession.#taken(opener),
      untilPurged,
    );
  }

  override run(
    ...[caller, command, timeoutMs, metering]: Parameters<FakeComputerSandboxSession["run"]>
  ) {
    return super.run(caller, command, timeoutMs, SandboxSession.#taken(metering));
  }

  override readFile(
    ...[caller, path, metering]: Parameters<FakeComputerSandboxSession["readFile"]>
  ) {
    return super.readFile(caller, path, SandboxSession.#taken(metering));
  }

  override stat(...[caller, path, metering]: Parameters<FakeComputerSandboxSession["stat"]>) {
    return super.stat(caller, path, SandboxSession.#taken(metering));
  }

  override readBytes(
    ...[caller, path, offset, length, metering]: Parameters<FakeComputerSandboxSession["readBytes"]>
  ) {
    return super.readBytes(caller, path, offset, length, SandboxSession.#taken(metering));
  }

  override writeFile(
    ...[caller, path, text, metering]: Parameters<FakeComputerSandboxSession["writeFile"]>
  ) {
    return super.writeFile(caller, path, text, SandboxSession.#taken(metering));
  }

  override list(...[caller, path, metering]: Parameters<FakeComputerSandboxSession["list"]>) {
    return super.list(caller, path, SandboxSession.#taken(metering));
  }

  override close(...[caller, metering]: Parameters<FakeComputerSandboxSession["close"]>) {
    return super.close(caller, SandboxSession.#taken(metering));
  }

  override async stopForLimit(...args: Parameters<FakeComputerSandboxSession["stopForLimit"]>) {
    // An object from before #224 has no such method: its RPC call fails.
    if (SandboxSession.before224) throw new TypeError("stopForLimit is not a function");

    return await super.stopForLimit(...args);
  }
}

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

/** The shared agent whose runs a test of computer time limits (#224, #228), as the Agents area would name it. */
export const SHARED_AGENT = { id: "ag_shared", label: "shared" };

/** The Tools part with {@link SHARED_AGENT} for a Spend limit to name, as an org with the Agents area has. */
class WithSharedAgent extends ToolsPart {
  override spendAgents(): ReadonlyArray<SpendAgent> {
    return [SHARED_AGENT];
  }
}

/**
 * A deployment that attached the sandbox's computer: the marker the deploy binds beside it (#223); a shared agent's
 * Spend limits apply to its runs ({@link SHARED_AGENT}).
 */
export class ComputerSandboxControlPlane extends composeControlPlane({
  tools: (ctx, env: Cloudflare.Env, core) =>
    new WithSharedAgent(ctx, core, builtInProviders({ ...env, ...COMPUTER_MARKER })),
}) {}

export class OtherSandboxControlPlane extends composeControlPlane({
  tools: (ctx, _env, core) => new ToolsPart(ctx, core, { sandbox: fakeSandboxProvider() }),
}) {}

/**
 * The agents a fake Agents area lets each member run (#229), by member id; `""` is a shared agent's run (as no
 * member). Any other member may run none.
 */
export const FAKE_AGENTS = new Map<string, ReadonlyArray<RunnableAgent>>([
  [
    "m-alice",
    [
      { id: "ag_writer", name: "writer", description: "Writes drafts" },
      { id: "ag_critic", name: "critic", description: "" },
    ],
  ],
  ["", [{ id: "ag_support", name: "support", description: "Answers customers" }]],
]);

/** A deployment with the Agents area, whose agents {@link FAKE_AGENTS} answers: the agents toolkit (#229). */
export class AgentsControlPlane extends composeControlPlane({
  tools: (ctx, _env, core) =>
    new ToolsPart(ctx, core, {
      agents: { runnable: (member) => FAKE_AGENTS.get(member ?? "") ?? [] },
    }),
}) {}

export default {
  fetch: () => new Response("Tools' test Worker serves no requests", { status: 404 }),
} satisfies ExportedHandler;
