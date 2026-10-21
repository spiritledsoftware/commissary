/**
 * Who watches an agent run (#232, ADR 0040 "Who watches and steers"), as the Tools part asks it: the people who answer
 * a run's tool calls that wait for a person. They are the run's starter (the member at the head of a child run's
 * chain), or, for a shared agent's run that no one started, the agent's watchers (GLOSSARY "Watcher"). Under an
 * approval rule of the caller they are the run's caller, and they may watch the browser sessions a shared agent's run
 * opened (their Live View, the handoffs in them), which belong to the run, not to a member.
 *
 * The Agents area answers ({@link RunWatchers}): the state Worker fills it from the Agents part of the same
 * ControlPlane, read in place and at once, so the part decides who may watch a session synchronously, for every session
 * of a list. Tools imports nothing of Agents. Without it (a deployment without the Agents area, which has no runs) no
 * one watches a run but the member it acts as.
 */
import { runOfPrincipal } from "@commissary/auth";

export interface RunWatchers {
  /** The member ids who watch the run `runId`: none for an unknown run, or one whose chain's head is gone. */
  readonly of: (runId: string) => ReadonlyArray<string>;
}

/**
 * The members who watch the run the principal `principal` names; none for any other principal, or without `watchers`.
 */
export const watchersOfPrincipal = (
  watchers: RunWatchers | undefined,
  principal: string,
): ReadonlyArray<string> => {
  const run = runOfPrincipal(principal);

  return run === undefined || watchers === undefined ? [] : watchers.of(run);
};
