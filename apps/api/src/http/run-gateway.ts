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
import { Context, Effect, Schema } from "effect";
import { type AgentRunEnv, AgentRunObject, type RunGateway } from "@commissary/agents/api";
import type {
  RunToolReport,
  RunToolSettled,
  SandboxEnvReply,
  SandboxEnvRequest,
} from "@commissary/contract/sandbox-env";
import { CurrentOrg, OrgId, type WorkerExecutionContext } from "@commissary/core";
import { retryOnCodeUpdate } from "@commissary/state";
import { runSandboxOperation, settleRunToolCall } from "@commissary/tools/api";
import { type ApiWorkerBindings, type EnvServices, requestContext } from "../worker-env.ts";
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

  /**
   * One operation of the run's call that the MCP endpoint gated (#230), on the run's sandbox session: the Tools part
   * runs it only with the call's live ticket, which binds it to this run, its session and its tool.
   */
  async sandboxOperation(
    org: OrgId,
    run: string,
    ticket: string,
    request: SandboxEnvRequest,
  ): Promise<SandboxEnvReply> {
    if (!isOrgId(org) || run === "")
      return { ok: false, reason: "ticket", message: "The call has no valid ticket." };

    return await this.#inOrg(
      org,
      runSandboxOperation(run, ticket, request).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("run gateway: sandbox operation failed").pipe(
            Effect.annotateLogs({ run, status: cause.response.status }),
            Effect.as<SandboxEnvReply>({
              ok: false,
              reason: "failed",
              message: "Commissary could not reach the org's tools.",
            }),
          ),
        ),
      ),
    );
  }

  /**
   * Settles the run's gated call `ticket` (#230) with how it ended, which writes its usage record once. Rejects when
   * the org's tools cannot be reached: the run settles it again.
   */
  async settleToolCall(
    org: OrgId,
    run: string,
    ticket: string,
    report: RunToolReport,
  ): Promise<RunToolSettled> {
    if (!isOrgId(org) || run === "") return { recorded: false };

    return await this.#inOrg(org, settleRunToolCall(run, ticket, report));
  }

  /** Runs `effect` with this Worker's services, as the org `org`. */
  async #inOrg<A, E>(
    org: OrgId,
    effect: Effect.Effect<A, E, EnvServices | WorkerExecutionContext | CurrentOrg>,
  ): Promise<A> {
    return await Effect.runPromise(
      effect.pipe(
        Effect.provideContext(
          requestContext(retryOnCodeUpdate(this.env), this.ctx).pipe(Context.add(CurrentOrg, org)),
        ),
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
