/**
 * Tools' step of deleting an org (ADR 0027, #134 "Org deletion and crons"). Tools keeps everything in the org's
 * ControlPlane, whose tables go with `wipeOrg` (`ToolsPart.wipe`): its toolkits, credentials, tool lists and
 * overrides. Nothing is kept elsewhere, so the step has nothing to delete; it is listed with the areas' steps so that
 * data Tools keeps outside the ControlPlane later is deleted with the org.
 */
import { Effect } from "effect";
import type { OrgDeletionStep } from "@commissary/core";

const deleteNothing: OrgDeletionStep = async () => ({ complete: true, calls: 0 });

export const orgDeletionStep: Effect.Effect<OrgDeletionStep> = Effect.succeed(deleteNothing);
