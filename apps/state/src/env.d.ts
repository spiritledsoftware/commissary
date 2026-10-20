// Bindings and variables of the state Worker: what its Durable Object classes read from the `env` they are constructed
// with (`@commissary/state`'s `StateObjectEnv`, the Models part's `ModelsPartEnv` and the Tools part's `ToolsPartEnv`),
// nothing else. Deployed values come from the `State` Worker's `env` in `alchemy.run.ts`; keep both in sync. The app's
// test Worker (apps/app/test/worker.ts) runs these classes with the app's bindings, a superset.
type __StateObjectSettings = Omit<
  import("@commissary/state").StateObjectEnv,
  keyof import("@commissary/state").StateBindings
> &
  import("@commissary/models/state").ModelsPartEnv &
  import("@commissary/tools/state").ToolsPartEnv;

interface __StateWorkerEnv extends __StateObjectSettings {
  CONTROL_PLANE: DurableObjectNamespace<import("./index.ts").ControlPlane>;
  SESSION_STATE: DurableObjectNamespace<import("./index.ts").SessionState>;
  /** The Platform registry: one object per deployment (`platformOf`, `@commissary/state`). */
  PLATFORM: DurableObjectNamespace<import("./index.ts").Platform>;
}

declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./index.ts");
    durableNamespaces: "ControlPlane" | "SessionState" | "Platform";
  }

  interface Env extends __StateWorkerEnv {}
}

interface Env extends __StateWorkerEnv {}

// @commissary/translation's tokenizer ranks, compiled with the Models part: `Data` modules (ArrayBuffer).
declare module "*.bin" {
  const data: ArrayBuffer;
  export default data;
}
