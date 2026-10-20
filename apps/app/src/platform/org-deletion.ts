/**
 * Deleting an org's data (ADR 0027), new in the Workers port: an org that is deleted leaves nothing behind. One call
 * removes, in this order (#134 "Org deletion and crons"):
 *
 * 1. what each area keeps outside the ControlPlane, through the area steps it is given (Models: its usage records in D1
 *    and its keys in the `CACHE` KV namespace, `models/org-deletion.ts`; Tools: its open sandbox sessions, each a
 *    Durable Object of its own, and on Commissary Cloud its OAuth sign-ins of MCP clients in `OAUTH_KV`,
 *    `tools/org-deletion.ts`),
 * 2. the `SessionState` instances it registered (`@commissary/state`'s session instances), each wiped,
 * 3. its ControlPlane's whole storage: credentials, config entries, members, API keys, private data, OAuth logins and
 *    the refresh alarm (`ControlPlane.wipeOrg`),
 * 4. and last its Platform registry entry (the org, its people's index and its service tokens), which frees the slug.
 *
 * The registry entry goes last so a deletion that stops half way can be run again: the org is still listed, and every
 * earlier step finds less to do. Each call may use at most {@link DELETION_BUDGET} subrequests (a Worker invocation has
 * a limit), shared by all the steps; a big org answers `incomplete` and the caller runs the deletion again. `global` is
 * never deleted.
 */
import { controlPlaneOf, platformOf, type StateBindings } from "@commissary/state";
import { GLOBAL_ORG, type OrgDeletionStep, type OrgId } from "@commissary/core";

/** The most Durable Object, KV and D1 calls one deletion makes before it asks to be run again. */
export const DELETION_BUDGET = 400;

/** `SessionState` instances wiped between two reads of the registered ones. */
const INSTANCES_PER_READ = 50;

export type OrgDeletion =
  | { readonly state: "deleted" }
  | {
      readonly state: "incomplete";
      /** The step that stopped: an area step's part (Models: `usage`, `cache`), or `sessions`. */
      readonly step: string;
    }
  | {
      readonly state: "refused";
      readonly reason: "global" | "not_found";
      readonly message: string;
    };

export interface DeletionOptions {
  /** Epoch ms, the caller's clock. */
  readonly now: number;
  /** Overrides {@link DELETION_BUDGET} (tests). */
  readonly budget?: number;
}

/**
 * Deletes every trace of `org`; see the module comment. Never rejects for an org that is already half deleted. `state`
 * holds the Durable Objects, `steps` the org-deletion steps of the areas the Worker mounts, run in order.
 */
export const deleteOrg = async (
  state: StateBindings,
  steps: ReadonlyArray<OrgDeletionStep>,
  org: OrgId,
  options: DeletionOptions,
): Promise<OrgDeletion> => {
  if (org === GLOBAL_ORG)
    return { state: "refused", reason: "global", message: "the first org cannot be deleted" };

  let budget = options.budget ?? DELETION_BUDGET;
  const plane = controlPlaneOf(state, org);

  // 1. The areas' data.
  for (const step of steps) {
    const progress = await step(org, budget);
    budget -= progress.calls;

    if (!progress.complete) return { state: "incomplete", step: progress.part };
  }

  // 2. The SessionState instances the org registered.
  for (;;) {
    if (budget < INSTANCES_PER_READ + 2) return { state: "incomplete", step: "sessions" };
    const names = await plane.sessionInstances(options.now, INSTANCES_PER_READ);
    budget -= 1;

    if (names.length === 0) break;

    await Promise.all(names.map(async (name) => await state.SESSION_STATE.getByName(name).wipe()));
    budget -= names.length;
    await plane.forgetSessionInstances(names);
    budget -= 1;
  }

  // 3. The ControlPlane's storage.
  await plane.wipeOrg();

  // 4. The registry entry, last.
  const removed = await platformOf(state).deleteOrg(org);

  if (!removed.ok && removed.error !== "not_found")
    return { state: "refused", reason: removed.error, message: removed.message };

  return { state: "deleted" };
};
