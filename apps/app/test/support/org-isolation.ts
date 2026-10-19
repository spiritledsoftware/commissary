// The cross-org suite's harness (ADR 0044, `docs/DEVELOPMENT.md` "Tests"): a store is one `storeCase`, and the suite runs
// every case against the same names in three orgs. A new store (tool calls, approvals, runs, sandbox and browser
// sessions, profiles) adds one entry to `STORES` in `test/org-isolation.test.ts`.
import { expect } from "vitest";
import type { OrgId } from "@commissary/core";

/** An org of the suite: stores keyed by the org id use `id`, the management API's `/orgs/<slug>/...` paths the `slug`. */
export interface IsolationOrg {
  readonly id: OrgId;
  readonly slug: string;
}

/**
 * One store of org data, seen through the code that reads and writes it. `name` is the same in every org (a credential,
 * key, session or model name); `value` is what an org puts under it, different in each.
 */
export interface StoreCase {
  readonly store: string;
  /** Puts `value` under `name` in `org`. */
  readonly write: (org: IsolationOrg, name: string, value: string) => Promise<void>;
  /** What `org` finds under `name`: its own value, or `undefined` when it has nothing there. May consume what it reads. */
  readonly read: (org: IsolationOrg, name: string) => Promise<string | undefined>;
  /** The value the org at `index` writes (default: one that names the store and the index). */
  readonly value?: (index: number) => string;
  /**
   * `true` when `read` answers even for an org that has not written (a standing, say): the suite still reads, which
   * warms the store's cache, but does not expect nothing before the write.
   */
  readonly alwaysAnswers?: boolean;
  /** Undoes what `write` changed in the shared orgs, once the case ran. */
  readonly after?: (orgs: ReadonlyArray<IsolationOrg>) => Promise<void>;
}

/** Declares a store's case; the one line a new store adds. */
export const storeCase = (store: string, rest: Omit<StoreCase, "store">): StoreCase => ({
  store,
  ...rest,
});

/**
 * Runs `store` against `orgs` (the same `name` everywhere), in two phases. Writing in turn: after each write, every org
 * that has not written yet finds nothing (so no org's write is visible in another's, whichever order they run in).
 * Then every org reads its own value back, and only its own.
 */
export const expectIsolated = async (
  orgs: ReadonlyArray<IsolationOrg>,
  store: StoreCase,
): Promise<void> => {
  const name = `shared-${crypto.randomUUID().slice(0, 8)}`;
  const valueOf = store.value ?? ((index: number) => `${store.store}-value-${index}`);

  try {
    for (const [index, org] of orgs.entries()) {
      await store.write(org, name, valueOf(index + 1));

      for (const later of orgs.slice(index + 1)) {
        const found = await store.read(later, name);

        if (store.alwaysAnswers !== true)
          expect(found, `${later.slug} before it wrote`).toBeUndefined();
      }
    }

    for (const [index, org] of orgs.entries())
      expect(await store.read(org, name), `${org.slug} reads its own value`).toBe(
        valueOf(index + 1),
      );
  } finally {
    await store.after?.(orgs);
  }
};
