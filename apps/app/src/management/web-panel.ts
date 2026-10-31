/**
 * The control panel built from `apps/web` (`bun run build` writes `apps/web/dist/index.html` and
 * `apps/web/dist/assets/*`, with the font's licence in `assets/licenses/`): `/`, its page paths (`zones.ts`
 * `PANEL_SECTIONS`), the same pages under an org
 * (`/o/<slug>/accounts`, routed as the unscoped page by `org-address.ts`) and the bundled files under `/assets`.
 *
 * New in the Workers port: Go serves the upstream panel at `/management.html` and a public JSON banner at `/`. Here
 * `/management.html` is a legacy redirect to `/` (`LEGACY_PANEL_REDIRECT`, deviation from Go). Every page path
 * answers the same `index.html`; the panel's router picks the page in the browser. Both pages and files are gated like
 * the management API (Access, `policy.ts`: a page of an org needs a role in it) because the Worker runs before
 * static assets. The page talks to `/v9/management`
 * on its own origin and sends no credentials of its own: Access authenticates those calls. On Commissary Cloud the
 * sign-in page also calls the auth host (ADR 0030), whose origin the page names in a `<meta>` tag
 * ({@link AUTH_ORIGIN_META}) and its policy allows ({@link hostedPanelCsp}).
 */
import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { addressedSlug } from "./org-address.ts";
import { AccessPrincipal, AuthConfig, isHosted } from "@commissary/auth";
import { PANEL_ORG_PREFIX, PANEL_SECTIONS } from "./zones.ts";
import { AUTH_ORIGIN_META } from "@commissary/contract/sign-in";
import { jsonReply } from "@commissary/core";
import { openableOrgs } from "./org-routes.ts";
import { configuredAuthOrigin } from "../hosted/sign-in.ts";
import { AppEnv } from "../worker-env.ts";

export const PANEL_NOT_BUILT = "the control panel is not built; run `bun run build`";

/** Where a browser session's Live View is served from (#216): the session's page embeds it in a frame. */
export const LIVE_VIEW_ORIGIN = "https://live.browser.run";

/**
 * Inline `style` attributes carry computed meter widths; scripts, styles and fonts come only from the panel's own
 * bundle, the page may only call its own origin, and the only frame it embeds is a browser session's Live View.
 */
export const PANEL_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  `frame-src ${LIVE_VIEW_ORIGIN}`,
  "frame-ancestors 'none'",
].join("; ");

/** Where the Turnstile widget of Commissary Cloud's sign-in page loads from (the auth Worker checks its tokens). */
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/**
 * The panel's policy on Commissary Cloud: {@link PANEL_CSP} plus the Turnstile widget (its script and its frame) on the
 * sign-in page, and the auth host (`authOrigin`, when configured), which the sign-in page and the sign-out call. Every
 * page gets it, since the panel moves between pages without a reload.
 */
export const hostedPanelCsp = (authOrigin: string | undefined): string =>
  PANEL_CSP.replace("script-src 'self'", `script-src 'self' ${TURNSTILE_ORIGIN}`)
    .replace(
      "connect-src 'self'",
      `connect-src 'self'${authOrigin === undefined ? "" : ` ${authOrigin}`}`,
    )
    .replace(`frame-src ${LIVE_VIEW_ORIGIN}`, `frame-src ${LIVE_VIEW_ORIGIN} ${TURNSTILE_ORIGIN}`);

const escapeAttribute = (value: string): string =>
  value.replace(/[&"<>]/g, (char) => `&#${char.charCodeAt(0)};`);

/** The panel's page with the auth host's origin in its `<head>`. */
const withAuthOrigin = (page: Response, authOrigin: string): Response =>
  new HTMLRewriter()
    .on("head", {
      element: (head) => {
        head.append(`<meta name="${AUTH_ORIGIN_META}" content="${escapeAttribute(authOrigin)}">`, {
          html: true,
        });
      },
    })
    .transform(page);

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-cache",
  "content-security-policy": PANEL_CSP,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
} as const;

/** The asset response; `undefined` when the binding throws. */
const fetchAsset = (request: Request) =>
  Effect.gen(function* () {
    const env = yield* AppEnv;

    return yield* Effect.tryPromise({
      try: async () => await env.ASSETS.fetch(request),
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(() => undefined));
  });

const requestUrl = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;

  return new URL(request.originalUrl, "http://localhost");
});

/**
 * Where an unscoped panel page (`/`, `/accounts`, ...) goes when the caller manages exactly one org: the same page of
 * that org (`/o/<slug>/accounts`), the query kept. `undefined` when the caller manages none or several (or the registry
 * cannot be read), or the address asks for the chooser (`?choose`): the panel itself then asks which org to open.
 */
const orgRedirect = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const identity = yield* AccessPrincipal;
  const orgs = yield* openableOrgs(identity);
  const [only] = orgs;

  if (orgs.length !== 1 || only === undefined) return undefined;
  const url = new URL(request.url, "http://localhost");

  // The org list's own link: a platform admin of one org reaches the chooser to create another.
  if (url.searchParams.has("choose")) return undefined;

  return `${PANEL_ORG_PREFIX}/${only.slug}${url.pathname}${url.search}`;
}).pipe(Effect.catch(() => Effect.succeed(undefined)));

/**
 * `GET /`, every panel page path and the same pages of an org (`/o/<slug>/accounts`): the panel's `index.html` (the
 * assets binding serves it for `/`). The panel reads its org from the address; an address without one redirects to the
 * only org of the caller (`orgRedirect`) and otherwise serves the panel, which shows the org chooser.
 */
export const webPanelPage = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;

  if (addressedSlug(request) === undefined) {
    const target = yield* orgRedirect;

    if (target !== undefined)
      return HttpServerResponse.redirect(target, {
        status: 302,
        headers: { "cache-control": "no-store" },
      });
  }

  return yield* panelIndex;
});

/** The panel's `index.html` (the panel's router picks the page in the browser); `404` when the panel is not built. */
export const panelIndex = Effect.gen(function* () {
  const url = yield* requestUrl;
  const auth = yield* AuthConfig;

  const asset = yield* fetchAsset(
    new Request(new URL("/", url), { headers: { accept: "text/html" } }),
  );

  const contentType = asset?.headers.get("content-type") ?? "";

  if (asset === undefined || asset.status !== 200 || !contentType.includes("text/html")) {
    yield* Effect.logWarning(PANEL_NOT_BUILT);

    return jsonReply(404, { error: PANEL_NOT_BUILT });
  }

  if (!isHosted(auth))
    return HttpServerResponse.raw(asset.body, { status: 200, headers: PAGE_HEADERS });
  const authOrigin = yield* configuredAuthOrigin;

  return HttpServerResponse.raw(
    authOrigin === undefined ? asset.body : withAuthOrigin(asset, authOrigin).body,
    {
      status: 200,
      headers: { ...PAGE_HEADERS, "content-security-policy": hostedPanelCsp(authOrigin) },
    },
  );
});

/**
 * `GET|HEAD /management.html` (any case or percent-encoding the router matches): the upstream panel's address, kept
 * so bookmarks land on the panel. `302` (not cached, so the admin gate and this handler stay authoritative); the
 * browser carries an old `#/...` fragment over, which the panel maps on boot (`apps/web/src/lib/legacy-hash.ts`).
 */
export const LEGACY_PANEL_REDIRECT = Effect.succeed(
  HttpServerResponse.redirect("/", { status: 302, headers: { "cache-control": "no-store" } }),
);

/** Headers of a bundle file worth keeping: hashed names are cached forever by the assets platform. */
const PASSED_ASSET_HEADERS = ["content-type", "cache-control", "etag", "last-modified"] as const;

/** `GET /assets/*`: the panel's hashed bundle files, passed through from the assets binding. */
export const webPanelAsset = Effect.gen(function* () {
  const url = yield* requestUrl;
  const asset = yield* fetchAsset(new Request(url, { method: "GET" }));

  if (asset === undefined || asset.status !== 200) return jsonReply(404, { error: "not found" });

  const passed = PASSED_ASSET_HEADERS.flatMap((name) => {
    const value = asset.headers.get(name);

    return value === null ? [] : [[name, value] as const];
  });

  return HttpServerResponse.raw(asset.body, {
    status: 200,
    headers: { "x-content-type-options": "nosniff", ...Object.fromEntries(passed) },
  });
});

/**
 * Router paths of the panel pages: `/` and each section with its sub-paths (a `/x/*` route also matches `/x`).
 * `/assets` is served by `webPanelAsset`, `/authorize` (Commissary Cloud's only) by `hosted/mcp-oauth.ts`.
 */
export const PANEL_PAGE_PATHS: ReadonlyArray<`/${string}`> = [
  "/",
  ...PANEL_SECTIONS.filter((section) => section !== "assets" && section !== "authorize").map(
    (section): `/${string}` => `/${section}/*`,
  ),
];
