/**
 * The cross-site checks of `@commissary/auth` (`crossSiteRejection`) for a request of one of the Worker's zones: the
 * Worker owns the routes, so it says what a management path is (a panel page; the routes that take an upload or YAML).
 * New in the Workers port.
 */
import { type CrossSiteRejection, crossSiteRejection as rejectCrossSite } from "@commissary/auth";
import {
  type AccessZone,
  isPanelPagePath,
  MANAGEMENT_PREFIX,
  normalizedPath,
  unscopedPath,
} from "../management/zones.ts";

const YAML_TYPES = ["application/yaml", "application/x-yaml", "text/yaml", "text/x-yaml"];

/**
 * The body types a management write takes besides JSON: multipart for credential uploads, YAML for
 * `POST /settings/import` (the Go config import), none elsewhere. `path` is the path without the org of an org-scoped
 * request (`/v9/management/orgs/<slug>/settings/import` is `/v9/management/settings/import`).
 */
const managementBodyTypes = (method: string, path: string): ReadonlyArray<string> => {
  if (method !== "POST") return [];

  if (path === `${MANAGEMENT_PREFIX}/credentials` || path === `${MANAGEMENT_PREFIX}/oauth/import`)
    return ["multipart/form-data"];

  return path === `${MANAGEMENT_PREFIX}/settings/import` ? YAML_TYPES : [];
};

/**
 * Checks a request of the protected (`/v1*`, ...), the MCP or the management zone before authentication; `undefined`
 * when it may proceed. A management path is a panel page when a browser may open it from another site
 * (`isPanelPagePath`: the panel's pages, also an org's, and `/management.html`; never `/v9/management*`).
 */
export const crossSiteRejection = (
  method: string,
  headers: Readonly<Record<string, string | undefined>>,
  requestUrl: string,
  zone: Exclude<AccessZone, "public">,
): CrossSiteRejection | undefined => {
  if (zone === "protected") return rejectCrossSite(method, headers, requestUrl, undefined);

  // The MCP endpoint behind Access (ADR 0045) takes the Access session cookie too, so it is guarded like a management
  // write: no foreign `Origin` (also the transport's DNS-rebinding rule), no cross-site fetch, JSON bodies only.
  if (zone === "mcp")
    return rejectCrossSite(method, headers, requestUrl, { panelPage: false, bodyTypes: [] });
  const path = normalizedPath(requestUrl) ?? "";

  return rejectCrossSite(method, headers, requestUrl, {
    panelPage: isPanelPagePath(path),
    bodyTypes: managementBodyTypes(method.toUpperCase(), unscopedPath(path)),
  });
};
