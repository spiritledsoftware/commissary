// `@commissary/tools/testing`: what the Worker's tests need of Tools (docs/DEVELOPMENT.md, "Tests"). Test files only.
// The Worker's tests go through its router; they serve fake MCP servers (and the authorization servers of their OAuth
// sign-ins, #202) to it with these helpers, bind a fake Browser Run binding (`BROWSER`, #212) and browser sessions'
// objects over a fake provider's browsers (`FakeBrowserSession`, #213, reached as the Tools part reaches them:
// `browserSessionStub`), and seed tool calls' usage records with Tools' own writer.

export {
  type FakeMcpOptions,
  type FakeMcpServer,
  type FakeTool,
  fakeMcpServer,
  type RecordedMcpRequest,
  serveFakeMcpServers,
  serveOrigin,
} from "./support/mcp-server.ts";

export {
  bearerOf,
  type FakeAuthServer,
  type FakeAuthServerOptions,
  fakeAuthServer,
} from "./support/oauth-server.ts";

/**
 * Tools' writers of a tool call's usage record and of a browser or sandbox session's (#214, #224): tests that read usage
 * records seed them through these, so what they read is what Tools writes.
 */
export {
  insertSessionRecord,
  insertToolCallRecord,
  type SessionRecord,
  type ToolCallRecord,
} from "../src/usage/record.ts";

export { type FakeBrowserRun, fakeBrowserRun } from "./support/fake-browser.ts";

/** Commissary Cloud's OAuth grants for MCP clients as a store of org data (#200), for the cross-org suite. */
export { signInGrants } from "./support/sign-in-grants.ts";

export { FakeBrowserSession } from "./support/fake-session-object.ts";

/** Who started each of an org's browser crawls (#270), as the Tools part logs them: a store of the cross-org suite. */
export { BrowserCrawlStore } from "../src/browser/crawls.ts";

/** How the Tools part reaches an org's browser session by its id: the cross-org suite reaches them the same way. */
export { browserSessionStub } from "../src/browser/session-object.ts";

export { useToolkitCatalogRegistry } from "./support/catalog.ts";
