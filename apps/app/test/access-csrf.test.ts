// Cross-site request forgery and cross-site WebSocket hijacking protections of the Access gate (packages/auth/src/csrf.ts, with the Worker's routes in src/access/csrf.ts):
// the pure decision table, then the production Worker through `exports.default.fetch` (dev bypass on localhost, see
// vitest.config.ts) for the panel and management writes. The client API's are the API Worker's
// (apps/api/test/access-csrf.test.ts).
import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { crossSiteRejection } from "../src/access/csrf.ts";
import { resetControlPlane } from "./support/management.ts";

const ORIGIN = "https://proxy.example.com";

type Zone = "protected" | "management";

const check = (
  method: string,
  path: string,
  headers: Record<string, string> = {},
  zone: Zone = "protected",
) => crossSiteRejection(method, headers, `${ORIGIN}${path}`, zone)?.status;

const write = (method: string, path: string, headers: Record<string, string>) =>
  check(method, path, headers, "management");

describe("crossSiteRejection", () => {
  it("lets non-browser clients through (no Origin, no Sec-Fetch-*)", () => {
    expect(
      check("POST", "/v1/chat/completions", { "content-type": "application/json" }),
    ).toBeUndefined();
    expect(check("POST", "/v1/messages", {})).toBeUndefined();
    expect(check("GET", "/v1/responses", { upgrade: "websocket" })).toBeUndefined();
    expect(
      check(
        "POST",
        "/v9/management/settings/import",
        { "content-type": "application/yaml" },
        "management",
      ),
    ).toBe(undefined);
  });

  it("lets same-origin browser requests through", () => {
    const sameOrigin = {
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    };

    expect(check("POST", "/v1/chat/completions", sameOrigin)).toBeUndefined();
    expect(
      check("POST", "/v9/management/provider-keys/probe", sameOrigin, "management"),
    ).toBeUndefined();
    expect(
      check("GET", "/v9/management/settings", { "sec-fetch-site": "same-origin" }, "management"),
    ).toBeUndefined();
    expect(check("GET", "/v1/responses", { upgrade: "websocket", origin: ORIGIN })).toBeUndefined();
    // A user typing the URL / a bookmark.
    expect(
      check(
        "GET",
        "/accounts",
        { "sec-fetch-site": "none", "sec-fetch-mode": "navigate" },
        "management",
      ),
    ).toBeUndefined();
  });

  it("refuses state-changing cross-site requests on protected and management zones", () => {
    for (const zone of ["protected", "management"] as const) {
      const path =
        zone === "protected" ? "/v1/chat/completions" : "/v9/management/provider-keys/probe";

      const json = { "content-type": "application/json" };
      expect(check("POST", path, { ...json, origin: "https://evil.test" }, zone)).toBe(403);
      expect(check("POST", path, { ...json, origin: "null" }, zone)).toBe(403);
      expect(
        check("POST", path, { ...json, origin: "https://proxy.example.com.evil.test" }, zone),
      ).toBe(403);
      expect(check("POST", path, { ...json, "sec-fetch-site": "cross-site" }, zone)).toBe(403);
      expect(check("POST", path, { ...json, "sec-fetch-site": "same-site" }, zone)).toBe(403);
      expect(check("DELETE", path, { origin: "https://evil.test" }, zone)).toBe(403);
    }

    // Reads of the client API from other origins stay possible (CORS `*` without credentials).
    expect(
      check("GET", "/v1/models", { origin: "https://app.test", "sec-fetch-site": "cross-site" }),
    ).toBeUndefined();
  });

  it("refuses cross-origin WebSocket upgrades", () => {
    const upgrade = { upgrade: "websocket", connection: "Upgrade" };
    expect(check("GET", "/v1/responses", { ...upgrade, origin: "https://evil.test" })).toBe(403);
    expect(
      check("GET", "/backend-api/codex/responses", {
        ...upgrade,
        origin: "http://proxy.example.com:8080",
      }),
    ).toBe(403);
    expect(check("GET", "/v1/responses", { ...upgrade, origin: "null" })).toBe(403);
  });

  it("refuses cross-site management reads except top-level navigations", () => {
    expect(
      check("GET", "/v9/management/settings", { origin: "https://evil.test" }, "management"),
    ).toBe(403);
    expect(
      check("GET", "/v9/management/settings", { "sec-fetch-site": "cross-site" }, "management"),
    ).toBe(403);

    // `queue` pops records on GET: an <img> from another site must not reach it.
    const image = {
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "no-cors",
      "sec-fetch-dest": "image",
    };

    expect(check("GET", "/v9/management/observability/usage/queue", image, "management")).toBe(403);

    const link = {
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    };

    expect(check("GET", "/accounts", link, "management")).toBeUndefined();
    expect(check("GET", "/", link, "management")).toBeUndefined();
    expect(check("GET", "/Settings/Config", link, "management")).toBeUndefined();
    expect(check("HEAD", "/management.html", link, "management")).toBeUndefined();
    expect(check("GET", "//Management.HTML", link, "management")).toBeUndefined();
  });

  it("exempts only top-level document navigations to panel pages", () => {
    const link = {
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    };

    // A frame is a navigation too, but another site must not embed the panel (clickjacking).
    for (const dest of ["iframe", "frame", "embed", "object", ""])
      expect(check("GET", "/accounts", { ...link, "sec-fetch-dest": dest }, "management")).toBe(
        403,
      );

    // The management API has no page to open from another site, OAuth callbacks included (providers redirect to the
    // public callback paths); nor do the bundle files.
    for (const path of [
      "/v9/management/settings",
      "/v9/management/oauth/callback?provider=claude&state=s&code=c",
      "/v9/management/credentials/download?name=a.json",
      "/V9/Management/Settings",
      "/assets/index.js",
    ])
      expect(check("GET", path, link, "management")).toBe(403);

    // A navigation is GET or HEAD only.
    expect(check("POST", "/accounts", link, "management")).toBe(403);
  });

  it("requires JSON (multipart for uploads, YAML for the config import) on management writes", () => {
    expect(
      write("POST", "/v9/management/provider-keys/probe", {
        "content-type": "application/json; charset=utf-8",
      }),
    ).toBeUndefined();
    expect(
      write("PATCH", "/v9/management/settings", {
        "content-type": "application/merge-patch+json",
      }),
    ).toBeUndefined();
    expect(
      write("POST", "/v9/management/provider-keys/probe", { "content-type": "text/plain" }),
    ).toBe(415);
    expect(
      write("POST", "/v9/management/provider-keys/probe", {
        "content-type": "application/x-www-form-urlencoded",
      }),
    ).toBe(415);
    expect(
      write("POST", "/v9/management/credentials", {
        "content-type": "multipart/form-data; boundary=x",
      }),
    ).toBe(undefined);
    expect(
      write("POST", "/v9/management/oauth/callback", {
        "content-type": "multipart/form-data; boundary=x",
      }),
    ).toBe(415);
    expect(
      write("POST", "/v9/management/settings/import", { "content-type": "text/yaml" }),
    ).toBeUndefined();
    expect(write("PATCH", "/v9/management/settings", { "content-type": "application/yaml" })).toBe(
      415,
    );
    expect(write("POST", "/v9/management/settings/import", { "content-type": "text/plain" })).toBe(
      415,
    );
    // Bodies without a type are refused; bodiless writes (`DELETE ?name=`, `POST .../refresh`) are fine.
    expect(write("POST", "/v9/management/provider-keys/probe", { "content-length": "12" })).toBe(
      415,
    );
    expect(
      write("POST", "/v9/management/credentials/refresh", { "transfer-encoding": "chunked" }),
    ).toBe(415);
    expect(write("DELETE", "/v9/management/credentials", {})).toBeUndefined();
    expect(
      write("POST", "/v9/management/credentials/refresh", { "content-length": "0" }),
    ).toBeUndefined();
  });
});

// --- production Worker ----------------------------------------------------------------------------------------------

const LOCAL = "http://localhost";

const worker = (path: string, init: RequestInit = {}) =>
  exports.default.fetch(new Request(`${LOCAL}${path}`, init));

const errorOf = async (response: Response) => ((await response.json()) as { error: unknown }).error;

describe("Worker entry point: cross-site protections", () => {
  beforeEach(async () => {
    await resetControlPlane();
  });

  it("serves the panel and its same-origin JSON requests", async () => {
    const navigate = {
      "sec-fetch-site": "none",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    };

    const panel = await worker("/accounts", { headers: navigate });

    expect(panel.status).not.toBe(403);
    expect(panel.headers.get("access-control-allow-origin")).toBeNull();
    await panel.body?.cancel();

    // A bookmark of the old panel lands on the new one.
    const legacy = await worker("/management.html", { headers: navigate, redirect: "manual" });

    expect(legacy.status).toBe(302);
    expect(legacy.headers.get("location")).toBe("/");
    expect(legacy.headers.get("access-control-allow-origin")).toBeNull();

    const panelHeaders = {
      origin: LOCAL,
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
    };

    const config = await worker("/v9/management/settings", { headers: panelHeaders });
    expect(config.status).toBe(200);
    expect(config.headers.get("access-control-allow-origin")).toBeNull();
    await config.body?.cancel();

    // A same-origin JSON write reaches the handler.
    const patch = await worker("/v9/management/settings", {
      method: "PATCH",
      headers: { ...panelHeaders, "content-type": "application/json" },
      body: JSON.stringify({ revisions: {}, patch: { routing: { "session-affinity": true } } }),
    });

    expect(patch.status).toBe(200);
    await patch.body?.cancel();

    const yaml = await worker("/v9/management/settings/import", {
      method: "POST",
      headers: { ...panelHeaders, "content-type": "application/yaml" },
      body: "routing:\n  strategy: fill-first\n",
    });

    expect(yaml.status).toBe(200);
    await yaml.body?.cancel();
  });

  it("keeps management working for curl-style clients without Origin", async () => {
    const response = await worker("/v9/management/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revisions: {}, patch: { routing: { strategy: "fill-first" } } }),
    });

    expect(response.status).toBe(200);
    await response.body?.cancel();
  });

  it("refuses forged management writes from other sites before they reach a handler", async () => {
    const forged = await worker("/v9/management/settings", {
      method: "PATCH",
      headers: {
        origin: "https://evil.test",
        "sec-fetch-site": "cross-site",
        "content-type": "text/plain",
      },
      body: JSON.stringify({ access: { "admin-emails": ["evil@evil.test"] } }),
    });

    expect(forged.status).toBe(403);
    expect(await errorOf(forged)).toBe("Cross-site request rejected");
    expect(forged.headers.get("access-control-allow-origin")).toBeNull();

    const upload = new FormData();
    upload.append("file", new File(['{"type":"claude","access_token":"x"}'], "claude-evil.json"));

    const forgedUpload = await worker("/v9/management/credentials", {
      method: "POST",
      headers: { origin: "https://evil.test" },
      body: upload,
    });

    expect(forgedUpload.status).toBe(403);
    await forgedUpload.body?.cancel();
    const list = await worker("/v9/management/credentials");
    expect(JSON.stringify(await list.json())).not.toContain("claude-evil");

    // Simple (preflight-free) content types are refused even without browser headers.
    const simple = await worker("/v9/management/settings", {
      method: "PATCH",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "routing=x",
    });

    expect(simple.status).toBe(415);
    await simple.body?.cancel();

    // Cross-origin preflights get no CORS grant, so browsers never send the real request.
    const preflight = await worker("/v9/management/settings", {
      method: "OPTIONS",
      headers: { origin: "https://evil.test", "access-control-request-method": "POST" },
    });

    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
  });
});
