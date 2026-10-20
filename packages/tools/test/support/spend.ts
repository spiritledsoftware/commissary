// What a Spend limit has counted at a test's clock (#214, #224). The ControlPlane's Spend overview reads its period
// at the live time, while a test's part charges at its `TestClock`, which starts at a noon ahead
// (`support/clock.ts`) and may run a day on: so this reads the limit's counter for the period the clock is in, from
// the object's storage.
import { runInDurableObject } from "cloudflare:test";
import { periodBounds, type SpendScope, SpendStore } from "@commissary/state/spend";

/** What the org's (first) limit of `kind` has counted in its period at `now`; `undefined` without one. */
export const spentAt = (
  stub: DurableObjectStub,
  kind: SpendScope["kind"],
  now: number,
): Promise<number | undefined> =>
  runInDurableObject(stub, (_instance, state) => {
    const store = new SpendStore(state.storage.sql);
    const limit = store.limits().find((each) => each.kind === kind);

    if (limit === undefined) return undefined;

    const { timeZone, weekStart } = store.settings();

    return store.spent(
      { kind, subject: limit.subject },
      limit.period,
      periodBounds(limit.period, now, timeZone, weekStart).start,
    );
  });
