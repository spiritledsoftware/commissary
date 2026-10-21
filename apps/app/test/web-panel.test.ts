// The `apps/web` control panel: `index.html` for `/` and every page path, bundle files under `/assets`, all behind the
// Access admin gate (src/management/web-panel.ts, src/management/zones.ts).
import { afterAll, describe, expect, it } from "vitest";
import { classifyPath } from "../src/management/zones.ts";
import { PANEL_CSP, PANEL_NOT_BUILT } from "../src/management/web-panel.ts";
import { isolatedPlatform, makeHarness, token } from "./support/management.ts";

const INDEX_HTML =
  '<!doctype html><html><head><script type="module" src="/assets/index-abc.js"></script></head></html>';

const fetched: string[] = [];

const assets = (built: boolean) =>
  ({
    fetch: async (request: Request) => {
      const path = new URL(request.url).pathname;
      fetched.push(path);

      if (!built) return new Response("not found", { status: 404 });

      if (path === "/")
        return new Response(INDEX_HTML, { headers: { "content-type": "text/html" } });

      if (path === "/assets/index-abc.js") {
        return new Response("export {}", {
          headers: {
            "content-type": "text/javascript",
            "cache-control": "public, max-age=31536000, immutable",
            etag: '"js"',
          },
        });
      }

      return new Response("not found", { status: 404 });
    },
  }) as unknown as Fetcher;

const built = makeHarness(undefined, { ASSETS: assets(true) });

const missing = makeHarness(undefined, { ASSETS: assets(false) });

// A deployment with a second org: the panel cannot pick one for the platform admin.
const several = isolatedPlatform();

const chooser = makeHarness(undefined, { ASSETS: assets(true), ...several.bindings });

afterAll(async () => {
  await built.dispose();
  await missing.dispose();
  await chooser.dispose();
});

describe("web panel", () => {
  it.each([
    "/o/default",
    "/o/default/",
    "/o/default/accounts",
    "/o/default/accounts/claude-a.json",
    "/o/default/keys",
    "/o/default/models",
    "/o/default/usage",
    "/o/default/approvals",
    // A pending approval's page, the link a waiting tool call answers with (#201).
    "/o/default/approvals/ap_0123456789abcdef01234567",
    // The billing page a plan_limit_reached refusal links to (#239).
    "/o/default/billing",
    // The Tools pages (#208), and the connect page a tool call that needs a private credential links to (#197).
    "/o/default/tools",
    "/o/default/tools/add",
    "/o/default/tools/tk_0123456789abcdef/connect",
    "/o/default/tools/sessions/0123456789abcdef",
    // The Browser profiles page (#217).
    "/o/default/tools/profiles",
    // The tools a member reaches and why (#209).
    "/o/default/my-tools",
    // The Agents pages (#233): the list, a new agent and an agent's page.
    "/o/default/agents",
    "/o/default/agents/new",
    "/o/default/agents/ag_0123456789abcdef",
    "/o/default/settings/",
    "/o/DEFAULT/Settings",
  ])("serves index.html for %s with the panel's security headers", async (path) => {
    fetched.length = 0;
    const response = await built.call(path);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(INDEX_HTML);
    expect(fetched).toEqual(["/"]);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toBe(PANEL_CSP);
    // The only frame the panel embeds: a browser session's Live View (#216).
    expect(PANEL_CSP).toContain("frame-src https://live.browser.run;");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("passes bundle files through with their caching headers", async () => {
    const response = await built.call("/assets/index-abc.js");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("export {}");
    expect(response.headers.get("content-type")).toBe("text/javascript");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("etag")).toBe('"js"');
    expect((await built.call("/assets/nope.js")).status).toBe(404);
  });

  it("says so when the panel is not built", async () => {
    const response = await missing.call("/o/default/accounts");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: PANEL_NOT_BUILT });
  });

  it.each([
    ["/", "/o/default/"],
    ["/accounts", "/o/default/accounts"],
    ["/accounts/claude-a.json?x=1", "/o/default/accounts/claude-a.json?x=1"],
    ["/settings/", "/o/default/settings/"],
  ])("sends %s to the only org of the caller: %s", async (path, target) => {
    fetched.length = 0;
    const response = await built.call(path);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(target);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fetched).toEqual([]);
  });

  it("serves the panel at an address without an org when the caller has several to choose from", async () => {
    expect((await several.platform.createOrg({ slug: "acme", name: "Acme" }, 1)).ok).toBe(true);

    for (const path of ["/", "/accounts", "/settings"]) {
      fetched.length = 0;
      const response = await chooser.call(path);

      expect(response.status, path).toBe(200);
      expect(await response.text()).toBe(INDEX_HTML);
    }

    // An address with an org is served as it is.
    expect((await chooser.call("/o/acme/accounts")).status).toBe(200);
    expect((await chooser.call("/o/default/accounts")).status).toBe(200);
  });

  it("serves the chooser to a caller of one org that asks for it with ?choose", async () => {
    fetched.length = 0;
    const response = await built.call("/?choose");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(INDEX_HTML);
  });

  it("serves the panel of an org to a platform admin only for orgs that exist", async () => {
    expect((await built.call("/o/nobody/accounts")).status).toBe(404);
    expect(
      (await built.call("/o/nobody/accounts", { auth: await token("user@example.com") })).status,
    ).toBe(403);
  });

  it("is served to the members of an org only", async () => {
    expect((await built.call("/", { auth: false })).status).toBe(401);
    expect((await built.call("/assets/index-abc.js", { auth: false })).status).toBe(401);
    expect((await built.call("/o/default/accounts", { auth: false })).status).toBe(401);

    // `global` lets everyone Access admits join as a plain member; an org with auto-join off does not.
    expect((await several.platform.createOrg({ slug: "closed", name: "Closed" }, 1)).ok).toBe(true);
    const user = { auth: await token("panel-user@example.com") };

    expect((await chooser.call("/o/default/usage", user)).status).toBe(200);
    expect((await chooser.call("/o/closed/usage", user)).status).toBe(403);

    // Without an org in the address, the panel goes to the only org they belong to.
    const usage = await chooser.call("/usage", user);

    expect(usage.status).toBe(302);
    expect(usage.headers.get("location")).toBe("/o/default/usage");
  });

  it("classifies the panel paths as management and leaves look-alikes alone", () => {
    for (const path of [
      "/",
      "/accounts",
      "/Accounts/x",
      "/assets/a.js",
      "/settings/",
      "//keys",
      "/o/default/accounts",
      "/o/acme",
    ]) {
      expect(classifyPath(`https://x.test${path}`)).toBe("management");
    }

    for (const path of ["/healthz", "/accountsx", "/nope", "/key"]) {
      expect(classifyPath(`https://x.test${path}`)).toBe("public");
    }
  });
});
