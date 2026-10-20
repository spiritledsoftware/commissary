/**
 * How often an org asks integrations.sh about a domain the toolkit catalog lacks (#207, `lookup.ts`): its slow
 * `discover` once a minute for the whole org (integrations.sh allows 3 a minute for everyone), and the quick `detect`
 * ten times a minute per member. The ControlPlane's Tools part keeps the counts (`takeCatalogLookup`): one fixed
 * window a key, in the object's memory. An object evicted forgets them, which happens only once it has been idle, so a
 * window it forgets has ended or nearly.
 */

/** How long a window lasts. */
export const LOOKUP_WINDOW_MS = 60_000;

/** `discover`s a whole org may ask in a window. */
export const DISCOVERS_PER_WINDOW = 1;

/** `detect`s one member may ask in a window. */
export const DETECTS_PER_WINDOW = 10;

/** Whether a lookup may go ahead, or how long until it may. */
export type LookupTaken =
  | { readonly ok: true }
  | { readonly ok: false; readonly retryAfterMs: number };

export class LookupThrottle {
  readonly #windows = new Map<string, { readonly start: number; count: number }>();

  /** Counts one lookup of `key` at `now` if fewer than `limit` were in its window. */
  take(key: string, limit: number, now: number): LookupTaken {
    const window = this.#windows.get(key);

    if (window === undefined || now - window.start >= LOOKUP_WINDOW_MS) {
      // Ended windows go as new ones start: the map holds at most one window a key that asked lately.
      for (const [other, { start }] of this.#windows)
        if (now - start >= LOOKUP_WINDOW_MS) this.#windows.delete(other);
      this.#windows.set(key, { start: now, count: 1 });

      return { ok: true };
    }

    if (window.count >= limit)
      return { ok: false, retryAfterMs: window.start + LOOKUP_WINDOW_MS - now };
    window.count += 1;

    return { ok: true };
  }
}
