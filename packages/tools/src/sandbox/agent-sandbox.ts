/**
 * A hosted agent's sandbox (#230, ADR 0041), as Tools checks it for the Agents area: the sandbox toolkit a definition
 * names, and the network and computer its runs' sessions ask for, within that toolkit's ceiling, as `sandbox_open`
 * checks a client's (`toolkit.ts`). The app Worker hands the check to Agents' routes (`AgentReferences`,
 * `../management/toolkit-ids.ts`), as Agents imports nothing of Tools.
 */
import type { SandboxNetwork } from "@commissary/contract/tools";
import {
  describeNetwork,
  NO_NETWORK,
  networkProblem,
  normalizedNetwork,
  withinCeiling,
} from "./network.ts";

/** What a definition says of its sandbox. */
export interface AgentSandboxSettings {
  readonly toolkit: string;
  readonly network?: SandboxNetwork | undefined;
  readonly computer?: boolean | undefined;
}

/** The sandbox toolkit a definition names, as the toolkit list shows it: its kind and its ceiling. */
export interface SandboxToolkitCeiling {
  readonly kind: string;
  readonly network?: SandboxNetwork | undefined;
  readonly computer?: boolean | undefined;
}

/**
 * Why `sandbox` cannot be an agent's, given the toolkit it names as its owner sees it (`undefined`: none of that id):
 * no sandbox toolkit, a malformed network, or a network or the computer beyond the toolkit's ceiling. `undefined` when
 * it can be.
 */
export const agentSandboxRefusal = (
  sandbox: AgentSandboxSettings,
  toolkit: SandboxToolkitCeiling | undefined,
): string | undefined => {
  if (toolkit === undefined || toolkit.kind !== "sandbox")
    return `${JSON.stringify(sandbox.toolkit)} is no sandbox toolkit the agent's owner can use`;
  const asked = sandbox.network ?? NO_NETWORK;
  const problem = networkProblem(asked);

  if (problem !== undefined) return `invalid network: ${problem}`;
  const ceiling = toolkit.network ?? NO_NETWORK;

  if (!withinCeiling(normalizedNetwork(asked), ceiling))
    return `the sandbox toolkit allows at most ${describeNetwork(ceiling)}`;

  if (sandbox.computer === true && toolkit.computer !== true)
    return "the sandbox toolkit does not allow the computer";

  return undefined;
};

/**
 * Whether a run's session opened with `opened` (#230) still fits its definition's sandbox `definition` and the
 * toolkit's ceiling `ceiling` now: its network within both, and the computer only where both allow it. A definition or
 * ceiling narrowed since does not, and the run opens a new session; one widened since does, and the session keeps what
 * it has.
 */
export const agentSandboxFits = (
  definition: AgentSandboxSettings,
  opened: AgentSandboxSettings,
  ceiling: SandboxToolkitCeiling,
): boolean => {
  const network = normalizedNetwork(opened.network ?? NO_NETWORK);
  const computer = opened.computer === true;

  return (
    definition.toolkit === opened.toolkit &&
    withinCeiling(network, normalizedNetwork(definition.network ?? NO_NETWORK)) &&
    withinCeiling(network, ceiling.network ?? NO_NETWORK) &&
    (!computer || (definition.computer === true && ceiling.computer === true))
  );
};
