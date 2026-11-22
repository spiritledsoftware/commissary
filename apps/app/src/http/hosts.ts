// Where the client API is, as the app Worker tells it (ADR 0028, ADR 0030): the API Worker serves the client API (and
// the hub API, ADR 0052), on
// the API host (`API_DOMAIN`) when the deployment has one, through zone routes on the app host when it has not, and on
// its own workers.dev URL on a preview (where `API_DOMAIN` is that URL's host). This Worker serves everything else and
// refuses a client API path that reaches it (`access/middleware.ts`); the API Worker refuses every other path
// (apps/api/src/http/hosts.ts). Neither looks at the request's hostname: each serves only its own paths, wherever it
// answers.
import { isHubApiPath, normalizedPath } from "@commissary/core";
import type { AppBindings } from "../worker-env.ts";

type HostEnv = Pick<AppBindings, "API_DOMAIN">;

const hostName = (value: string | undefined): string => (value ?? "").trim().toLowerCase();

/**
 * The API host of a deployment, as an `https://` origin; `undefined` when the client API is served on the app host
 * (zone routes). The panel shows it as the address API keys are sent to (`GET /me` `api_url`).
 */
export const apiOrigin = (env: HostEnv): string | undefined => {
  const host = hostName(env.API_DOMAIN);

  return host === "" ? undefined : `https://${host}`;
};

/**
 * Why a path of the API Worker is not served here: the message of the 404 this Worker answers it with, naming the hub
 * API (ADR 0052) for one of its paths (`requestUrl`), the client API otherwise.
 */
export const clientApiElsewhere = (env: HostEnv, requestUrl = ""): string => {
  const api = apiOrigin(env);
  const path = normalizedPath(requestUrl);
  const surface = path !== undefined && isHubApiPath(path) ? "hub API" : "client API";

  return api === undefined
    ? `Not found: the ${surface} is served by the API Worker`
    : `Not found: the ${surface} is served at ${api}`;
};
