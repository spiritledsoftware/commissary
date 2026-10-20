/**
 * `UsageSink` backed by D1 (binding `USAGE`). Writes run in `ctx.waitUntil`, so they never delay or fail a response;
 * a failed write is logged (request id and error message only) and the record is dropped. The record is costed in the
 * same detached write (`UsagePricing`, ADR 0024): a pricing failure never loses the record, which is stored without a
 * cost.
 *
 * Go counterpart: the `usage.Plugin` registered by internal/redisqueue (HandleUsage -> Enqueue).
 */
import { Context, Effect, Layer } from "effect";
import { causeSummary, runAfterResponse } from "@commissary/core";
import { insertUsageRecord } from "./d1.ts";
import { UsagePricing } from "./pricing-service.ts";
import type { UsageRecord } from "./record.ts";
import { UsageSink } from "./sink.ts";
import { ModelsEnv } from "../env.ts";

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Writes `record` and logs (request id and error message only, never the record) instead of failing. */
export const writeUsageRecord = (db: D1Database, record: UsageRecord): Effect.Effect<void> =>
  Effect.tryPromise({ try: () => insertUsageRecord(db, record), catch: errorMessage }).pipe(
    Effect.catch((message) =>
      Effect.logWarning("usage record write failed").pipe(
        Effect.annotateLogs({ requestId: record.requestId, error: message }),
      ),
    ),
  );

/** What `record` costs; `undefined` when it cannot be costed (pricing failures are logged, never raised). */
const priced = (pricing: UsagePricing["Service"], record: UsageRecord) =>
  pricing
    .costOf(record)
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("usage record pricing failed").pipe(
          Effect.annotateLogs({ requestId: record.requestId, error: causeSummary(cause) }),
          Effect.as(undefined),
        ),
      ),
    );

/** `record` with its cost; the record as it is when it cannot be costed or was costed already (for a Spend limit). */
const costed = (pricing: UsagePricing["Service"], record: UsageRecord) =>
  record.cost !== undefined
    ? Effect.succeed(record)
    : priced(pricing, record).pipe(
        Effect.map((cost): UsageRecord => (cost === undefined ? record : { ...record, cost })),
      );

/** Needs `UsagePricing` (`UsagePricing.none` stores records without a cost). */
export const D1UsageSink = Layer.effect(
  UsageSink,
  Effect.gen(function* () {
    const pricing = yield* UsagePricing;

    return UsageSink.of({
      cost: (record) =>
        Effect.contextWith((context: Context.Context<never>) => {
          const env = Context.getOrUndefined(context, ModelsEnv);

          return env === undefined
            ? Effect.undefined
            : priced(pricing, record).pipe(Effect.provideService(ModelsEnv, env));
        }),
      publish: (record) =>
        Effect.contextWith((context: Context.Context<never>) => {
          // The bindings are per-request services of the invocation, resolved here and never captured by the layer.
          const env = Context.getOrUndefined(context, ModelsEnv);
          const db = env?.USAGE;

          if (db === undefined) return Effect.void;

          // Detached from the response (and possibly after it), keeping the invocation's context (loggers).
          return runAfterResponse(
            costed(pricing, record).pipe(
              Effect.provideService(ModelsEnv, env),
              Effect.flatMap((priced) => writeUsageRecord(db, priced)),
            ),
          );
        }),
    });
  }),
);
