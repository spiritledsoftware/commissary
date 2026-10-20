// Commissary's MCP endpoint (#197) on Commissary Cloud: behind the same gate as the rest of the client API, so a
// request without an API key is refused with a Bearer challenge that names the resource's metadata (#200: MCP clients
// sign in through the OAuth server; the whole flow is tested with the app Worker, apps/app/test/hosted/mcp-oauth.test.ts)
// (there is no dev bypass here), and requests count against the org's request-rate ceiling (5 a minute on Free in the
// test Worker, vitest.config.ts).
import { beforeAll, describe, expect, it } from "vitest";
import { RATE_LIMITED } from "@commissary/billing/api";
import { resetUsageDb } from "@commissary/models/testing";
import { call, keyedOrg, roomInWindow } from "./support.ts";

beforeAll(async () => {
  await resetUsageDb();
});

const FREE_LIMIT = 5;

/** A 2025 client's `tools/list`, with `headers`. */
const listTools = (headers: Record<string, string> = {}) =>
  call("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

describe("the MCP endpoint on Commissary Cloud", () => {
  it("refuses a request without an API key with 401 and a Bearer challenge", async () => {
    const refused = await listTools();

    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://commissary.test/.well-known/oauth-protected-resource/mcp"',
    );
    await refused.body?.cancel();

    // An access token of no grant is no API key either.
    const unknown = await listTools({ authorization: "Bearer org/member:grant:secret" });

    expect(unknown.status).toBe(401);
    await unknown.body?.cancel();
  });

  it("serves the resource's metadata, which names the authorization server", async () => {
    const metadata = await call("/.well-known/oauth-protected-resource/mcp");

    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toEqual({
      resource: "https://commissary.test/mcp",
      authorization_servers: ["https://commissary.test"],
      bearer_methods_supported: ["header"],
      resource_name: "Commissary",
    });
  });

  it("counts against the org's request-rate ceiling", async () => {
    const { key } = await keyedOrg("mcp-busy@example.com");
    const signedIn = { authorization: `Bearer ${key}` };

    await roomInWindow();

    for (let sent = 0; sent < FREE_LIMIT; sent += 1) {
      const served = await listTools(signedIn);

      expect(served.status).toBe(200);
      await served.body?.cancel();
    }

    const limited = await listTools(signedIn);

    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(await limited.json()).toEqual({ error: RATE_LIMITED });
  });
});
