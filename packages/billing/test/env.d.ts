// The test Worker's bindings (vitest.config.ts) as `env` from `cloudflare:workers` types them: what Billing reads
// (`BillingBindings`) and what state's Durable Object classes read (`StateObjectEnv`), with the namespaces typed through
// the test Worker's classes (test/worker.ts).
interface __BillingTestEnv extends Omit<
  import("../src/env.ts").BillingBindings & import("@commissary/state").StateObjectEnv,
  keyof import("@commissary/state").StateBindings | "CONTROL_PLANE" | "SESSION_STATE"
> {
  CONTROL_PLANE: DurableObjectNamespace<import("./worker.ts").ControlPlane>;
  PLATFORM: DurableObjectNamespace<import("./worker.ts").Platform>;
  SESSION_STATE: DurableObjectNamespace<import("./worker.ts").SessionState>;
}

declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./worker.ts");
    durableNamespaces: "ControlPlane" | "SessionState" | "Platform";
  }

  interface Env extends __BillingTestEnv {}
}
