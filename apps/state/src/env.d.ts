// Bindings and variables of the state Worker: what its Durable Object classes read from the `env` they are constructed
// with (`@commissary/state`'s `StateObjectEnv`, the Models part's `ModelsPartEnv`, the Tools part's `ToolsPartEnv` and
// Tools' browser sessions' `BrowserSessionEnv`), nothing else. Deployed values come from the `State` Worker's `env` in
// `alchemy.run.ts`; keep both in sync. The app's test Worker (apps/app/test/worker.ts) runs these classes with the
// app's bindings, a superset.
type __StateObjectSettings = Omit<
  import("@commissary/state").StateObjectEnv,
  keyof import("@commissary/state").StateBindings
> &
  import("@commissary/models/state").ModelsPartEnv &
  import("@commissary/tools/state").ToolsPartEnv &
  import("@commissary/tools/state").BrowserSessionEnv;

interface __StateWorkerEnv extends __StateObjectSettings {
  /**
   * `cloud` on Commissary Cloud (ADR 0026). The Tools part reads it (`ToolsPartEnv`): only there do toolkits from the
   * catalog sign in with Commissary Cloud's managed OAuth apps (#207), whose client secrets are this Worker's bindings
   * the catalog additions name (`TOOLKIT_OAUTH_*`), read by name and not declared here (docs/DEPLOY.md).
   */
  COMMISSARY_MODE?: string;
  CONTROL_PLANE: DurableObjectNamespace<import("./index.ts").ControlPlane>;
  SESSION_STATE: DurableObjectNamespace<import("./index.ts").SessionState>;
  /** The Platform registry: one object per deployment (`platformOf`, `@commissary/state`). */
  PLATFORM: DurableObjectNamespace<import("./index.ts").Platform>;
  /** One object per browser session (#213, `@commissary/tools/state`), reached by the ControlPlane's Tools part. */
  BROWSER_SESSIONS: DurableObjectNamespace<import("./index.ts").BrowserSession>;
  /** Usage records (D1, migrations/usage/): a browser session's record of its browser time (#214, `BrowserSessionEnv`). */
  USAGE: D1Database;
  /** The sandbox toolkit's sessions (#222), one object each; the Tools part reaches them (`ToolsPartEnv`). */
  SANDBOX_SESSION: DurableObjectNamespace<import("./index.ts").SandboxSession>;
}

declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./index.ts");
    durableNamespaces:
      | "ControlPlane"
      | "SessionState"
      | "Platform"
      | "BrowserSession"
      | "SandboxSession";
  }

  interface Env extends __StateWorkerEnv {}
}

interface Env extends __StateWorkerEnv {}

// @commissary/translation's tokenizer ranks, compiled with the Models part: `Data` modules (ArrayBuffer).
declare module "*.bin" {
  const data: ArrayBuffer;
  export default data;
}
