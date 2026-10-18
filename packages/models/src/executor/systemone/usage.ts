/**
 * Usage of a System One answer (ADR 0032): `usage.input_tokens` and `usage.output_tokens`, independent counts with
 * no cache or reasoning tokens. Workers addition, no Go counterpart.
 */
import { asInt, get, isJsonObject, type Json, tryParseJson } from "@commissary/json";
import { independentTokenBreakdown } from "../../usage/accounting.ts";
import { emptyUsageDetail, responseModelOf, type UsageDetail } from "../../usage/record.ts";
import type { UsageReporter } from "../../usage/reporter.ts";

/** The usage of an answer; `undefined` when it has no `usage` object. */
export const parseSystemOneUsage = (payload: Json | undefined): UsageDetail | undefined => {
  if (!isJsonObject(get(payload, "usage"))) return undefined;
  const input = Math.max(0, asInt(get(payload, "usage.input_tokens")));
  const output = Math.max(0, asInt(get(payload, "usage.output_tokens")));
  const total = input + output;

  return {
    ...emptyUsageDetail,
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    tokenBreakdown: independentTokenBreakdown(input, 0, 0, output, 0, total),
  };
};

/** Records an answer's model and usage on the attempt's usage record. */
export const publishSystemOneUsage = (usage: UsageReporter, text: string): void => {
  const parsed = tryParseJson(text);
  usage.observeResponseModel(responseModelOf(parsed));
  const detail = parseSystemOneUsage(parsed);

  if (detail !== undefined) usage.publish(detail);
};
