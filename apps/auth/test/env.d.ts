// The test Worker's bindings beyond the auth Worker's (`Env`, src/env.d.ts), as `env` from `cloudflare:workers` types
// them: the test Worker also runs the state Worker's classes (test/worker.ts), so it binds what only they read
// (apps/state/src/env.d.ts; deployed, only the state Worker binds them).
declare namespace Cloudflare {
  interface Env {
    COMMISSARY_MODE: string;
    ACCESS_TEAM_DOMAIN: string;
    ACCESS_AUD: string;
    PLATFORM_ADMIN_EMAILS: string;
    PLATFORM_ADMIN_SERVICE_TOKENS: string;
    META_MINT_URL: string;
    AUTH_INDEX_KEY: string;
    SECRETS_KEY: string;
    /** The sandbox toolkit's sessions and the Dynamic Workers they run just-bash in (#222, `ToolsPartEnv`). */
    SANDBOX_SESSION: DurableObjectNamespace<import("@commissary/state-worker").SandboxSession>;
    LOADER: WorkerLoader;
  }
}

// @commissary/translation's tokenizer ranks, which the state Worker's classes the test Worker runs import: `Data`
// modules (vitest.config.ts `modulesRules`).
declare module "*.bin" {
  const data: ArrayBuffer;
  export default data;
}
