// The app Worker's own routes: `/healthz`, the panel at `/`, and the plain 404 of unknown routes. It answers no CORS
// (src/http/not-found.ts): the client API, which does, is the API Worker's (apps/api/test/routes.test.ts).
import { exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

const fetchWorker = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(`https://commissary.test${path}`, init));

// The first request in this file starts the whole app Worker. Under CI load that start alone has run past the 30 s
// test timeout, failing whichever test came first, so it gets its own, longer budget here.
beforeAll(async () => {
  await (await fetchWorker("/healthz")).text();
}, 120_000);

describe("GET /healthz", () => {
  it("returns {status:ok} as JSON", async () => {
    const response = await fetchWorker("/healthz");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await response.text()).toBe('{"status":"ok"}');
  });

  it("HEAD returns 200 with an empty body", async () => {
    const response = await fetchWorker("/healthz", { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });
});

describe("GET /", () => {
  it("is the control panel, gated like the management API (no public banner)", async () => {
    // commissary.test has no Access settings, so the management zone fails closed.
    const response = await fetchWorker("/");
    expect(response.status).toBeGreaterThanOrEqual(401);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("unknown routes", () => {
  it("answer the plain 404, with no CORS headers", async () => {
    for (const init of [undefined, { method: "OPTIONS", headers: { origin: "https://x.test" } }]) {
      const response = await fetchWorker("/nope", init);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("404 page not found");
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
  });
});
