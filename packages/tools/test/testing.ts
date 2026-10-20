// `@commissary/tools/testing`: what the Worker's tests need of Tools (docs/DEVELOPMENT.md, "Tests"). Test files only.
// The Worker's tests go through its router; they serve fake MCP servers to it with these helpers, bind a fake Browser
// Run binding (`BROWSER`, #212), and seed tool calls' usage records with Tools' own writer.

export {
  type FakeMcpOptions,
  type FakeMcpServer,
  type FakeTool,
  fakeMcpServer,
  type RecordedMcpRequest,
  serveFakeMcpServers,
} from "./support/mcp-server.ts";

/**
 * Tools' writer of a tool call's usage record: tests that read usage records seed tool calls through it, so what they
 * read is what Tools writes.
 */
export { insertToolCallRecord, type ToolCallRecord } from "../src/usage/record.ts";

export { type FakeBrowserRun, fakeBrowserRun } from "./support/fake-browser.ts";

/** Commissary Cloud's OAuth grants for MCP clients as a store of org data (#200), for the cross-org suite. */
export { signInGrants } from "./support/sign-in-grants.ts";
