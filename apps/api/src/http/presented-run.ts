/**
 * The agent run a client API request comes from (#227): set only by the run gateway (`run-gateway.ts`), the API
 * Worker's own entrypoint that its `AgentRun` objects reach over `ctx.exports`, and read by the client gate
 * (`gate.ts`), which then resolves the run's principal from the org's ControlPlane instead of reading a credential. It
 * is never derived from a request: the public `fetch` handler's context (`worker-env.ts` `requestContext`) has none, so
 * no header, path or body can make a request a run's (docs/ARCHITECTURE.md, "Agents", the trust boundary).
 */
import { Context } from "effect";
import type { OrgId } from "@commissary/core";

export class PresentedRun extends Context.Service<
  PresentedRun,
  { readonly org: OrgId; readonly run: string }
>()("commissary/api/PresentedRun") {}
