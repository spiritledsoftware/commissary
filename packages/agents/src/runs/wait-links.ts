/**
 * The panel's page a run's wait links to (#232), checked before a member's client is asked to open it: the link the
 * MCP endpoint put in a run's call's `_meta` (`RunWaiting.link`) is the panel's page of that very approval or browser
 * session, on the panel's host, or none is. The endpoint strips Commissary's `_meta` keys from every tool's own result,
 * so only it sets one; this check is the defence in depth: a link that is not the panel's page of the wait's own id
 * (another origin, another page, an id of another form) is never elicited.
 */
import type { RunWaiting } from "@commissary/contract/run-waits";

/** A pending approval's id (`ap_` and 24 hex digits, Tools' `freshId`). */
const APPROVAL_ID = /^ap_[0-9a-f]{24}$/u;

/** A browser session's id (`bs_` and 32 hex digits). */
const SESSION_ID = /^bs_[0-9a-f]{32}$/u;

/** The panel's origin on a deployment whose panel's host (`APP_DOMAIN`) is `host`; none without one. */
export const panelOrigin = (host: string | undefined): string | undefined => {
  const trimmed = (host ?? "").trim();

  return trimmed === "" ? undefined : `https://${trimmed}`;
};

/**
 * The link of `waiting` when it is the page of the panel at `panel` (an origin) for that approval
 * (`/o/<org>/approvals/<id>`) or browser session (`/o/<org>/tools/sessions/<id>`), with an id of its form; undefined
 * otherwise, and without a panel.
 */
export const panelLinkOf = (waiting: RunWaiting, panel: string | undefined): string | undefined => {
  const { link } = waiting;

  if (panel === undefined || link === undefined) return undefined;

  if (!(waiting.kind === "approval" ? APPROVAL_ID : SESSION_ID).test(waiting.id)) return undefined;
  let url: URL;

  try {
    url = new URL(link);
  } catch {
    return undefined;
  }

  const page = waiting.kind === "approval" ? "approvals" : "tools/sessions";
  const path = new RegExp(`^/o/[^/]+/${page}/${waiting.id}$`, "u");

  const bare = url.username === "" && url.password === "" && url.search === "" && url.hash === "";

  return bare && url.origin === panel && path.test(url.pathname) ? url.href : undefined;
};
