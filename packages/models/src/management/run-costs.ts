/**
 * What agent runs cost, from their usage records, for the Agents area's run routes (#234): the app Worker hands it to
 * Agents' routes (`AgentReferences.runCosts`), as Agents imports nothing of Models. The routes name only the runs the
 * caller sees (#232), so the cost of a shared agent's run reaches its starter and its watchers, whose own usage reads
 * leave its records out (they name no member). A private record still counts only for its member. Workers addition, no
 * Go counterpart.
 */
import { Effect, Option } from "effect";
import { CurrentOrg } from "@commissary/core";
import { ModelsEnv } from "../env.ts";
import { runCosts as readRunCosts } from "../usage/d1.ts";

/**
 * The cost so far of each of `runs` in the current org, in micro-dollars, by run id, `member` reading their own private
 * records too; a run with no priced record is left out (it cost nothing). Never fails: without the usage store, or when
 * it cannot be read (logged), it answers `None`, so the routes leave the cost out rather than say `0`.
 */
export const runCosts = (
  runs: ReadonlyArray<string>,
  member: string | undefined,
): Effect.Effect<Option.Option<ReadonlyMap<string, number>>, never, ModelsEnv | CurrentOrg> =>
  Effect.gen(function* () {
    const db: D1Database | undefined = (yield* ModelsEnv).USAGE;

    if (db === undefined) return Option.none();

    if (runs.length === 0) return Option.some(new Map());
    const org = yield* CurrentOrg;

    return yield* Effect.tryPromise(() => readRunCosts(db, org, runs, member)).pipe(
      Effect.map(Option.some),
      Effect.catch((error) =>
        Effect.logWarning("agent runs: cost read failed").pipe(
          Effect.annotateLogs({ org, detail: String(error) }),
          Effect.as(Option.none()),
        ),
      ),
    );
  });
