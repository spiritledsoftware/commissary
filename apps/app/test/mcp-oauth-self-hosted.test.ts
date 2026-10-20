// A self-hosted Commissary has no OAuth server for MCP clients (#200): Access signs them in (ADR 0045). Its endpoints,
// the consent page and the routes the page calls answer like paths the router does not know, even to an admin (the dev
// bypass signs requests on localhost in). Commissary Cloud's are tested in test/hosted/mcp-oauth.test.ts.
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const LOCAL = "http://localhost";

const request = (path: string, init: RequestInit = {}) =>
  exports.default.fetch(new Request(`${LOCAL}${path}`, { redirect: "manual", ...init }));

const post = (path: string, body: Readonly<Record<string, string | null>>) =>
  request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: LOCAL,
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify(body),
  });

describe("the OAuth server for MCP clients on a self-hosted Commissary", () => {
  it("does not exist", async () => {
    const answers = [
      await request("/.well-known/oauth-authorization-server"),
      await request("/.well-known/oauth-protected-resource/mcp"),
      await request("/oauth/token", { method: "POST" }),
      await request("/oauth/register", { method: "POST" }),
      await request("/authorize?client_id=x"),
      await request("/o/default/authorize?client_id=x"),
      await post("/v9/management/mcp-sign-ins", { query: "?client_id=x" }),
      await post("/v9/management/orgs/default/mcp-sign-ins/approve", {
        handle: "h",
        tool_scope: null,
      }),
      await post("/v9/management/mcp-sign-ins/deny", { handle: "h" }),
    ];

    for (const answer of answers) {
      expect(answer.status, answer.url).toBe(404);
      await answer.body?.cancel();
    }
  });
});
