/**
 * Tools' step of deleting an org (ADR 0027, #134 "Org deletion and crons"). Tools keeps nearly everything in the org's
 * ControlPlane, whose tables go with `wipeOrg` (`ToolsPart.wipe`): its toolkits, credentials, tool lists and overrides.
 * Four things are kept outside it. The org's open sandbox sessions (#222) are Durable Objects of their own, with their
 * files, and would write a usage record of their computer time (#224) and report to the ControlPlane once they close:
 * this step has the ControlPlane delete each at once, without a record (`ToolsPart.purgeSandboxSessions`), before
 * `wipeOrg` drops the table that lists them. So are its open browser sessions (#214), whose alarm would do the same:
 * the ControlPlane deletes each at once (`ToolsPart.purgeBrowserSessions`), then this step deletes the org's browser
 * and sandbox sessions' usage records, for one written after Models' step deleted the org's usage rows. The org's
 * browser crawls (#270) run at the browser provider: the ControlPlane cancels each that may still be running
 * (`ToolsPart.purgeBrowserCrawls`, as far as the provider answers), as `wipeOrg` cannot: it is synchronous. On
 * Commissary Cloud the org's OAuth sign-ins of MCP clients (#200) are kept in the OAuth server's KV namespace
 * (`OAUTH_KV`, `oauth/config.ts`): this step deletes their grants and tokens, which the library keeps under the user
 * `<org>/<member id>` (`signInUserId`). Clients, registered by no org, and consents waiting on the consent page, which
 * expire within minutes, stay.
 */
import { Effect } from "effect";
import type { OrgDeletionStep } from "@commissary/core";
import { controlPlaneOf } from "@commissary/state";
import { type ToolsBindings, ToolsEnv } from "./env.ts";
import { type McpOAuthConfig, mcpOAuthConfig } from "./oauth/config.ts";
import { deleteSessionRecords } from "./usage/record.ts";
import { signInUserId } from "./oauth/server.ts";

/** Keys read and deleted per page: each key is one KV call. */
const KV_PAGE = 100;

/** Sandbox sessions deleted per call of the ControlPlane: each is one call of its own, from the ControlPlane. */
const SANDBOX_PAGE = 20;

/**
 * Deletes the org's open sandbox sessions, a page at a time within `budget`: each page is one call of the ControlPlane
 * and, counted against the budget too, one call of each session's object.
 */
export const deleteOrgSandboxSessions =
  (state: Pick<ToolsBindings, "CONTROL_PLANE">): OrgDeletionStep =>
  async (org, budget) => {
    let calls = 0;

    for (;;) {
      if (budget - calls < SANDBOX_PAGE + 1) return { complete: false, calls, part: "sandbox" };

      const { purged, remaining } = await controlPlaneOf(state, org)
        .tools()
        .purgeSandboxSessions(SANDBOX_PAGE);

      calls += 1 + purged;

      if (remaining === 0) return { complete: true, calls };
    }
  };

/** Browser sessions deleted per call of the ControlPlane: each is one call of its own, from the ControlPlane. */
const BROWSER_SESSION_PAGE = 20;

/**
 * Deletes the org's open browser sessions, a page at a time within `budget` (each page is one call of the ControlPlane
 * and, counted against the budget too, one call of each session's object), then the browser and sandbox sessions'
 * usage records (one call: the sandbox sessions were deleted before, `deleteOrgSandboxSessions`).
 */
export const deleteOrgBrowserSessions =
  (env: Pick<ToolsBindings, "CONTROL_PLANE" | "USAGE">): OrgDeletionStep =>
  async (org, budget) => {
    let calls = 0;

    for (;;) {
      if (budget - calls < BROWSER_SESSION_PAGE + 2)
        return { complete: false, calls, part: "browser sessions" };

      const { purged, remaining } = await controlPlaneOf(env, org)
        .tools()
        .purgeBrowserSessions(BROWSER_SESSION_PAGE);

      calls += 1 + purged;

      if (remaining === 0) break;
    }

    await deleteSessionRecords(env.USAGE, org);

    return { complete: true, calls: calls + 1 };
  };

/** Browser crawls cancelled per call of the ControlPlane: each is one request of the ControlPlane's to the provider. */
const CRAWL_PAGE = 20;

/**
 * Cancels the org's browser crawls that may still be running, a page at a time within `budget`: each page is one call
 * of the ControlPlane and, counted against the budget too, one request of its to the provider per crawl.
 */
export const deleteOrgBrowserCrawls =
  (state: Pick<ToolsBindings, "CONTROL_PLANE">): OrgDeletionStep =>
  async (org, budget) => {
    let calls = 0;

    for (;;) {
      if (budget - calls < CRAWL_PAGE + 1) return { complete: false, calls, part: "crawls" };

      const { purged, remaining } = await controlPlaneOf(state, org)
        .tools()
        .purgeBrowserCrawls(CRAWL_PAGE);

      calls += 1 + purged;

      if (remaining === 0) return { complete: true, calls };
    }
  };

/** Runs `steps` in turn within one budget, stopping at the first that is not complete. */
const inTurn =
  (steps: ReadonlyArray<OrgDeletionStep>): OrgDeletionStep =>
  async (org, budget) => {
    let calls = 0;

    for (const step of steps) {
      const done = await step(org, budget - calls);

      calls += done.calls;

      if (!done.complete) return { ...done, calls };
    }

    return { complete: true, calls };
  };

/**
 * The library's keys of the org's sign-ins: its grants (`grant:<user>:<grant id>`) first, so no refresh mints a token
 * once the step has passed the tokens, then their tokens (`token:<user>:<grant id>:<token id>`). An org id has no `/`,
 * so the prefix of one org's users is no other org's.
 */
const prefixesOf = (org: string): ReadonlyArray<string> => {
  const users = signInUserId(org, "");

  return [`grant:${users}`, `token:${users}`];
};

/** Deletes the org's grants and tokens from the OAuth server's store, a page at a time within `budget`. */
export const deleteOrgSignIns =
  (kv: McpOAuthConfig["kv"]): OrgDeletionStep =>
  async (org, budget) => {
    let calls = 0;

    for (const prefix of prefixesOf(org))
      for (;;) {
        if (budget - calls < KV_PAGE + 1) return { complete: false, calls, part: "oauth" };

        const page = await kv.list({ prefix, limit: KV_PAGE });

        await Promise.all(page.keys.map(async (key) => await kv.delete(key.name)));
        calls += 1 + page.keys.length;

        if (page.list_complete) break;
      }

    return { complete: true, calls };
  };

/**
 * Tools' step over the invocation's bindings: the sandbox sessions, the browser sessions, the browser crawls, then the
 * OAuth sign-ins, if it has the server.
 */
export const orgDeletionStep: Effect.Effect<OrgDeletionStep, never, ToolsEnv> = Effect.gen(
  function* () {
    const env = yield* ToolsEnv;
    const config = mcpOAuthConfig(env);

    return inTurn([
      deleteOrgSandboxSessions(env),
      deleteOrgBrowserSessions(env),
      deleteOrgBrowserCrawls(env),
      ...(config === undefined ? [] : [deleteOrgSignIns(config.kv)]),
    ]);
  },
);
