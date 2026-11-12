// Cross-site request forgery and cross-site WebSocket hijacking protections of the API Worker's client gate
// (`@commissary/auth`'s `crossSiteRejection`, src/http/gate.ts), through the production Worker's `exports.default.fetch`
// (dev bypass on localhost, see vitest.config.ts): client API writes and Responses WebSocket upgrades. The decision
// table is tested with the app Worker (apps/app/test/access-csrf.test.ts).
import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { resetControlPlane } from "@commissary/models/testing";

const LOCAL = "http://localhost";

const worker = (path: string, init: RequestInit = {}) =>
  exports.default.fetch(new Request(`${LOCAL}${path}`, init));

const errorOf = async (response: Response) => ((await response.json()) as { error: unknown }).error;

describe("Worker entry point: cross-site protections", () => {
  beforeEach(async () => {
    await resetControlPlane();
  });

  it("refuses cross-site client API writes but keeps CORS for reads", async () => {
    const forged = await worker("/v1/chat/completions", {
      method: "POST",
      headers: { origin: "https://evil.test", "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });

    expect(forged.status).toBe(403);
    expect(forged.headers.get("access-control-allow-origin")).toBe("*");
    await forged.body?.cancel();

    const models = await worker("/v1/models", { headers: { origin: "https://app.test" } });
    expect(models.status).toBe(200);
    expect(models.headers.get("access-control-allow-origin")).toBe("*");
    await models.body?.cancel();
  });

  it("refuses cross-origin Responses WebSocket upgrades and accepts same-origin and Origin-less ones", async () => {
    for (const path of ["/v1/responses", "/backend-api/codex/responses"]) {
      const hijack = await worker(path, {
        headers: { upgrade: "websocket", origin: "https://evil.test" },
      });

      expect(hijack.status).toBe(403);
      expect(hijack.webSocket).toBeNull();
      expect(await errorOf(hijack)).toBe("Cross-origin WebSocket rejected");

      for (const headers of [{ upgrade: "websocket" }, { upgrade: "websocket", origin: LOCAL }]) {
        const accepted = await worker(path, { headers });
        expect(accepted.status).toBe(101);
        const socket = accepted.webSocket;
        expect(socket).not.toBeNull();
        socket?.accept();
        socket?.close(1000, "done");
      }
    }
  });
});
