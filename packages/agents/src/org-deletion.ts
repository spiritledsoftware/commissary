/**
 * Agents' step of deleting an org (ADR 0027, #134 "Org deletion and crons"). Agents keeps everything in the org's
 * ControlPlane, whose tables go with `wipeOrg` (`AgentsPart.wipe`): its agents and their grants. Nothing is kept
 * outside it, so the step deletes nothing; runs (#227), which will keep transcripts elsewhere, add theirs here.
 */
import { Effect } from "effect";
import type { OrgDeletionStep } from "@commissary/core";

const deleteNothing: OrgDeletionStep = async () => ({ complete: true, calls: 0 });

export const orgDeletionStep: Effect.Effect<OrgDeletionStep> = Effect.succeed(deleteNothing);
