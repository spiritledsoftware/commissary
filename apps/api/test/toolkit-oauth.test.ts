// Commissary's Client ID Metadata Document of toolkits' OAuth sign-ins (#202): a client API path of the API Worker
// (`TOOLKIT_OAUTH_CLIENT_PATH`), served without an API key to the authorization servers that fetch it, on the API host
// and through the app host's zone route alike. Its `client_id` is its own URL, its one redirect URI the callback on the
// app host; a Worker that does not know the app host (a preview) serves none.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { isClientApiPath, TOOLKIT_OAUTH_CLIENT_PATH } from "@commissary/core";
import { misdirected } from "../src/http/hosts.ts";
import worker from "../src/index.ts";

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

const SPLIT = { APP_DOMAIN: "app.example.com", API_DOMAIN: "api.example.com" };

describe("Commissary's CIMD document", () => {
  it("is a client API path, served on the API host and through the app host's zone route", () => {
    expect(TOOLKIT_OAUTH_CLIENT_PATH).toBe("/oauth/toolkits/client.json");
    expect(isClientApiPath(TOOLKIT_OAUTH_CLIENT_PATH)).toBe(true);
    // The callback is the app Worker's.
    expect(isClientApiPath("/oauth/toolkits/callback")).toBe(false);

    for (const host of ["api.example.com", "app.example.com"])
      expect(misdirected(`https://${host}${TOOLKIT_OAUTH_CLIENT_PATH}`, SPLIT)).toBeUndefined();
  });

  it("names its own URL as the client id and the app host's callback, without an API key", async () => {
    for (const [host, hosts] of [
      ["api.example.com", SPLIT],
      // A one-host stage: the app host's zone route sends the path to the API Worker.
      ["app.example.com", { APP_DOMAIN: "app.example.com" }],
    ] as const) {
      const url = `https://${host}${TOOLKIT_OAUTH_CLIENT_PATH}`;
      const first = await send(url, hosts);

      expect(first.status, host).toBe(200);
      expect(first.headers.get("cache-control")).toContain("max-age");

      const document = await first.json();

      expect(document, host).toEqual({
        client_id: url,
        client_name: "Commissary",
        client_uri: "https://app.example.com",
        redirect_uris: ["https://app.example.com/oauth/toolkits/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      });

      // The same document every time: an authorization server may cache it.
      expect(await (await send(url, hosts)).json()).toEqual(document);
    }
  });

  it("is not served by a Worker that does not know the app host", async () => {
    const response = await send(
      `https://api-pr-1.example.workers.dev${TOOLKIT_OAUTH_CLIENT_PATH}`,
      {},
    );

    expect(response.status).toBe(404);
  });
});
