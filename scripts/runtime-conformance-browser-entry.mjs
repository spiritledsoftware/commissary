import { runRuntimeConformance } from "./runtime-conformance-suite.mjs";

globalThis.commissaryRuntimeConformance = runRuntimeConformance().then(
  (result) => ({ ok: true, result }),
  (error) => ({
    ok: false,
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  }),
);
