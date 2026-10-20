/**
 * What a session's Durable Object does once it closed (#214, #224), shared by the browser sessions
 * (`browser/session-object.ts`) and the sandbox sessions (`sandbox/cloudflare/session.ts`): it writes the session's one
 * usage record (`insertSessionRecord`) and, when its own alarm closed it, reports the close to its org's ControlPlane
 * with the cost of the time no call charged, which the Tools part charges to the opener's Spend limits. The close is
 * stored first with what is left to do ({@link Unsettled}); a write or a report that fails is tried again from the
 * object's alarm every {@link SETTLE_RETRY_MS}, until the closed session is forgotten, and each is done once.
 */
import { Effect } from "effect";

/** How soon a closed session's alarm tries again to write its usage record or report its close. */
export const SETTLE_RETRY_MS = 60_000;

/**
 * What a closed session has still to do: write its usage record (`unrecorded`), and report its alarm's close with the
 * cost it charges (`owed`, micro-USD). Only the keys of what is left are set.
 */
export interface Unsettled {
  readonly unrecorded?: boolean;
  readonly owed?: number;
}

/** What a session's close did this time. */
export interface Settled {
  readonly recorded: boolean;
  readonly reported: boolean;
}

/** Whether `run` went through; a failure is logged as `warning`, with its message only. */
const attempted = async (run: () => Promise<void>, warning: string): Promise<boolean> =>
  await Effect.runPromise(
    Effect.tryPromise(run).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logWarning(warning).pipe(
          Effect.annotateLogs({ error: error.message }),
          Effect.as(false),
        ),
      ),
    ),
  );

/**
 * Does what is left of a session's close (`left`): writes its usage record (`record`) and reports its close
 * (`report`), each that is not done yet; answers which are done now. `what` names the session in the logs.
 */
export const settleClose = async (
  left: Unsettled,
  steps: {
    readonly what: string;
    readonly record: () => Promise<void>;
    readonly report: (owed: number) => Promise<void>;
  },
): Promise<Settled> => {
  const recorded =
    left.unrecorded !== true ||
    (await attempted(steps.record, `${steps.what} usage record write failed`));

  const { owed } = left;

  const reported =
    owed === undefined ||
    (await attempted(() => steps.report(owed), `${steps.what} close not reported`));

  return { recorded, reported };
};

/** What is still left of `left` once `done` was done: the keys of what is not, and nothing else. */
export const remaining = (left: Unsettled, done: Settled): Unsettled => ({
  ...(left.unrecorded === true && !done.recorded ? { unrecorded: true as const } : {}),
  ...(left.owed !== undefined && !done.reported ? { owed: left.owed } : {}),
});

/** Logs that a closed session is forgotten with its close not yet recorded or reported (its retries ran out). */
export const forgottenUnsettled = async (what: string, left: Unsettled): Promise<void> => {
  if (left.unrecorded !== true && left.owed === undefined) return;

  await Effect.runPromise(
    Effect.logError(`${what} forgotten before its close was recorded`).pipe(
      Effect.annotateLogs({ unrecorded: left.unrecorded === true, owed: left.owed ?? 0 }),
    ),
  );
};

/** A session's id from the name its Durable Object was reached by, `<org>:<id>`. */
export const sessionIdOf = (name: string | undefined): string => {
  const whole = name ?? "";

  return whole.slice(whole.lastIndexOf(":") + 1);
};
