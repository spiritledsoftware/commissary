// The management routes mounted in the real application layer (`makeWebHandler`), reached through the local Access
// dev bypass: what `alchemy dev` does for the panel.
import { env } from "cloudflare:workers";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { makeWebHandler } from "../src/http/app.ts";
import { requestContext } from "../src/worker-env.ts";
import { claudeFile, resetControlPlane } from "./support/management.ts";
import { FULL_ACCESS } from "@commissary/models/testing";

const app = makeWebHandler();

afterAll(app.dispose);

const PANEL_HTML =
  "<!doctype html><html><head><title>Commissary panel</title></head><body></body></html>";

const bindings = {
  ...env,
  ACCESS_DEV_BYPASS: "admin@example.com",
  ASSETS: {
    fetch: async () => new Response(PANEL_HTML, { headers: { "content-type": "text/html" } }),
  } as unknown as Fetcher,
};

const ctx = {} as unknown as ExecutionContext;

const get = (path: string, base = "http://localhost:8787") =>
  app.handler(new Request(`${base}${path}`), requestContext(bindings, ctx));

describe("control panel in the application", () => {
  it("loads the panel and lists credentials like the panel does", async () => {
    await resetControlPlane();
    await env.CONTROL_PLANE.getByName("global")
      .models()
      .importAuthFile("claude-a.json", JSON.stringify(claudeFile()), {}, FULL_ACCESS);

    // The only org of the caller opens at its own address.
    const root = await get("/");
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("/o/default/");

    const page = await get("/o/default/");
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(PANEL_HTML);

    // The old panel's address (bookmarks) sends the browser to the panel.
    const legacy = await get("/management.html");
    expect(legacy.status).toBe(302);
    expect(legacy.headers.get("location")).toBe("/");

    const list = await get("/v9/management/credentials");
    expect(list.status).toBe(200);
    const body = (await list.json()) as { files: Array<{ name: string; type: string }> };
    expect(body.files).toMatchObject([{ name: "claude-a.json", type: "claude" }]);
    expect((await get("/v9/management/settings")).status).toBe(200);
  });

  it("answers the old /v8 prefix with 404: no aliases", async () => {
    for (const path of [
      "/v8/management/credentials",
      "/v8/management/settings",
      "/v8/management/orgs/default/credentials",
    ])
      expect((await get(path)).status, path).toBe(404);
  });

  it("does not apply the dev bypass to non-loopback hosts", async () => {
    // No Access settings in these bindings: the gate fails closed (500 Authentication service error) instead of
    // redirecting or bypassing.
    for (const path of ["/", "/management.html", "/v9/management/credentials"]) {
      const response = await get(path, "https://proxy.example.com");

      expect(response.status, path).toBe(500);
      // The legacy redirect is gated too: no Location leaks past the gate.
      expect(response.headers.get("location"), path).toBeNull();
    }
  });
});
