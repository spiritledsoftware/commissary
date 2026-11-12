// The removed upstream-panel routes (api-call, latest-version, log stubs, model definitions, ...) and the legacy panel redirect.
import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { jsonInit, makeHarness, resetControlPlane, token } from "./support/management.ts";

const harness = makeHarness((request) => ({
  status: 201,
  body: { method: request.method, url: request.url },
}));

afterAll(harness.dispose);

beforeEach(async () => {
  harness.requests.length = 0;
  await resetControlPlane();
});

const { call } = harness;

describe("api-call", () => {
  // Go's token-substituting upstream probe served only the upstream panel; quota and key checks run server-side.
  it("is not ported: 404 for administrators, still behind the admin gate", async () => {
    const body = {
      method: "GET",
      url: "https://api.example.com/q",
      header: { Authorization: "Bearer $TOKEN$" },
    };

    const admin = await call("/v9/management/requests/api-call", jsonInit("POST", body));

    expect(admin.status).toBe(404);
    expect(
      (await call("/v9/management/requests/api-call", { ...jsonInit("POST", body), auth: false }))
        .status,
    ).toBe(401);
    expect(
      (
        await call("/v9/management/requests/api-call", {
          ...jsonInit("POST", body),
          auth: await token("other@example.com"),
        })
      ).status,
    ).toBe(403);
    expect(harness.requests).toHaveLength(0);
  });
});

describe("routes that only the upstream panel called", () => {
  const gone: ReadonlyArray<readonly [method: string, path: string]> = [
    ["GET", "/v9/management/server/latest-version"],
    ["GET", "/v9/management/observability/logs"],
    ["DELETE", "/v9/management/observability/logs"],
    ["GET", "/v9/management/observability/logs/errors"],
    ["GET", "/v9/management/observability/logs/errors/error-1.log"],
    ["GET", "/v9/management/observability/logs/requests/abc"],
    ["GET", "/v9/management/routing/model-definitions/claude"],
    ["GET", "/v9/management/routing/model-definitions?channel=claude"],
    ["GET", "/v9/management/observability/usage/api-keys"],
    ["GET", "/v9/management/oauth/callback?provider=codex&state=s&code=c"],
    ["GET", "/v9/management/plugins"],
  ];

  it("answers 404 to administrators and still sits behind the admin gate", async () => {
    for (const [method, path] of gone) {
      expect((await call(path, { method })).status, `${method} ${path}`).toBe(404);
      expect((await call(path, { method, auth: false })).status, `${method} ${path}`).toBe(401);
    }

    // Nothing was fetched on the way (the release lookup is gone).
    expect(harness.requests).toHaveLength(0);
  });

  it("sends no X-CPA-* headers on management replies", async () => {
    const { headers } = await call("/v9/management/settings");

    expect(headers.get("cache-control")).toBe("no-store");
    expect(headers.get("x-cpa-version")).toBeNull();
    expect(headers.get("x-cpa-support-plugin")).toBeNull();
  });
});

describe("legacy panel address", () => {
  // `/management.html` was the upstream panel; it now sends bookmarks to the control panel at `/`.
  const spellings = [
    "/management.html",
    "/Management.HTML",
    "/management%2Ehtml",
    "//management.html",
    "/%6Danagement.html",
  ];

  it("redirects administrators to / without caching, for every spelling, GET and HEAD", async () => {
    for (const path of spellings)
      for (const method of ["GET", "HEAD"]) {
        const response = await call(path, { method, redirect: "manual" });

        expect(response.status, `${method} ${path}`).toBe(302);
        expect(response.headers.get("location"), path).toBe("/");
        expect(response.headers.get("cache-control"), path).toBe("no-store");
        expect(response.headers.get("access-control-allow-origin"), path).toBeNull();
      }
  });

  it("stays behind Access, and redirects anyone it admits (the panel decides what they see)", async () => {
    for (const path of spellings) {
      expect((await call(path, { auth: false })).status, path).toBe(401);
      expect((await call(path, { auth: await token("other@example.com") })).status, path).toBe(302);
    }
  });
});
