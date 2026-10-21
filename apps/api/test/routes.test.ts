import { exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { CORS_EXPOSED_RESPONSE_HEADERS } from "../src/http/cors.ts";

// The API Worker's own routes and its CORS (src/http/cors.ts). `localhost` gets the dev bypass (vitest.config.ts).
const fetchWorker = (path: string, init?: RequestInit, origin = "https://commissary.test") =>
  exports.default.fetch(new Request(`${origin}${path}`, init));

// The first request in this file loads the API Worker's module graph. Under CI load that alone has run past the 30 s
// test timeout, failing whichever test came first, so it gets its own, longer budget here (as apps/app's does).
beforeAll(async () => {
  await (await fetchWorker("/healthz")).text();
}, 120_000);

const expectCors = (response: Response) => {
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  expect(response.headers.get("access-control-allow-methods")).toBe(
    "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  );
  expect(response.headers.get("access-control-allow-headers")).toBe("*");
  expect(response.headers.get("access-control-expose-headers")).toBe(
    CORS_EXPOSED_RESPONSE_HEADERS.join(", "),
  );
};

describe("GET /healthz", () => {
  it("returns {status:ok} as JSON", async () => {
    const response = await fetchWorker("/healthz");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await response.text()).toBe('{"status":"ok"}');
    expectCors(response);
  });

  it("HEAD returns 200 with an empty body", async () => {
    const response = await fetchWorker("/healthz", { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expectCors(response);
  });
});

describe("CORS", () => {
  it("answers OPTIONS on a known path with an empty 204", async () => {
    const response = await fetchWorker("/healthz", { method: "OPTIONS" });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expectCors(response);
  });

  it("answers OPTIONS on an unknown path with an empty 204", async () => {
    const response = await fetchWorker("/v1/chat/completions", {
      method: "OPTIONS",
      headers: { origin: "https://x.test" },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expectCors(response);
  });

  it("adds CORS headers to unknown routes of the client API (404)", async () => {
    const response = await fetchWorker("/v1/nope", undefined, "http://localhost");
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("404 page not found");
    expectCors(response);
  });
});
