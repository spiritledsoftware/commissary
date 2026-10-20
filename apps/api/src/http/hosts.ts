// What the API Worker serves (ADR 0028, ADR 0030): the client API and `/healthz`, wherever it answers: on the API host
// (`API_DOMAIN`), through zone routes on the app host, or on a preview's workers.dev URL. Every other path is the app
// Worker's (its panel, sign-in and management API), and is refused before the router with a 404 that names the app host
// when the deployment has one (`APP_DOMAIN`). The app Worker refuses the client API in turn (apps/app/src/http/hosts.ts).
import { isClientApiPath, normalizedPath } from "@commissary/core";
import { PROTECTED_RESOURCE_METADATA_PATH } from "@commissary/tools/api";
import type { ApiBindings } from "../worker-env.ts";

/** Served by every Worker: the health check (`http/routes.ts`). */
const HEALTH_PATH = "/healthz";

const hostName = (value: string | undefined): string => (value ?? "").trim().toLowerCase();

const notFound = (message: string): Response =>
  new Response(JSON.stringify({ error: message }), {
    status: 404,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/**
 * The answer to a request for a path the API Worker does not serve, `undefined` when the request goes on to the router:
 * the client API (and a URL that cannot be parsed, which the gate refuses), `/healthz` and the MCP endpoint's RFC 9728
 * metadata (Commissary Cloud's OAuth server's, #200; unknown without it) go on.
 */
export const misdirected = (
  requestUrl: string,
  env: Pick<ApiBindings, "APP_DOMAIN" | "API_DOMAIN">,
): Response | undefined => {
  const path = normalizedPath(requestUrl);

  if (
    path === undefined ||
    isClientApiPath(path) ||
    path === HEALTH_PATH ||
    path === PROTECTED_RESOURCE_METADATA_PATH
  )
    return undefined;
  const api = hostName(env.API_DOMAIN);
  const app = hostName(env.APP_DOMAIN);
  const here = api === "" ? "this host" : api;

  return notFound(
    app === ""
      ? `Not found: ${here} serves the client API only`
      : `Not found: ${here} serves the client API only; the control panel and the management API are at https://${app}`,
  );
};
