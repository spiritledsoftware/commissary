/**
 * Tools' step of deleting an org (ADR 0027, #134 "Org deletion and crons"). Tools keeps nearly everything in the org's
 * ControlPlane, whose tables go with `wipeOrg` (`ToolsPart.wipe`): its toolkits, credentials, tool lists and
 * overrides. Two things are kept outside it. The org's open sandbox sessions (#222) are Durable Objects of their own,
 * with their files: this step has the ControlPlane delete each (`ToolsPart.purgeSandboxSessions`), before `wipeOrg`
 * drops the table that lists them. On Commissary Cloud the org's OAuth sign-ins of MCP clients (#200) are kept in the
 * OAuth server's KV namespace (`OAUTH_KV`, `oauth/config.ts`): this step deletes their grants and tokens, which the
 * library keeps under the user `<org>/<member id>` (`signInUserId`). Clients, registered by no org, and consents
 * waiting on the consent page, which expire within minutes, stay.
 */
import { Effect } from "effect";
import type { OrgDeletionStep } from "@commissary/core";
import { controlPlaneOf } from "@commissary/state";
import { type ToolsBindings, ToolsEnv } from "./env.ts";
import { type McpOAuthConfig, mcpOAuthConfig } from "./oauth/config.ts";
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

/** Tools' step over the invocation's bindings: the sandbox sessions, then the OAuth sign-ins, if it has the server. */
export const orgDeletionStep: Effect.Effect<OrgDeletionStep, never, ToolsEnv> = Effect.gen(
  function* () {
    const env = yield* ToolsEnv;
    const config = mcpOAuthConfig(env);
    const sandboxes = deleteOrgSandboxSessions(env);

    if (config === undefined) return sandboxes;
    const signIns = deleteOrgSignIns(config.kv);

    return async (org, budget) => {
      const first = await sandboxes(org, budget);

      if (!first.complete) return first;
      const second = await signIns(org, budget - first.calls);

      return { ...second, calls: first.calls + second.calls };
    };
  },
);
