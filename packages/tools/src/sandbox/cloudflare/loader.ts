/**
 * The Worker Loader as the sandbox's shell gets it (ADR 0044, #222): `@cloudflare/computer`'s worker-shell backend
 * builds the Dynamic Worker's code, and this wrapper holds that code to what a sandbox may have, whatever the backend
 * asks for. Its one binding is the Workspace's proxy (`HOST`), and its `globalOutbound` is the sandbox's egress
 * entrypoint, never the runtime's default.
 */
import type { WorkerShellLoader } from "@cloudflare/computer/backends/worker-shell";

/**
 * `loader` as the worker-shell backend uses it, holding the Dynamic Worker to what a sandbox may have: no binding but
 * the Workspace's proxy (`HOST`), and `gateway` as its `globalOutbound`, whatever the backend's code says.
 */
export const guardedLoader = (loader: WorkerLoader, gateway: Fetcher): WorkerShellLoader => ({
  get: (name, getCode) =>
    loader.get(name, async () => {
      const code = await getCode();
      const extra = Object.keys(code.env ?? {}).filter((binding) => binding !== "HOST");

      if (extra.length > 0)
        throw new Error(`a sandbox gets no bindings beyond its files, not ${extra.join(", ")}`);

      // What the backend asked for, field by field, with the gateway as its egress: anything else it may add is left out.
      const guarded: WorkerLoaderWorkerCode = {
        compatibilityDate: code.compatibilityDate,
        mainModule: code.mainModule,
        modules: code.modules,
        env: code.env,
        globalOutbound: gateway,
      };

      if (code.compatibilityFlags !== undefined)
        guarded.compatibilityFlags = code.compatibilityFlags;

      return guarded;
    }),
});
