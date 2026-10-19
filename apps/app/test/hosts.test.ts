// Where the client API is, as the app Worker tells it (src/http/hosts.ts, ADR 0028, ADR 0030): the API Worker serves
// it (apps/api), on the API host when the deployment has one, so the app Worker refuses every client API path with a
// 404 that says where it is, and serves everything else on any host. End to end through the Worker's default export
// with the host settings bound (dev bypass on `localhost`, see vitest.config.ts).
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { apiOrigin } from "../src/http/hosts.ts";
import worker from "../src/index.ts";

const CLIENT_API_PATHS = [
  "/v1/models",
  "/v1beta/models",
  "/responses",
  "/%76%31/models",
  "//V1/models",
  "/backend-api/codex/responses",
  "/mcp",
];

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

/** The status and body of the answer to `url` with the host settings `hosts`. */
const answer = async (url: string, hosts: Partial<Env>) => {
  const response = await send(url, hosts);

  return { status: response.status, body: await response.json<{ error: string }>() };
};

describe("the app Worker and the client API", () => {
  it("refuses the client API on any host, naming the API Worker without an API host", async () => {
    for (const host of ["localhost", "other.example.com"])
      for (const path of CLIENT_API_PATHS)
        expect(await answer(`http://${host}${path}`, {}), `${host}${path}`).toEqual({
          status: 404,
          body: { error: "Not found: the client API is served by the API Worker" },
        });
  });

  it("refuses the client API on any host, naming the API host when there is one", async () => {
    for (const host of ["localhost", "api.example.com"])
      for (const path of CLIENT_API_PATHS)
        expect(
          await answer(`http://${host}${path}`, { API_DOMAIN: "api.example.com" }),
          `${host}${path}`,
        ).toEqual({
          status: 404,
          body: { error: "Not found: the client API is served at https://api.example.com" },
        });
  });

  it("names the API host as an https origin", () => {
    expect(apiOrigin({})).toBeUndefined();
    expect(apiOrigin({ API_DOMAIN: " " })).toBeUndefined();
    expect(apiOrigin({ API_DOMAIN: " API.example.com " })).toBe("https://api.example.com");
  });
});

describe("a Worker with an API host", () => {
  it("serves the panel and the management API and tells the panel the API host", async () => {
    const hosts = { API_DOMAIN: "api.example.com" };
    const me = await send("http://localhost/v9/management/me", hosts);

    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ api_url: "https://api.example.com" });
    expect((await send("http://localhost/healthz", hosts)).status).toBe(200);
  });

  it("says nothing of an API host without one", async () => {
    const me = await send("http://localhost/v9/management/me", {});

    expect(me.status).toBe(200);
    expect(await me.json()).not.toHaveProperty("api_url");
  });
});
