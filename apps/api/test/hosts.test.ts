// What the API Worker serves (src/http/hosts.ts, ADR 0028, ADR 0030): the client API and `/healthz`, wherever it
// answers (the API host, zone routes on the app host, a workers.dev URL); every other path is the app Worker's and is
// refused with a 404 that names the app host when there is one. Unit tests of the decision, and end to end through
// the Worker's default export with the host settings bound (dev bypass on `localhost`, see vitest.config.ts).
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { misdirected } from "../src/http/hosts.ts";
import worker from "../src/index.ts";

const SPLIT = { APP_DOMAIN: "app.example.com", API_DOMAIN: "api.example.com" };

const APP_PATHS = [
  "/",
  "/accounts",
  "/o/acme/accounts",
  "/assets/index.js",
  "/v9/management/me",
  "/v9/management/orgs/acme/config",
  "/sign-in",
  "/api/auth/get-session",
  "/management.html",
  "/nope",
];

const refusal = async (url: string, hosts: Partial<Env>) => {
  const response = misdirected(url, hosts);

  return response === undefined
    ? undefined
    : { status: response.status, body: await response.json<{ error: string }>() };
};

describe("host routing", () => {
  it("serves the client API and /healthz on any host, and nothing else", async () => {
    for (const host of ["API.example.com", "app.example.com"])
      for (const path of [
        "/v1/models",
        "/v1beta/models",
        "/v1internal:generateContent",
        "/openai/v1/chat/completions",
        "/backend-api/codex/responses",
        "/chat/completions",
        "/completions",
        "/responses",
        "/mcp",
        "/healthz",
        "/.well-known/oauth-protected-resource/mcp",
        "//V1/models",
        "/%76%31/models",
      ])
        expect(misdirected(`https://${host}${path}`, SPLIT), `${host}${path}`).toBeUndefined();

    for (const path of APP_PATHS)
      expect(await refusal(`https://api.example.com${path}`, SPLIT), path).toEqual({
        status: 404,
        body: {
          error:
            "Not found: api.example.com serves the client API only; the control panel and the management API are at https://app.example.com",
        },
      });
  });

  it("names no host it does not know", async () => {
    for (const path of APP_PATHS)
      expect(await refusal(`https://api-pr-1.example.workers.dev${path}`, {}), path).toEqual({
        status: 404,
        body: { error: "Not found: this host serves the client API only" },
      });
  });
});

/** A request to the Worker with the host settings `hosts` bound. */
const send = async (url: string, hosts: Partial<Env>, init?: RequestInit) => {
  const ctx = createExecutionContext();

  // SAFETY: the default export reads no `cf` property of the request; workerd's own requests carry them.
  const request = new Request(url, { redirect: "manual", ...init }) as Request<
    unknown,
    IncomingRequestCfProperties
  >;

  const response = await worker.fetch(request, { ...env, ...hosts }, ctx);
  await waitOnExecutionContext(ctx);

  return response;
};

describe("an API Worker with an API host", () => {
  it("serves the client API and /healthz only", async () => {
    const hosts = { APP_DOMAIN: "app.example.com", API_DOMAIN: "localhost" };
    const models = await send("http://localhost/v1/models", hosts);

    expect(models.status).toBe(200);
    expect((await send("http://localhost/healthz", hosts)).status).toBe(200);

    // The MCP endpoint's OAuth metadata goes on to the router, which knows it only on Commissary Cloud (#200).
    expect(
      (await send("http://localhost/.well-known/oauth-protected-resource/mcp", hosts)).status,
    ).toBe(404);

    for (const path of ["/", "/v9/management/me", "/.well-known/oauth-authorization-server"]) {
      const response = await send(`http://localhost${path}`, hosts);

      expect(response.status, path).toBe(404);
      expect(await response.json(), path).toEqual({
        error:
          "Not found: localhost serves the client API only; the control panel and the management API are at https://app.example.com",
      });
    }
  });
});
