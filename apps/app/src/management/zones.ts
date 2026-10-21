// Path zones: which paths need a caller (mirrors the Go route groups in internal/api/server_routes.go that use
// AuthMiddleware), on the management API and panel, and which are the client API, served by the API Worker. Also the org addresses of the management zone
// (ADR 0021), which are new in the Workers port. The Access gate (`access/middleware.ts`) classifies each request here
// and passes what `@commissary/auth` needs of it (the org a URL addresses, the role it needs: `policy.ts`).
import { Schema } from "effect";
import { isClientApiPath, isMcpPath, MCP_PATH, normalizedPath, OrgSlug } from "@commissary/core";

export { normalizedPath };

/** Paths under this prefix additionally require the principal to be on the admin allow-list. */
export const MANAGEMENT_PREFIX = "/v9/management";

/**
 * Where Go serves the upstream panel. Here it redirects to `/` (`management/web-panel.ts`), and stays in the
 * management zone like the panel it points to: only administrators get the redirect.
 */
export const LEGACY_PANEL_PATH = "/management.html";

/**
 * Top-level paths of the new control panel (`apps/web`, served by `src/management/web-panel.ts`): `/` itself, the
 * panel's pages and their sub-paths, and its bundled files under `/assets`. Like the management API, only
 * administrators get them. Deviation from Go: `/` serves the panel instead of the public JSON banner.
 */
export const PANEL_SECTIONS = [
  "accounts",
  "keys",
  "models",
  "usage",
  "settings",
  "members",
  "grants",
  "my-models",
  // The tools a member reaches and why (#209).
  "my-tools",
  "api-keys",
  "limits",
  "management-keys",
  "people",
  "approvals",
  // The Tools pages (#208), with each toolkit's connect page, the link a tool call that needs the member's private
  // credential answers (#197, `/tools/<toolkit id>/connect`).
  "tools",
  // The Agents pages (#233): the agent list, an agent's page with its triggers, and the page that creates one.
  "agents",
  // Commissary Cloud's billing page of an org (#239; the panel shows Not found on a self-hosted Commissary), the
  // address a `plan_limit_reached` refusal links to.
  "billing",
  // Commissary Cloud's consent page for MCP clients (#200, `hosted/mcp-oauth.ts`), the OAuth server's `/authorize`.
  "authorize",
  "assets",
] as const;

const inSection = (path: string, section: string): boolean =>
  path === `/${section}` || path.startsWith(`/${section}/`);

/** Where the org of a panel page comes from: `/o/<slug>/accounts` is the page `/accounts` of the org `<slug>`. */
export const PANEL_ORG_PREFIX = "/o";

/** The segment after `/v9/management` that is followed by an org slug: `/v9/management/orgs/<slug>/config`. */
export const ORGS_SEGMENT = "orgs";

const isPanelPath = (path: string): boolean =>
  path === "/" ||
  path.startsWith(`${PANEL_ORG_PREFIX}/`) ||
  PANEL_SECTIONS.some((section) => inSection(path, section));

const isOrgSlug = Schema.is(OrgSlug);

const decodedLowercase = (segment: string): string => {
  try {
    return decodeURIComponent(segment).toLowerCase();
  } catch {
    return segment.toLowerCase();
  }
};

/** An org addressed by the path of a management request, and the path the request has once the org is taken out. */
export interface OrgAddress {
  readonly slug: OrgSlug;
  /** `/v9/management/<rest>` for `/v9/management/orgs/<slug>/<rest>`, `/<page>` for `/o/<slug>/<page>` (`/` for none). */
  readonly path: string;
}

/**
 * The org a path addresses, `undefined` for a path of no org: `/v9/management/orgs/<slug>/<rest>` (the management API
 * of the org; `/v9/management/orgs` and `/v9/management/orgs/<slug>` themselves are platform-level routes and address
 * none) and `/o/<slug>[/<page>]` (a page of the panel, not `/assets`). Like the router, it skips duplicate slashes and
 * compares the fixed segments case-insensitively and percent-decoded; the rest of the path stays as sent.
 */
export const parseOrgAddress = (pathname: string): OrgAddress | undefined => {
  const segments = pathname.split("/");
  let index = 0;

  const next = (): string | undefined => {
    while (segments[index] === "") index++;
    const segment = segments[index];

    if (segment === undefined) return undefined;
    index++;

    return decodedLowercase(segment);
  };

  // The rest of the path from the next non-empty segment, as sent.
  const rest = (): string | undefined => {
    while (segments[index] === "") index++;

    return segments[index] === undefined ? undefined : segments.slice(index).join("/");
  };

  const first = next();

  if (first === "v9") {
    if (next() !== "management" || next() !== ORGS_SEGMENT) return undefined;
    const slug = next();
    const path = rest();

    if (slug === undefined || !isOrgSlug(slug) || path === undefined) return undefined;

    // No orgs inside an org.
    return decodedLowercase(path.split("/")[0] ?? "") === ORGS_SEGMENT
      ? undefined
      : { slug, path: `${MANAGEMENT_PREFIX}/${path}` };
  }

  if (first === PANEL_ORG_PREFIX.slice(1)) {
    const slug = next();

    if (slug === undefined || !isOrgSlug(slug)) return undefined;
    const path = rest();

    if (path === undefined) return { slug, path: "/" };
    const section = decodedLowercase(path.split("/")[0] ?? "");

    return PANEL_SECTIONS.some((page) => page !== "assets" && page === section)
      ? { slug, path: `/${path}` }
      : undefined;
  }

  return undefined;
};

/**
 * The address of the org in a request URL (absolute or origin-relative), with the URL the request has once the org is
 * taken out: the path of {@link parseOrgAddress} and the query unchanged. `undefined` for a URL of no org.
 */
export const scopedUrl = (
  requestUrl: string,
): { readonly slug: OrgSlug; readonly url: string } | undefined => {
  let parsed: URL;

  try {
    parsed = new URL(requestUrl, "http://invalid.invalid");
  } catch {
    return undefined;
  }

  // The raw path: `URL` leaves the percent-encoding and the duplicate slashes of the request alone.
  const address = parseOrgAddress(parsed.pathname);

  return address === undefined
    ? undefined
    : { slug: address.slug, url: `${address.path}${parsed.search}` };
};

/**
 * The router path of the MCP endpoint of an org other than `global` on the app host (ADR 0045): `/o/<slug>/mcp`. Bare
 * `/mcp` is the endpoint of `global`, as the panel's addresses without an org are. Not a panel page: the org's address
 * is parsed by {@link mcpAddress}, not {@link parseOrgAddress}, and the router matches the path with its org.
 */
export const MCP_ORG_ROUTE = `${PANEL_ORG_PREFIX}/:slug${MCP_PATH}` as const;

/**
 * The org a request URL addresses on the MCP endpoint of the app host: `segment` for `/o/<segment>/mcp`, none for
 * `/mcp` (the request's `CurrentOrg`, `global`); `undefined` when the URL is not the endpoint. Every segment counts,
 * valid slug or not, as the router's `:slug` matches any: the endpoint's gate refuses one that is no slug
 * ({@link mcpOrgSlug}), so no spelling of the address reaches the MCP handler past it. Like the zones, it is case-,
 * slash- and percent-encoding-insensitive and takes a trailing slash, as the router does.
 */
export const mcpAddress = (
  requestUrl: string,
): { readonly segment: string | undefined } | undefined => {
  if (isMcpPath(requestUrl)) return { segment: undefined };
  const path = normalizedPath(requestUrl);

  if (path === undefined) return undefined;
  const [empty, prefix, segment, endpoint, ...rest] = path.split("/");

  return empty === "" &&
    prefix === PANEL_ORG_PREFIX.slice(1) &&
    segment !== undefined &&
    segment !== "" &&
    `/${endpoint}` === MCP_PATH &&
    (rest.length === 0 || (rest.length === 1 && rest[0] === ""))
    ? { segment }
    : undefined;
};

/**
 * The org slug an MCP endpoint address names ({@link mcpAddress}): `{ slug }` (`undefined` for `/mcp`, `global`), or
 * `"invalid"` when its segment is no org slug.
 */
export const mcpOrgSlug = (address: {
  readonly segment: string | undefined;
}): { readonly slug: OrgSlug | undefined } | "invalid" =>
  address.segment === undefined
    ? { slug: undefined }
    : isOrgSlug(address.segment)
      ? { slug: address.segment }
      : "invalid";

/** The path of a (normalised) path once its org is taken out: the page or API path the router matches. */
export const unscopedPath = (path: string): string => parseOrgAddress(path)?.path ?? path;

/**
 * Whether a normalised path (`normalizedPath`) is a page a browser may open from another site: the panel's pages
 * (not `/assets`), also those of an org (`/o/<slug>/accounts`), and the legacy panel address. The management API
 * (`/v9/management*`) never is.
 */
export const isPanelPagePath = (path: string): boolean => {
  const page = unscopedPath(path);

  return (
    page === "/" ||
    page === LEGACY_PANEL_PATH ||
    PANEL_SECTIONS.some((section) => section !== "assets" && inSection(page, section))
  );
};

/** Whether a request URL is one of the panel's bundle files (`/assets/*`), however it is spelled. */
export const isPanelAssetPath = (requestUrl: string): boolean => {
  const path = normalizedPath(requestUrl);

  return path !== undefined && inSection(path, "assets");
};

/**
 * `management`: the management API and the panel, which need a caller (an Access sign-in, a Commissary Cloud session or
 * a management key). `protected`: the client API (`@commissary/core`'s `isClientApiPath`), which the API Worker serves
 * and this Worker refuses (`access/middleware.ts`). `mcp`: the MCP endpoint (`/mcp` for `global`, `/o/<slug>/mcp` for
 * another org, {@link mcpAddress}), which a self-hosted Commissary also serves here, behind Access, to MCP clients
 * Access signs in (ADR 0045), and Commissary Cloud refuses like the rest of the client API. `public`: everything else.
 */
export type AccessZone = "public" | "protected" | "management" | "mcp";

/**
 * Classifies a request URL. Matching is deliberately a superset of what the router matches (percent-decoding,
 * duplicate slashes and case are normalised) so an unusual spelling of a protected path cannot reach a handler
 * unauthenticated; over-matching only turns a 404 into a 401.
 */
export const classifyPath = (requestUrl: string): AccessZone => {
  const path = normalizedPath(requestUrl);

  if (path === undefined) return "protected";

  // Before the panel: `/o/<slug>/mcp` is under the panel's org prefix, but no page.
  if (mcpAddress(requestUrl) !== undefined) return "mcp";

  if (path.startsWith(MANAGEMENT_PREFIX) || path.startsWith(LEGACY_PANEL_PATH) || isPanelPath(path))
    return "management";

  return isClientApiPath(path) ? "protected" : "public";
};
