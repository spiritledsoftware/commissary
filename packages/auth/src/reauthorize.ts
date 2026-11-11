/**
 * Authenticating a request again while it is still running. New in the Workers port (CLIProxyAPI b9bb031d re-runs the
 * AccessManager before every Responses WebSocket turn).
 */
import { Context, Effect } from "effect";
import type { AccessError } from "./gate.ts";
import type { AccessIdentity } from "./principal.ts";

/**
 * Authenticates the current request again. A Worker's client gate provides it next to `AccessPrincipal` for a request
 * that may outlive its authentication, such as a Responses WebSocket: the socket asks it before every turn
 * (`reauthorizeClient`). An API key is verified again, so a key revoked, or a member removed or suspended, after the
 * upgrade stops working on the live socket. An Access sign-in is bounded by its token's `exp` and re-checked for
 * membership. It fails as the gate would.
 */
export class RequestReauthorizer extends Context.Service<
  RequestReauthorizer,
  Effect.Effect<AccessIdentity, AccessError>
>()("commissary/auth/RequestReauthorizer") {}
