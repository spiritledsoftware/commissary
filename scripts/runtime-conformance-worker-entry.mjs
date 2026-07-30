import { runRuntimeConformance } from "./runtime-conformance-suite.mjs";

export default {
  async fetch() {
    try {
      return Response.json({ ok: true, result: await runRuntimeConformance() });
    } catch (error) {
      return Response.json(
        {
          ok: false,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        },
        { status: 500 },
      );
    }
  },
};
