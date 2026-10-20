/**
 * The run gateway (#227): how a hosted agent's run reaches the client API, for its model calls (`/v1/...`), and the MCP
 * endpoint, for its tool calls (`/mcp`), as its own principal, with no API key. The run's Durable Object ({@link
 * AgentRun}, Agents' `AgentRunObject`) lives in this Worker and calls this entrypoint over its loopback binding
 * (`ctx.exports.AgentRunGateway`), handing it the run's org and id with each request.
 *
 * **The trust boundary** is the Cloudflare account, as for the Durable Objects: the internet reaches only this
 * Worker's default `fetch` handler, never a named entrypoint, and no Worker of the deployment binds this one
 * (alchemy.run.ts declares no service binding to it), but any Worker deployed to the same account could. Within the
 * deployment, the run's object keeps the gateway in a private field that no RPC method exposes (the app Worker binds
 * the object, not the gateway), and takes a start only for the run its name says it is, so a caller of the object
 * cannot make it act as another run. The run's principal is not taken from the caller either: the gate resolves it
 * from the org's ControlPlane (`runPrincipal`) on every request, from the definition the run's running turn read, so
 * an unknown or ended run, or one acting as a member who left, is refused. From there the request is any client's:
 * grants, reach (narrowed to the definition), tool scope, spend limits, prices, approval rules, usage records and the
 * plan's request-rate ceiling apply unchanged.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import { Context, Schema } from "effect";
import { type AgentRunEnv, AgentRunObject, type RunGateway } from "@commissary/agents/api";
import { OrgId } from "@commissary/core";
import { retryOnCodeUpdate } from "@commissary/state";
import { type ApiWorkerBindings, requestContext } from "../worker-env.ts";
import { handler } from "./handler.ts";
import { PresentedRun } from "./presented-run.ts";

const isOrgId = Schema.is(OrgId);

export class AgentRunGateway extends WorkerEntrypoint<ApiWorkerBindings> implements RunGateway {
  /** Serves `request` (the client API or the MCP endpoint) as the run `run` of `org`. */
  async serve(org: OrgId, run: string, request: Request): Promise<Response> {
    // Checked again: an RPC argument is whatever the caller sent.
    if (!isOrgId(org) || run === "") return new Response("unknown run", { status: 400 });

    return await handler(
      request,
      requestContext(retryOnCodeUpdate(this.env), this.ctx, request.url).pipe(
        Context.add(PresentedRun, { org, run }),
      ),
    );
  }
}

/** What this Worker's `ctx.exports` holds of the run gateway. */
interface LoopbackExports {
  readonly AgentRunGateway?: RunGateway;
}

/**
 * The agent run's Durable Object as this Worker defines it (ADR 0030's amendment; the app Worker binds it by this
 * Worker's script name): Agents' run object, wired with the run gateway above over this Worker's loopback binding.
 * `options` are dev-only (src/dev.ts); the runtime constructs the class with none.
 */
export class AgentRun extends AgentRunObject {
  constructor(
    ctx: DurableObjectState,
    env: AgentRunEnv,
    options: { readonly unnamedInDev?: boolean } = {},
  ) {
    super(ctx, env, {
      gateway: () => {
        // SAFETY: this Worker's main module exports `AgentRunGateway` (index.ts, and the test Workers that run this
        // class), so `ctx.exports` holds its loopback binding, whose RPC stub has `RunGateway`'s method. Typed loosely
        // because another Worker's project (the app Worker's tests) types `ctx.exports` after its own main module.
        const gateway = (ctx.exports as LoopbackExports).AgentRunGateway;

        if (gateway === undefined) throw new Error("the Worker exports no run gateway");

        return gateway;
      },
      ...options,
    });
  }
}
