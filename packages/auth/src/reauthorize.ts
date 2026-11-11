/**
 * Authenticating a request again while it is still running. New in the Workers port (CLIProxyAPI b9bb031d re-runs the
 * AccessManager before every Responses WebSocket turn).
 */
import { Context, Effect } from "effect";
import type { AccessError } from "./gate.ts";
import type { AccessIdentity } from "./principal.ts";

/**
 * Authenticates the current request again. A Worker's client gate provides it next to `AccessPrincipal` for a request
 * that may outlive its authentication, such as a Responses WebSocket: the socket asks it before every turn, so a key
 * revoked, a grant withdrawn or a person suspended after the upgrade stops working on the live socket. It runs the
 * gate's own authentication over the request's headers and fails as the gate would.
 */
export class RequestReauthorizer extends Context.Service<
  RequestReauthorizer,
  Effect.Effect<AccessIdentity, AccessError>
>()("commissary/auth/RequestReauthorizer") {}
