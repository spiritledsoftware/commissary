// The test Worker's bindings beyond the app Worker's (`Env`, src/env.d.ts), as `env` from `cloudflare:workers` types
// them: the test Worker also runs the state Worker's classes (test/worker.ts), so it binds what only they read, the
// secrets keys (`@commissary/state`'s `secrets/`; deployed, only the state Worker binds them, apps/state/src/env.d.ts),
// and the browser sessions' namespace (deployed, the state Worker's own).
declare namespace Cloudflare {
  interface Env {
    /** Secrets key of the stage: wraps every org's data key. */
    SECRETS_KEY: string;
    /** During a rotation, the secrets key `SECRETS_KEY` replaces. */
    SECRETS_KEY_PREVIOUS?: string;
    /** The browser sessions' objects (#213), over a fake provider's browsers (test/worker.ts). */
    BROWSER_SESSIONS: DurableObjectNamespace<
      import("@commissary/tools/testing").FakeBrowserSession
    >;
  }
}
