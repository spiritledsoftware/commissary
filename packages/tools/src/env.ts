/**
 * What `@commissary/tools` reads from a Worker's env (#134 "How packages get their bindings"): the org's ControlPlane,
 * typed as objects with the Tools part ({@link ToolsControlPlane}), so callers write `stub.tools().x(…)`, and, for the
 * MCP endpoint's connect links, the Platform registry and the app host, the API host, where toolkit sign-ins name
 * Commissary's CIMD document (#202), the usage database its tool calls' records go into (#199, `USAGE`, the D1
 * database Models' records go into too), the deployment's KV namespace `CACHE`, where the toolkit catalog's refreshed
 * registry is kept (#207), and on Commissary Cloud its OAuth server for MCP clients (#200: `OAUTH_KV`,
 * `MCP_OAUTH_ISSUER`, `MCP_OAUTH_RESOURCE`). Its state is the ControlPlane's, and it reaches MCP servers through the
 * global `fetch` behind the outbound guard. Its ControlPlane part reads values of the state Worker's apart from these
 * (`ToolsPartEnv`, `toolkits/built-in.ts`): Browser Run's optional `BROWSER` (#212) with its crawls' optional
 * `BROWSER_RUN_ACCOUNT_ID` and `BROWSER_RUN_API_TOKEN` (#270), `OWN_HOSTS`, which its alarm's
 * token refreshes refuse (#202), the sandbox's (#222) Worker Loader `LOADER` and `SandboxSession` namespace
 * `SANDBOX_SESSION`, which the sessions' objects read too (`SandboxSessionEnv`, `sandbox/cloudflare/session.ts`), and
 * on Commissary Cloud the client secrets of its managed OAuth apps (#207, `TOOLKIT_OAUTH_*`, named by the catalog
 * additions and read by name, `catalog/managed-apps.ts`): only the state Worker binds them.
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
  | "replaceDocument"
  | "toolkitDocument"
  | "removeToolkit"
  | "connectCredential"
  | "disconnectCredential"
  | "refreshToolList"
  | "refreshToolLists"
  | "listTools"
  | "servedTools"
  | "clientTools"
  | "usableTools"
  | "keyToolSummaries"
  | "callTool"
  | "setOverride"
  | "listGrants"
  | "writeGrant"
  | "listApprovals"
  | "getApproval"
  | "decideApproval"
  | "exportToolkits"
  | "setOAuthApp"
  | "clearOAuthApp"
  | "startSignIn"
  | "signInStatus"
  | "completeSignIn"
  | "purgeSandboxSessions"
  | "listProfiles"
  | "createProfile"
  | "updateProfile"
  | "removeProfile"
  | "listProfileGrants"
  | "writeProfileGrant"
  | "purgeBrowserCrawls"
  | "browserSessionClosed"
  | "purgeBrowserSessions"
  | "hasManagedApp"
  | "takeCatalogLookup";

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
   * deployed stage, one host or split, and where the callback Commissary's CIMD document names is (#202). Unset (a
   * preview, `alchemy dev`), a connect link names the page in words, and the API Worker serves no CIMD document.
   */
  readonly APP_DOMAIN?: string | undefined;
  /**
   * The API host, where the app Worker's toolkit sign-ins name Commissary's CIMD document (#202); unset on a stage with
   * one host, whose zone route sends the document's path on the app host to the API Worker.
   */
  readonly API_DOMAIN?: string | undefined;
  /** Usage records (D1, `migrations/usage/`): one per tool call (#199), beside Models' model attempts. */
  readonly USAGE: D1Database;
  /**
   * The deployment's KV namespace (Models' too), where the toolkit catalog's refreshed registry is kept (#207), through
   * a `DeploymentKv` only (`kv.ts`, ADR 0044).
   */
  readonly CACHE: KVNamespace;
  /** `cloud` on Commissary Cloud (ADR 0026), the only deployment with an OAuth server for MCP clients (#200). */
  readonly COMMISSARY_MODE?: string | undefined;
  /**
   * Commissary Cloud's OAuth server for MCP clients (#200, `oauth/config.ts`): the KV namespace
   * `@cloudflare/workers-oauth-provider` keeps its clients, grants, tokens and consent transactions in (its own layout,
   * not an `OrgKv`: a grant is keyed by the org and member it was issued to), bound on the app and API Workers of the
   * `cloud` stage only.
   */
  readonly OAUTH_KV?: KVNamespace | undefined;
  /** The OAuth server's issuer, `https://<app host>`; with {@link OAUTH_KV} only. */
  readonly MCP_OAUTH_ISSUER?: string | undefined;
  /** The MCP endpoint as the OAuth server's one resource, `https://<API host>/mcp`; with {@link OAUTH_KV} only. */
  readonly MCP_OAUTH_RESOURCE?: string | undefined;
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
