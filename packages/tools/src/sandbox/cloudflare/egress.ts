/**
 * The sandbox's one egress point (ADR 0044, #222): every request a sandbox makes arrives here, and nowhere else. The
 * Dynamic Worker that runs a session's just-bash has this entrypoint as its `globalOutbound` (`session.ts`), never the
 * runtime's default, and the computer (#223) sends its outbound traffic here too. Its props carry the session's network
 * and the outbound guard's policy; it answers a refused request by failing it (the command's `curl` fails, as with no
 * network at all), and forwards an allowed one without following redirects, so each hop comes back here to be checked.
 *
 * It carries no credential: a request leaves with what the sandbox put in it and nothing more (ADR 0041).
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import type { OutboundPolicy } from "@commissary/core";
import { egressRefusal, type SandboxNetwork } from "../network.ts";

/** What a session hands its egress: its network, and the outbound guard's policy. */
export interface SandboxEgressProps {
  readonly network: SandboxNetwork;
  readonly policy: OutboundPolicy;
}

/** The filtering entrypoint; the state Worker exports it from its main module, so `ctx.exports` reaches it. */
export class SandboxEgress extends WorkerEntrypoint<unknown, SandboxEgressProps> {
  override async fetch(request: Request): Promise<Response> {
    const refused = egressRefusal(request.url, this.ctx.props.network, this.ctx.props.policy);

    if (refused !== undefined) throw new Error(`Commissary refused the request: ${refused}`);

    return await fetch(request, { redirect: "manual" });
  }
}
