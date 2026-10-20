// An agent run's standing on Commissary Cloud (#227, packages/auth/src/standing.ts): the run gateway serves a run's
// request only while its org and its starter are in good standing, for a shared agent's run too, which acts as no
// member. The run is set up straight through the org's ControlPlane (its agent, the run and its turn); the gateway is
// this Worker's own entrypoint, as the run's object reaches it. Suspension is set on the Platform registry, as in
// gate.test.ts.
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { resetStandingCaches } from "@commissary/auth";
import { platformOf } from "@commissary/state";
import { addMember } from "../support/client.ts";
import { keyedOrg } from "./support.ts";

beforeEach(() => {
  resetStandingCaches();
});

/** The owned-org limit of a person the tests suspend (the app Worker's `OWNED_ORG_LIMIT` default). */
const ORG_LIMIT = 3;

const STARTER = "starter@example.com";

const listModels = () => new Request("https://client-api.agent-run.invalid/v1/models");

describe("a shared agent's run", () => {
  it("is refused at once while its starter is suspended", async () => {
    const { org, member: owner } = await keyedOrg("agents-owner@example.com");
    const starter = await addMember(org, STARTER, "member");
    const agents = env.CONTROL_PLANE.getByName(org).agents();

    const created = await agents.createAgent(
      { member: owner, admin: true },
      {
        name: "support",
        description: "The support agent",
        instructions: "Answer briefly.",
        model: "agent-model",
        tool_scope: [],
        subject: { kind: "member", id: starter.id },
      },
      { modelServed: true },
      "test",
    );

    if (!created.ok) throw new Error(created.message);

    const started = await agents.startRun(
      { member: starter.id, admin: false },
      created.value.id,
      "chat",
      undefined,
    );

    if (!started.ok) throw new Error(started.message);
    const run = started.value.run.id;

    expect(await agents.beginTurn(run)).toMatchObject({ ok: true });
    expect((await exports.AgentRunGateway.serve(org, run, listModels())).status).toBe(200);

    const suspend = async (suspended: boolean) => {
      await platformOf(env).updatePerson(STARTER, { suspended }, Date.now(), ORG_LIMIT);
      resetStandingCaches();
    };

    await suspend(true);

    const refused = await exports.AgentRunGateway.serve(org, run, listModels());

    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "Suspended" });

    await suspend(false);
    expect((await exports.AgentRunGateway.serve(org, run, listModels())).status).toBe(200);
  });
});
