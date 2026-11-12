// The auth host's own routes and CORS (src/http/cors.ts, src/http/routes.ts): the sign-in page and the panel on the app
// host call it with credentials, so it answers that one origin, and no other; `/healthz` and Better Auth's health check
// answer for the deploy checks (tools/check-cloud-deploy.sh).
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { APP_ORIGIN, call, installFakes, restoreFetch } from "./support.ts";

beforeAll(installFakes);

afterAll(restoreFetch);

const preflight = (origin: string, method = "POST") =>
  call("/api/auth/sign-in/social", {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": method,
      "access-control-request-headers": "content-type, x-captcha-response",
    },
  });

describe("CORS", () => {
  it("allows the app origin's preflight with credentials", async () => {
    const response = await preflight(APP_ORIGIN);

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, POST");
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "content-type, x-captcha-response",
    );
  });

  it("refuses a preflight from any other origin, or for another method", async () => {
    for (const response of [
      await preflight("https://evil.example"),
      await preflight("https://auth.commissary.test.evil.example"),
      await preflight(APP_ORIGIN, "DELETE"),
    ]) {
      expect(response.status).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("lets the app origin read the answers, and no other origin", async () => {
    const fromApp = await call("/api/sign-in-options", { headers: { origin: APP_ORIGIN } });

    expect(fromApp.status).toBe(200);
    expect(fromApp.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    expect(fromApp.headers.get("access-control-allow-credentials")).toBe("true");

    const elsewhere = await call("/api/sign-in-options", {
      headers: { origin: "https://evil.example" },
    });

    expect(elsewhere.status).toBe(200);
    expect(elsewhere.headers.get("access-control-allow-origin")).toBeNull();
    expect(elsewhere.headers.get("vary")).toContain("Origin");
  });
});

describe("health", () => {
  it("answers /healthz and Better Auth's health check", async () => {
    const health = await call("/healthz");

    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });

    const ok = await call("/api/auth/ok");

    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
  });
});
