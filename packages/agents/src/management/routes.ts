/**
 * `/v9/management/agents` (`AgentsGroup` in `@commissary/contract/agents`): hosted agent definitions, private and
 * shared (#226, ADR 0040), and `/v9/management/grants/agents` (`AgentGrantsGroup`): who may use which shared agent,
 * beside Models' `/grants` and Tools' `/grants/tools`. The app Worker's `management/routes.ts` mounts them next to the
 * other areas', with its {@link AgentReferences}.
 *
 * Every member may call `/agents` and `/grants/agents` (`access-rules.ts`), so that the area's absence comes first:
 * without the deployment's Dynamic Workers binding (`LOADER`) every route here answers 404, whoever asks. The Agents
 * part decides what the caller reaches from the viewer each `/agents` route hands it; the grants are for org admins,
 * checked here after the absence. Writes name the revision they were based on in `If-Match`. The agent runs' routes
 * (`/agents/:id/runs`, `/agent-runs`, #227) are `run-routes.ts`', and the triggers' (`/agents/:id/triggers`, #231)
 * `trigger-routes.ts`', mounted with these.
 */
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { AccessPrincipal, currentViewer } from "@commissary/auth";
import { AgentGrantBody, CreateAgent, UpdateAgent } from "@commissary/contract/agents";
import { CurrentOrg, ifMatch, jsonReply, replyError } from "@commissary/core";
import {
  type AgentsErrorCode,
  createsPrivate,
  type ReferenceCheck,
} from "../control-plane-part.ts";
import { agentsControlPlane, AgentsEnv } from "../env.ts";
import { sweepRetiredSchedules } from "../org-deletion.ts";
import { sweepDeletedRuns } from "../runs/retention.ts";
import { decode, orRefuseWith, param, route } from "./http.ts";
import { type AgentReferences, checkReferences } from "./references.ts";
import { runRoutes } from "./run-routes.ts";
import { triggerRoutes } from "./trigger-routes.ts";

const STATUS: Readonly<Record<AgentsErrorCode, number>> = {
  invalid: 422,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  name_taken: 409,
  private_agents_unavailable: 403,
  unknown_model: 422,
  unknown_toolkit: 422,
  unknown_agent: 422,
  invalid_sandbox: 422,
};

/** Where the refused field is, for the panel's form. */
const PATH: Partial<Record<AgentsErrorCode, string>> = {
  unknown_model: "model",
  unknown_toolkit: "tool_scope",
  unknown_agent: "tool_scope",
  invalid_sandbox: "sandbox",
};

const orRefuse = orRefuseWith(STATUS, PATH);

const idParam = param("id");

const list = Effect.gen(function* () {
  const viewer = yield* currentViewer;

  return jsonReply(
    200,
    yield* agentsControlPlane("listAgents", (stub) => stub.agents().listAgents(viewer)),
  );
});

const mine = Effect.gen(function* () {
  const viewer = yield* currentViewer;

  return jsonReply(
    200,
    yield* agentsControlPlane("usableAgents", (stub) => stub.agents().usableAgents(viewer)),
  );
});

const get = Effect.gen(function* () {
  const viewer = yield* currentViewer;
  const id = yield* idParam;

  const result = yield* agentsControlPlane("getAgent", (stub) =>
    stub.agents().getAgent(viewer, id),
  );

  return jsonReply(200, yield* orRefuse(result));
});

const remove = Effect.gen(function* () {
  const viewer = yield* currentViewer;
  const id = yield* idParam;
  const revision = yield* ifMatch;

  const result = yield* agentsControlPlane("removeAgent", (stub) =>
    stub.agents().removeAgent(viewer, id, revision),
  );

  const removed = yield* orRefuse(result);

  // Its triggers and its runs went with it: their schedules' and runs' objects are deleted now (#228).
  yield* sweepRetiredSchedules(yield* AgentsEnv, yield* CurrentOrg);
  yield* sweepDeletedRuns(yield* AgentsEnv, yield* CurrentOrg);

  return jsonReply(200, removed);
});

/** The grants on shared agents are for org admins (`403 forbidden` otherwise). */
const adminOnly = Effect.gen(function* () {
  if (!(yield* currentViewer).admin)
    return yield* replyError(403, "forbidden", {
      message: "only an org admin manages who may use shared agents",
    });
});

/** Writes one agent grant (`value` `null` deletes it) and answers its id and new revision. */
const writeGrant = Effect.fnUntraced(function* (
  id: string | undefined,
  revision: number,
  value: AgentGrantBody | null,
) {
  const { principalId } = yield* AccessPrincipal;

  const result = yield* agentsControlPlane("writeGrant", (stub) =>
    stub.agents().writeGrant({ id, revision, value }, principalId),
  );

  return jsonReply(200, { status: "ok", ...(yield* orRefuse(result)) });
});

const listGrants = Effect.gen(function* () {
  yield* adminOnly;

  return jsonReply(
    200,
    yield* agentsControlPlane("listGrants", (stub) => stub.agents().listGrants()),
  );
});

const createGrant = Effect.gen(function* () {
  yield* adminOnly;

  return yield* writeGrant(undefined, 0, yield* decode(AgentGrantBody));
});

const replaceGrant = Effect.gen(function* () {
  yield* adminOnly;
  const id = yield* idParam;
  const revision = yield* ifMatch;

  return yield* writeGrant(id, revision, yield* decode(AgentGrantBody));
});

const removeGrant = Effect.gen(function* () {
  yield* adminOnly;
  const id = yield* idParam;
  const revision = yield* ifMatch;

  return yield* writeGrant(id, revision, null);
});

/**
 * Agents' management routes, checking what a definition names through `references` (the app Worker's adapter over
 * Models and Tools). Their handlers need `R` of the request besides what every management route has.
 */
export const managementRoutes = <R>(references: AgentReferences<R>) => {
  const create = Effect.gen(function* () {
    const viewer = yield* currentViewer;
    const { principalId } = yield* AccessPrincipal;
    const input = yield* decode(CreateAgent);
    const member = createsPrivate(viewer, input) ? viewer.member : undefined;

    const check = yield* checkReferences(references, member, {
      model: input.model,
      toolScope: input.tool_scope,
      sandbox: input.sandbox,
    });

    const result = yield* agentsControlPlane("createAgent", (stub) =>
      stub.agents().createAgent(viewer, input, check, principalId),
    );

    return jsonReply(201, yield* orRefuse(result));
  });

  const update = Effect.gen(function* () {
    const viewer = yield* currentViewer;
    const { principalId } = yield* AccessPrincipal;
    const id = yield* idParam;
    const revision = yield* ifMatch;
    const input = yield* decode(UpdateAgent);
    let check: ReferenceCheck = {};

    // What the edit names is checked against the reach of the agent's owner: its member's for a private agent (only
    // they manage it in full), the org's for a shared one. A limited view takes no definition edit at all.
    if (
      input.model !== undefined ||
      input.tool_scope !== undefined ||
      (input.sandbox !== undefined && input.sandbox !== null)
    ) {
      const found = yield* agentsControlPlane("getAgent", (stub) =>
        stub.agents().getAgent(viewer, id),
      );

      const agent = yield* orRefuse(found);

      if (!("limited" in agent))
        check = yield* checkReferences(references, agent.private ? viewer.member : undefined, {
          model: input.model,
          toolScope: input.tool_scope,
          sandbox: input.sandbox,
        });
    }

    const result = yield* agentsControlPlane("updateAgent", (stub) =>
      stub.agents().updateAgent(viewer, id, revision, input, check, principalId),
    );

    return jsonReply(200, yield* orRefuse(result));
  });

  return HttpRouter.addAll([
    route("GET", "/agents", list),
    route("GET", "/agents/mine", mine),
    route("POST", "/agents", create),
    route("GET", "/agents/:id", get),
    route("PATCH", "/agents/:id", update),
    route("DELETE", "/agents/:id", remove),
    route("GET", "/grants/agents", listGrants),
    route("POST", "/grants/agents", createGrant),
    route("PUT", "/grants/agents/:id", replaceGrant),
    route("DELETE", "/grants/agents/:id", removeGrant),
  ]).pipe(Layer.merge(runRoutes(references)), Layer.merge(triggerRoutes));
};
