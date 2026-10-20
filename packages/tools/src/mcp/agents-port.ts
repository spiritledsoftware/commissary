/**
 * The port through which the MCP endpoint makes the agents toolkit's calls (#229, `agents/toolkit.ts`): the Tools part
 * decides that a caller reaches a tool of it (reach, tool scope, tool class, Spend, approval rules) and hands the call
 * back (`delegated`); the Worker the endpoint runs in makes it, through the Agents area, which Tools never imports. The
 * Worker fills the port from `@commissary/agents/api` in its request context, where the Agents area is: the API
 * Worker always, a self-hosted app Worker with the area's binding. Without it the endpoint serves no agents toolkit.
 */
import { Context, type Effect, type Schema } from "effect";
import type { AccessIdentity } from "@commissary/auth";
import type { OrgId } from "@commissary/core";

/** A call of the agents toolkit as the endpoint hands it over. */
export interface AgentsToolkitRequest {
  /** Who calls, and in which org. */
  readonly identity: AccessIdentity;
  readonly org: OrgId;
  /** The tool's upstream name (`start`, `message`, `wait`, `status`, `cancel`). */
  readonly tool: string;
  readonly arguments: Schema.JsonObject;
  /** The agents the caller's tool scope lets it run; `undefined`: every agent within reach. */
  readonly scopeAgents?: ReadonlyArray<string> | undefined;
}

export interface AgentsToolkitCalls {
  /** Answers the call with an MCP tool result; never fails (a refusal is a result with `isError`). */
  readonly call: (request: AgentsToolkitRequest) => Effect.Effect<Schema.JsonObject>;
}

/** The agents toolkit's calls, as the current Worker makes them (provided per request). */
export class AgentsToolkitPort extends Context.Service<AgentsToolkitPort, AgentsToolkitCalls>()(
  "commissary/tools/AgentsToolkitPort",
) {}
