// The test Worker's entry (vitest.config.ts, project `tools`): test-only ControlPlanes, `@commissary/state`'s org-wide
// base composed with the Tools part the way a Worker composes it (`composeControlPlane`), the Platform registry and
// SessionState, on real SQLite storage. Tools' tests depend on no other area and on no app.
//
// `ControlPlane` is a deployment without a `browser` binding (no built-in toolkit); `BrowserControlPlane` one with a
// fake Browser Run binding (#212) and the browser sessions' objects (#213: `BrowserSession`, whose browsers are a fake
// provider's), `OtherBrowserControlPlane` one whose browser toolkit has a fake second browser provider behind it, and
// `UpgradedControlPlane` one that gets the binding once its storage holds `UPGRADE_TO_BROWSER`: a test sets it and
// restarts the object, as a deploy that adds the binding does.
import { composeControlPlane } from "@commissary/state";
import { browserSessions } from "../src/browser/session-object.ts";
import { builtInProviders, ToolsPart } from "../src/state.ts";
import { fakeBrowserRun, fakeOtherProvider } from "./support/fake-browser.ts";
import { FakeBrowserSession } from "./support/fake-session-object.ts";

export { Platform, SessionState } from "@commissary/state";

export class BrowserSession extends FakeBrowserSession {}

export class ControlPlane extends composeControlPlane({
  tools: (ctx, _env, core) => new ToolsPart(ctx, core),
}) {}

export class BrowserControlPlane extends composeControlPlane({
  tools: (ctx, env: Cloudflare.Env, core) =>
    new ToolsPart(
      ctx,
      core,
      builtInProviders({ BROWSER: fakeBrowserRun(), BROWSER_SESSIONS: env.BROWSER_SESSIONS }),
    ),
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
        ? builtInProviders({ BROWSER: fakeBrowserRun() })
        : {},
    ),
}) {}

export default {
  fetch: () => new Response("Tools' test Worker serves no requests", { status: 404 }),
} satisfies ExportedHandler;
