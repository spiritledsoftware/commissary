import { makeWebHandler } from "./app.ts";

/**
 * The API Worker's web handler, built once per isolate (its router included) and shared by the public `fetch` handler
 * (`index.ts`) and the run gateway (`run-gateway.ts`); `env`/`ctx` are provided per request.
 */
export const { handler } = makeWebHandler();
