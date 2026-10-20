/**
 * An agent run's principal (#227, `@commissary/auth`'s `run` kind), as the API Worker's run gateway resolves it on every
 * request of the run: from the org's ControlPlane (the Agents part's `turnContext`), never from the request. It names
 * the run, its agent and its starter, whom the run acts as (a private agent's member, or a shared agent itself) and
 * what its running turn's definition narrows its reach to (its model and its tool scope). A run that cannot call
 * anything (unknown, ended, or acting as a member who left) is refused like a revoked key.
 */
import { Effect } from "effect";
import type { RunPrincipal } from "@commissary/auth";
import { InternalError, type OrgId, UnauthorizedError } from "@commissary/core";
import { callControlPlane, controlPlaneOf } from "@commissary/state";
import { AgentsEnv, type AgentsControlPlaneStub } from "../env.ts";

/** The principal of the run `runId` of `org`, at its latest turn. */
export const runPrincipal = Effect.fnUntraced(function* (
  org: OrgId,
  runId: string,
): Effect.fn.Return<RunPrincipal, UnauthorizedError | InternalError, AgentsEnv> {
  const stub: AgentsControlPlaneStub = controlPlaneOf(yield* AgentsEnv, org);

  const found = yield* callControlPlane("turnContext", stub, (cp: AgentsControlPlaneStub) =>
    cp.agents().turnContext(runId),
  ).pipe(Effect.mapError(() => new InternalError({ message: "the run could not be resolved" })));

  if (!found.ok)
    return yield* new UnauthorizedError({ message: `Agent run refused: ${found.message}` });
  const run = found.value;

  return {
    kind: "run",
    runId: run.runId,
    agentId: run.agentId,
    starter: run.starter,
    // Absent from a ControlPlane deployed before child runs (#229): the starter, if any, is then a member.
    starterMember:
      run.starterMember ?? (run.starter?.kind === "member" ? run.starter.id : undefined),
    starterEmail: run.starterEmail,
    actsAs: run.actsAs,
    reach: { model: run.model, toolScope: run.toolScope },
  };
});
