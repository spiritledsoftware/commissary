/**
 * What `@commissary/tools` reads from a Worker's env (#134 "How packages get their bindings"): the org's ControlPlane,
 * typed as objects with the Tools part ({@link ToolsControlPlane}), so callers write `stub.tools().x(…)`, and, for the
 * MCP endpoint's connect links, the Platform registry and the app host. Tools needs no binding of its own: its state is
 * the ControlPlane's, and it reaches MCP servers through the global `fetch` behind the outbound guard.
 */
import { Context, Effect } from "effect";
import { CurrentOrg, type Reply } from "@commissary/core";
import { callControlPlane, controlPlaneOf, type StateBindings } from "@commissary/state";
import type { ToolsPart } from "./control-plane-part.ts";

/** The methods of the Tools part callers reach. */
type ToolsPartMethod =
  | "listToolkits"
  | "addToolkit"
  | "updateToolkit"
  | "removeToolkit"
  | "connectCredential"
  | "disconnectCredential"
  | "refreshToolList"
  | "refreshToolLists"
  | "listTools"
  | "servedTools"
  | "clientTools"
  | "callTool"
  | "setOverride"
  | "exportToolkits";

/** The Tools part of an org's ControlPlane (`ToolsPart`) as Tools sees it: the methods it calls. */
export type ToolsControlPlanePart = Pick<ToolsPart, ToolsPartMethod> & Rpc.RpcTargetBranded;

/** Tools' view of an org's ControlPlane: its part, reached in one pipelined round trip (`stub.tools().x(…)`). */
export interface ToolsControlPlane extends Rpc.DurableObjectBranded {
  tools(): ToolsControlPlanePart;
}

export type ToolsControlPlaneStub = DurableObjectStub<ToolsControlPlane>;

export interface ToolsBindings {
  /** One ControlPlane per org, seen through {@link ToolsControlPlane}. */
  readonly CONTROL_PLANE: DurableObjectNamespace<ToolsControlPlane>;
  /** The Platform registry, which names the org's slug in the MCP endpoint's connect links (#197). */
  readonly PLATFORM: StateBindings["PLATFORM"];
  /**
   * The app host (ADR 0028), where the panel's connect page is (`panelPageUrl`), bound on the API Worker on every
   * deployed stage, one host or split. Unset (a preview, `alchemy dev`), a connect link names the page in words.
   */
  readonly APP_DOMAIN?: string | undefined;
}

/**
 * The Tools bindings of the current Worker invocation. Provided per request through the `Context` handed to the web
 * handler (`requestContext`), never through a long-lived layer: bindings must not be captured across requests.
 */
export class ToolsEnv extends Context.Service<ToolsEnv, ToolsBindings>()(
  "commissary/tools/ToolsEnv",
) {}

/** The ControlPlane of the current org, seen through {@link ToolsControlPlane}. */
export const currentToolsControlPlane: Effect.Effect<
  ToolsControlPlaneStub,
  never,
  ToolsEnv | CurrentOrg
> = Effect.gen(function* () {
  return controlPlaneOf(yield* ToolsEnv, yield* CurrentOrg);
});

/** Calls the current org's ControlPlane from a Tools management route (`callControlPlane`). */
export const toolsControlPlane = <R>(
  label: string,
  call: (stub: ToolsControlPlaneStub) => R,
): Effect.Effect<Awaited<R>, Reply, ToolsEnv | CurrentOrg> =>
  Effect.flatMap(currentToolsControlPlane, (stub) => callControlPlane(label, stub, call));
