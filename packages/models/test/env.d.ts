// The test Worker's bindings (vitest.config.ts) as `env` from `cloudflare:workers` types them: what Models reads
// (`ModelsBindings`), what state's Durable Object classes read (`StateObjectEnv`) and what the client API harness's gate
// reads (`AuthBindings`), with the namespaces typed through the test Worker's classes (test/worker.ts).
interface __ModelsTestEnv extends Omit<
  import("../src/env.ts").ModelsBindings &
    import("@commissary/state").StateObjectEnv &
    import("@commissary/auth").AuthBindings,
  keyof import("@commissary/state").StateBindings | "CONTROL_PLANE" | "SESSION_STATE"
> {
  CONTROL_PLANE: DurableObjectNamespace<import("./worker.ts").ControlPlane>;
  PLATFORM: DurableObjectNamespace<import("./worker.ts").Platform>;
  SESSION_STATE: DurableObjectNamespace<import("./worker.ts").SessionState>;
  /** The Models part's own hosts for the outbound guard (`ModelsPartEnv`); none under test. */
  OWN_HOSTS: string;
}

declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./worker.ts");
    durableNamespaces: "ControlPlane" | "SessionState" | "Platform";
  }

  interface Env extends __ModelsTestEnv {}
}
