// The test Worker's bindings (vitest.config.ts) as `env` from `cloudflare:workers` types them: what state's Durable
// Object classes read (`StateObjectEnv`), with the namespaces typed through the test Worker's classes (test/worker.ts),
// and Agents' `LOADER`, `AGENT_RUN`, `AGENT_SCHEDULE`, `API_DOMAIN` and `APP_DOMAIN`.
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
  /** The schedule triggers' ticks (`AgentsBindings`, #231). */
  AGENT_SCHEDULE: DurableObjectNamespace<import("./worker.ts").AgentSchedule>;
  /** The API host (`AgentsBindings`), where webhooks' URLs point. */
  API_DOMAIN: string;
  /** The panel's host (`AgentsBindings`, #232). */
  APP_DOMAIN: string;
}

declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./worker.ts");
    durableNamespaces: "ControlPlane" | "SessionState" | "Platform" | "AgentRun" | "AgentSchedule";
  }

  interface Env extends __AgentsTestEnv {}
}
