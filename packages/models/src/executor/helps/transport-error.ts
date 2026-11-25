/** `fetch` failures without an HTTP answer, for the executors that share this mapping. */
import type { HttpClientError } from "effect/http";
import { ExecutionError } from "../errors.ts";

/** A failure with no HTTP answer: the conductor treats it as a transient transport error (no cooldown). */
export const transportError = (error: HttpClientError.HttpClientError) =>
  new ExecutionError({
    status: 500,
    code: "transient_transport",
    message: `upstream request failed: ${error.reason._tag}`,
    cause: error,
  });
