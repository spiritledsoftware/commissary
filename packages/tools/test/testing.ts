// `@commissary/tools/testing`: what the Worker's tests need of Tools (docs/DEVELOPMENT.md, "Tests"). Test files only.
// The Worker's tests go through its router; they serve fake MCP servers to it with these helpers.

export {
  type FakeMcpOptions,
  type FakeMcpServer,
  type FakeTool,
  fakeMcpServer,
  type RecordedMcpRequest,
  serveFakeMcpServers,
} from "./support/mcp-server.ts";
