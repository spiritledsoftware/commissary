/**
 * The ids of the toolkits a hosted agent may name (#226, ADR 0040), for the Agents area's check of a definition's tool
 * scope: the app Worker hands it to Agents' routes (`AgentReferences`), as Agents imports nothing of Tools. A shared
 * agent names the org's toolkits; a private agent, the toolkits its member can see (the org's and their private ones;
 * tools outside their grants are narrowed at run time, #227). Built-in toolkits count while the deployment has what
 * they run on, as the toolkit list shows them.
 */
import { Effect } from "effect";
import { FULL_ACCESS } from "@commissary/auth";
import { toolsControlPlane } from "../env.ts";
import { type AgentSandboxSettings, agentSandboxRefusal } from "../sandbox/agent-sandbox.ts";

/** The toolkit ids `member` reaches, or the org's (`member` undefined). */
export const toolkitIds = (member: string | undefined) =>
  toolsControlPlane("listToolkits", (stub) =>
    stub.tools().listToolkits(member === undefined ? FULL_ACCESS : { member, admin: false }),
  ).pipe(
    Effect.map(
      ({ toolkits }): ReadonlySet<string> =>
        new Set(
          toolkits
            .filter((toolkit) => member !== undefined || !toolkit.private)
            .map((toolkit) => toolkit.id),
        ),
    ),
  );

/**
 * Why `sandbox` cannot be the sandbox of a hosted agent of `member` (`undefined`: a shared agent, which names the org's
 * toolkits), #230: it names no sandbox toolkit they see, or asks beyond its ceiling (`agentSandboxRefusal`).
 */
export const sandboxRefusal = (sandbox: AgentSandboxSettings, member: string | undefined) =>
  toolsControlPlane("listToolkits", (stub) =>
    stub.tools().listToolkits(member === undefined ? FULL_ACCESS : { member, admin: false }),
  ).pipe(
    Effect.map(({ toolkits }) =>
      agentSandboxRefusal(
        sandbox,
        toolkits.find(
          (toolkit) => toolkit.id === sandbox.toolkit && (member !== undefined || !toolkit.private),
        ),
      ),
    ),
  );
