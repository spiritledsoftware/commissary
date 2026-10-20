// The browser session's Durable Object over the fake provider's browsers (`fake-sessions.ts`), for the tests' Workers:
// the deployed class with its provider replaced, whichever provider the session was opened with.
import { BrowserSession } from "../../src/browser/session-object.ts";
import type { BrowserSessionProvider } from "../../src/browser/provider.ts";
import { fakeSessionProvider } from "./fake-sessions.ts";

export class FakeBrowserSession extends BrowserSession {
  protected override sessionProvider(): BrowserSessionProvider {
    return fakeSessionProvider();
  }
}
