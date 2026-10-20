// The test Worker's bindings (vitest.config.ts) as `env` from `cloudflare:workers` types them: what state's Durable
// Object classes read (`StateObjectEnv`), with the namespaces typed through the test Worker's classes (test/worker.ts).
interface __ToolsTestEnv extends Omit<
  import("@commissary/state").StateObjectEnv,
  keyof import("@commissary/state").StateBindings
> {
  CONTROL_PLANE: DurableObjectNamespace<import("./worker.ts").ControlPlane>;
  PLATFORM: DurableObjectNamespace<import("./worker.ts").Platform>;
  SESSION_STATE: DurableObjectNamespace<import("./worker.ts").SessionState>;
  /** The usage database the MCP endpoint writes tool calls' records to (`ToolsBindings`). */
  USAGE: D1Database;
}

declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./worker.ts");
    durableNamespaces: "ControlPlane" | "SessionState" | "Platform";
  }

  interface Env extends __ToolsTestEnv {}
}
