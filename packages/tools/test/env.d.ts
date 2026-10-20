// The test Worker's bindings (vitest.config.ts) as `env` from `cloudflare:workers` types them: what state's Durable
// Object classes read (`StateObjectEnv`), with the namespaces typed through the test Worker's classes (test/worker.ts).
interface __ToolsTestEnv extends Omit<
  import("@commissary/state").StateObjectEnv,
  keyof import("@commissary/state").StateBindings
> {
  CONTROL_PLANE: DurableObjectNamespace<import("./worker.ts").ControlPlane>;
  /** A deployment with a (fake) `browser` binding, and one with a fake second browser provider (#212). */
  BROWSER_CONTROL_PLANE: DurableObjectNamespace<import("./worker.ts").BrowserControlPlane>;
  OTHER_BROWSER_CONTROL_PLANE: DurableObjectNamespace<
    import("./worker.ts").OtherBrowserControlPlane
  >;
  /** The browser sessions' objects (#213), over a fake provider's browsers. */
  BROWSER_SESSIONS: DurableObjectNamespace<import("./worker.ts").BrowserSession>;
  /** A deployment that gains a `browser` binding once its storage says so (`UPGRADE_TO_BROWSER`). */
  UPGRADED_CONTROL_PLANE: DurableObjectNamespace<import("./worker.ts").UpgradedControlPlane>;
  /** The sandbox toolkit with Cloudflare's sandbox, and with a fake second sandbox provider (#222). */
  SANDBOX_CONTROL_PLANE: DurableObjectNamespace<import("./worker.ts").SandboxControlPlane>;
  OTHER_SANDBOX_CONTROL_PLANE: DurableObjectNamespace<
    import("./worker.ts").OtherSandboxControlPlane
  >;
  /** The sandbox's sessions, and the Dynamic Workers their just-bash runs in (`ToolsPartEnv`). */
  SANDBOX_SESSION: DurableObjectNamespace<import("./worker.ts").SandboxSession>;
  LOADER: WorkerLoader;
  PLATFORM: DurableObjectNamespace<import("./worker.ts").Platform>;
  SESSION_STATE: DurableObjectNamespace<import("./worker.ts").SessionState>;
  /** The usage database the MCP endpoint writes tool calls' records to (`ToolsBindings`). */
  USAGE: D1Database;
  /** The OAuth server's store for MCP clients (#200, `ToolsBindings`); the stage stays self-hosted without the rest. */
  OAUTH_KV: KVNamespace;
}

declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./worker.ts");
    durableNamespaces:
      | "ControlPlane"
      | "BrowserControlPlane"
      | "OtherBrowserControlPlane"
      | "UpgradedControlPlane"
      | "BrowserSession"
      | "SandboxControlPlane"
      | "OtherSandboxControlPlane"
      | "SandboxSession"
      | "SessionState"
      | "Platform";
  }

  interface Env extends __ToolsTestEnv {}
}

/** `@cloudflare/playwright`'s client page (vitest.config.ts aliases it): only what the canary reads of it. */
declare module "playwright-client-page" {
  export const Page: { readonly prototype: object };
}
