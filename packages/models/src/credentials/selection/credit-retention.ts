/**
 * Bounded retention of smooth weighted round-robin credits (CLIProxyAPI 9d7d012b, `pruneLimit`): which credentials' credits
 * a rotation key forgets once it holds too many.
 *
 * Credits of a credential a pick leaves out (retry exclusions, cooldowns, affinity) are kept, so the rotation does not
 * collapse onto the lowest ids. Past the larger of {@link MAX_SMOOTH_STATE_ENTRIES} and twice the largest candidate set
 * seen, the absent credentials unseen for longest are forgotten first. Go drops every absent credential at once instead.
 */

export const MAX_SMOOTH_STATE_ENTRIES = 1024;

export class CreditRetention {
  /** When each credential was last a candidate (a counter of `observe` calls). */
  readonly #seen = new Map<string, number>();
  #tick = 0;
  /** Largest candidate set seen, so a pool cooling down to a few candidates keeps the others' credits. */
  #peak = 0;

  /**
   * Records the candidates of one pick against `retained` credentials held in total, and returns the absent ones to
   * forget, least recently seen first.
   */
  observe(candidates: ReadonlyMap<string, number>, retained: number): string[] {
    this.#tick += 1;
    this.#peak = Math.max(this.#peak, candidates.size);

    for (const id of candidates.keys()) this.#seen.set(id, this.#tick);
    const excess = retained - Math.max(MAX_SMOOTH_STATE_ENTRIES, 2 * this.#peak);

    if (excess <= 0) return [];

    const evicted = [...this.#seen.entries()]
      .filter(([id]) => !candidates.has(id))
      .toSorted((a, b) => a[1] - b[1])
      .slice(0, excess)
      .map(([id]) => id);

    for (const id of evicted) this.#seen.delete(id);

    return evicted;
  }

  forget(id: string): void {
    this.#seen.delete(id);
  }
}
