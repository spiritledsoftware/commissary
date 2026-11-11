// Readable shortening of gateway MCP tool names (Go: internal/translator/codex/claude/codex_claude_tool_names_test.go;
// upstream 08437a67).
import { describe, expect, it } from "vitest";
import {
  buildShortNameMap,
  shortenNameIfNeeded,
  shortenNamePlain,
} from "../src/translator/codex/claude/request.ts";

const gatewayPrefix = "mcp__gateway__mcp_github-12345678-9abc-def0-1234-56789abcdef0-12345678_";

describe("gateway MCP tool name shortening (08437a67)", () => {
  it("keeps over-long gateway tool names readable and distinct", () => {
    const names = [
      `${gatewayPrefix}add-comment-to-pending-review`,
      `${gatewayPrefix}create-branch`,
      `${gatewayPrefix}get_file_contents`,
      "mcp__gateway__mcp_playwright-browser-67892a0b_browser_click",
      "Bash",
    ];

    const map = buildShortNameMap(names);

    expect(names.map((name) => map.get(name))).toEqual([
      "mcp__github_add-comment-to-pending-review",
      "mcp__github_create-branch",
      "mcp__github_get_file_contents",
      "mcp__gateway__mcp_playwright-browser-67892a0b_browser_click",
      "Bash",
    ]);
  });

  it("disambiguates the same tool on two servers", () => {
    const a = `${gatewayPrefix}create-branch`;

    const b =
      "mcp__gateway__mcp_github-0b9e7c1d-1111-2222-3333-444455556666-89abcdef_create-branch";

    const map = buildShortNameMap([a, b]);

    expect(map.get(a)).not.toBe(map.get(b));
    expect(map.get(b)?.startsWith("mcp__github_create-branch")).toBe(true);
  });

  it("shortens a single name the same way, and truncates unknown long names", () => {
    expect(shortenNameIfNeeded(`${gatewayPrefix}add-issue-comment`)).toBe(
      "mcp__github_add-issue-comment",
    );

    const fallback = shortenNameIfNeeded(`mcp__srv__${"x".repeat(80)}`);

    expect(fallback).toHaveLength(64);
    expect(fallback.startsWith("mcp__xxx")).toBe(true);
  });
});

describe("Gemini and Interactions -> Codex keep plain truncation (Go: only codex/claude changed)", () => {
  it("truncates a gateway name instead of reading it", () => {
    const name = `${gatewayPrefix}create-branch`;
    const plain = shortenNamePlain(name);

    expect(plain).toHaveLength(64);
    expect(plain.startsWith("mcp__mcp_github-12345678")).toBe(true);
    expect(buildShortNameMap([name], shortenNamePlain).get(name)).toBe(plain);
    expect(shortenNameIfNeeded(name)).toBe("mcp__github_create-branch");
  });
});
