// The test Worker's bindings (vitest.config.ts) as `env` from `cloudflare:workers` types them: what state's Durable
// Object classes read (`StateObjectEnv`), with the namespaces typed through the test Worker's classes (test/worker.ts),
// and Agents' `LOADER` and `AGENT_RUN`.
interface __AgentsTestEnv extends Omit<
  import("@commissary/state").StateObjectEnv,
  keyof import("@commissary/state").StateBindings
> {
  CONTROL_PLANE: DurableObjectNamespace<import("./worker.ts").ControlPlane>;
  PLATFORM: DurableObjectNamespace<import("./worker.ts").Platform>;
  SESSION_STATE: DurableObjectNamespace<import("./worker.ts").SessionState>;
  /** Dynamic Workers (`AgentsBindings`): the area's presence. */
  LOADER: WorkerLoader;
  /** The agent runs (`AgentsBindings`, #227), with no client API behind them. */
  AGENT_RUN: DurableObjectNamespace<import("./worker.ts").AgentRun>;
}

declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./worker.ts");
    durableNamespaces: "ControlPlane" | "SessionState" | "Platform" | "AgentRun";
  }

  interface Env extends __AgentsTestEnv {}
}
