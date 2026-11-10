/**
 * Meta `response.subscription_usage` filter.
 *
 * Go source: internal/runtime/executor/meta_executor_execute.go (`isMetaSubscriptionUsageEvent`, the filtering in
 * `translateMetaCompleted`) and meta_executor_stream.go (ExecuteStream). Meta interleaves account subscription telemetry
 * (`event: response.subscription_usage` frames, or bare `data: {"subscription":{...}}`) with the Responses events; it never
 * reaches callers. An `event:` line is held back until its data line shows it is not telemetry.
 */
import { asString, get, isJsonObject, tryParseJson } from "@commissary/json";
import type { SseLineFilter } from "../helps/responses-sse.ts";

const SUBSCRIPTION_USAGE = "response.subscription_usage";

export const makeSubscriptionUsageFilter = (): SseLineFilter => {
  let pending: string | undefined;
  let filtering = false;
  let skipBlank = false;

  const takePending = (): string[] => {
    const held = pending === undefined ? [] : [pending];
    pending = undefined;

    return held;
  };

  const push = (line: string): string[] => {
    const trimmed = line.trim();

    if (trimmed.startsWith("event:")) {
      if (trimmed.slice(6).trim() === SUBSCRIPTION_USAGE) {
        const held = takePending();
        filtering = true;
        skipBlank = true;

        return held;
      }

      filtering = false;
      skipBlank = false;
      const held = takePending();
      pending = line;

      return held;
    }

    if (!trimmed.startsWith("data:")) {
      if (trimmed === "") {
        filtering = false;

        if (skipBlank) {
          skipBlank = false;

          return [];
        }
      }

      if (filtering) return [];
      skipBlank = false;

      return [...takePending(), line];
    }

    const data = trimmed.slice(5).trim();
    const event = tryParseJson(data);
    const type = asString(get(event, "type"));

    if (type === SUBSCRIPTION_USAGE || (type === "" && isJsonObject(get(event, "subscription")))) {
      pending = undefined;
      filtering = false;
      skipBlank = true;

      return [];
    }

    if (filtering) {
      if (type === "") {
        pending = undefined;

        if (event !== undefined) filtering = false;
        skipBlank = true;

        return [];
      }

      filtering = false;
    }

    skipBlank = false;

    return [...takePending(), line];
  };

  return { push, flush: takePending };
};
