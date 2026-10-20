/**
 * The role a request needs (ADR 0022, the permission matrix of `docs/ACCESS.md`): the role table the Worker passes to
 * `@commissary/auth`'s `authenticateManagement`. New in the Workers port, no Go counterpart: Go has one management key
 * for everything.
 *
 * - **platform-level**: needs no role in any org: who the caller is (`/v9/management/me`), the org list
 *   (`/v9/management/orgs`, `/v9/management/orgs/<slug>`, Commissary Cloud's `/v9/management/people/<email>`; their
 *   handlers ask for a platform admin, or on Commissary Cloud let anyone create an org), the panel's pages
 *   without an org (they redirect to an org of the caller or show the org chooser), its bundle files and the old
 *   panel's address.
 * - **member**: any role in the org: the client API, the panel's pages of the org, their own API keys
 *   (`management/api-key-routes.ts`), the Spend limits that bind them and those on their own keys
 *   (`management/spend-routes.ts`), and the areas' routes their entries name (Models: reading usage and their own
 *   credentials).
 * - **owner**: Commissary Cloud's billing writes (checkout, portal, switching plans; Billing's entries).
 * - **admin**: everything else of the management API. Some routes need more and say so in their handler: changing a
 *   role (org owner), downloading a credential or giving a service token a role above member (ADR 0006's rule per
 *   org, `@commissary/auth` `holdsSensitivePowers`).
 */
import { type AccessRule, type RouteAccess, ruleAccess } from "@commissary/auth";
import { accessRules as billingAccessRules } from "@commissary/billing/management";
import { accessRules as modelsAccessRules } from "@commissary/models/management";
import { accessRules as toolsAccessRules } from "@commissary/tools/management";
import {
  type AccessZone,
  isPanelPagePath,
  LEGACY_PANEL_PATH,
  MANAGEMENT_PREFIX,
  normalizedPath,
  ORGS_SEGMENT,
  parseOrgAddress,
} from "./zones.ts";

/** A member's own API keys (`management/api-key-routes.ts`, which limits a plain member to their keys). */
const API_KEYS = `${MANAGEMENT_PREFIX}/api-keys`;

/**
 * Spend limits (`management/spend-routes.ts`): a plain member reads the limits that bind them and limits their own API
 * keys, so those routes are for members (the ControlPlane's `SpendService` decides what each may see and write); the
 * calendar (`/spend/settings`) stays for org admins.
 */
const SPEND = `${MANAGEMENT_PREFIX}/spend`;

/**
 * The routes below `admin`, first match wins: the Worker's own (a member's API keys, Spend limits; the calendar comes
 * before the rest of `/spend`), then each area's, listed explicitly (#134 "The area package convention").
 */
const RULES: ReadonlyArray<AccessRule> = [
  { path: API_KEYS, subpaths: true, role: "member" },
  { path: `${SPEND}/settings`, role: "admin" },
  { path: SPEND, subpaths: true, role: "member" },
  ...modelsAccessRules,
  ...toolsAccessRules,
  ...billingAccessRules,
];

const ME = `${MANAGEMENT_PREFIX}/me`;

const ORGS = `${MANAGEMENT_PREFIX}/${ORGS_SEGMENT}`;

/** The people of Commissary Cloud (`management/people-routes.ts`, whose handlers ask for a platform admin). */
const PEOPLE = `${MANAGEMENT_PREFIX}/people`;

const withoutTrailingSlash = (path: string): string =>
  path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;

/**
 * What a request to `requestUrl` in `zone` needs. Paths are compared like the zones are classified (`normalizedPath`:
 * percent-decoded, duplicate slashes collapsed, lowercased), so an unusual spelling never needs less than the route it
 * reaches.
 */
export const routeAccess = (
  method: string,
  requestUrl: string,
  zone: Exclude<AccessZone, "public">,
): RouteAccess => {
  // The client API and the MCP endpoint (ADR 0045): any role in the org, as on the API Worker.
  if (zone === "protected" || zone === "mcp") return "member";
  const path = normalizedPath(requestUrl);

  if (path === undefined) return "admin";
  const address = parseOrgAddress(path);
  const route = withoutTrailingSlash(address?.path ?? path);

  if (route === ME) return "platform";

  if (address === undefined) {
    if (route === ORGS || route.startsWith(`${ORGS}/`)) return "platform";

    if (route.startsWith(`${PEOPLE}/`)) return "platform";

    if (route === "/assets" || route.startsWith("/assets/") || route.startsWith(LEGACY_PANEL_PATH))
      return "platform";

    if (isPanelPagePath(route)) return "platform";
  } else if (isPanelPagePath(route)) return "member";

  return ruleAccess(RULES, method, route);
};
