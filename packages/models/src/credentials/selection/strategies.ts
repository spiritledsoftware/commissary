/**
 * Selection strategies over an ID-sorted, already filtered candidate list.
 *
 * Go source: sdk/cliproxy/auth/selector.go (`RoundRobinSelector.Pick`, `successorIndex`, `FillFirstSelector.Pick`,
 * `WeightedRoundRobinSelector.Pick`, `smoothWeightedState`, `pickSmoothWeightedAuth`). Docs: credentials.md §6.4.
 * State lives in memory only (losing it merely perturbs fairness), keyed by `<providers>:<canonical model>`.
 */
import { CreditRetention } from "./credit-retention.ts";

export interface Weighted {
  readonly id: string;
  readonly weight: number;
}

const DEFAULT_MAX_KEYS = 4096;

const MAX = Number.MAX_SAFE_INTEGER;

/** Candidates arrive sorted by ID: first ID strictly greater than `lastId`, wrapping to the head. */
export const successorIndex = (
  candidates: ReadonlyArray<{ readonly id: string }>,
  lastId: string | undefined,
): number => {
  if (lastId === undefined || lastId === "") return 0;
  let low = 0;
  let high = candidates.length;

  while (low < high) {
    const mid = (low + high) >>> 1;

    if ((candidates[mid]?.id ?? "") > lastId) high = mid;
    else low = mid + 1;
  }

  return low >= candidates.length ? 0 : low;
};

const saturatingAdd = (value: number, delta: number): number => {
  if (delta > 0 && value > MAX - delta) return MAX;

  if (delta < 0 && value < -MAX - delta) return -MAX;

  return value + delta;
};

/**
 * Accumulated credits of smooth weighted round-robin for one key, shared by every subset of its candidates (retry
 * exclusions, cooldowns, affinity); {@link CreditRetention} bounds what it keeps.
 */
export class SmoothWeightedState {
  current = new Map<string, number>();
  weights = new Map<string, number>();
  readonly #retention = new CreditRetention();

  /**
   * Syncs configured weights without discarding credits: all credits reset when a credential's configured weight
   * changes, never when the candidate set shrinks.
   */
  prepare(weights: ReadonlyMap<string, number>): void {
    if (this.weights.size > 0) {
      for (const [id, weight] of weights) {
        const previous = this.weights.get(id);

        if (previous !== undefined && previous !== weight) {
          this.current = new Map();
          break;
        }
      }
    }

    for (const [id, weight] of weights) this.weights.set(id, weight);

    for (const id of this.#retention.observe(weights, this.weights.size)) this.forget(id);
  }

  /** Drops everything kept about one credential (it was removed: a credential added again starts at zero). */
  forget(id: string): void {
    this.current.delete(id);
    this.weights.delete(id);
    this.#retention.forget(id);
  }
}

/** `pickSmoothWeightedAuth`: add each weight, take the maximum (first wins ties), subtract the total from it. */
export const pickSmoothWeighted = <T extends Weighted>(
  candidates: ReadonlyArray<T>,
  current: Map<string, number>,
): T | undefined => {
  let picked: T | undefined;
  let pickedCurrent = 0;
  let total = 0;

  for (const candidate of candidates) {
    if (candidate.weight <= 0) continue;
    const next = saturatingAdd(current.get(candidate.id) ?? 0, candidate.weight);
    current.set(candidate.id, next);
    total = saturatingAdd(total, candidate.weight);

    if (picked === undefined || next > pickedCurrent) {
      picked = candidate;
      pickedCurrent = next;
    }
  }

  if (picked === undefined) return undefined;
  current.set(picked.id, saturatingAdd(current.get(picked.id) ?? 0, -total));

  return picked;
};

/** Rotation cursors and weighted credits for every strategy. */
export class RotationState {
  readonly #maxKeys: number;
  #lastPicked = new Map<string, string>();
  #weighted = new Map<string, SmoothWeightedState>();

  constructor(maxKeys: number = DEFAULT_MAX_KEYS) {
    this.#maxKeys = maxKeys > 0 ? maxKeys : DEFAULT_MAX_KEYS;
  }

  /** Round-robin ring over ID-sorted candidates, resuming after the last picked ID. */
  roundRobin<T extends { readonly id: string }>(
    key: string,
    candidates: ReadonlyArray<T>,
  ): T | undefined {
    if (candidates.length === 0) return undefined;

    if (!this.#lastPicked.has(key) && this.#lastPicked.size >= this.#maxKeys)
      this.#lastPicked = new Map();
    const picked = candidates[successorIndex(candidates, this.#lastPicked.get(key))];

    if (picked === undefined) return undefined;
    this.#lastPicked.set(key, picked.id);

    return picked;
  }

  /** First candidate in ID order. */
  fillFirst<T>(candidates: ReadonlyArray<T>): T | undefined {
    return candidates[0];
  }

  /** Smooth weighted round-robin; candidates with a non-positive weight are ignored. */
  weightedRoundRobin<T extends Weighted>(key: string, candidates: ReadonlyArray<T>): T | undefined {
    if (!this.#weighted.has(key) && this.#weighted.size >= this.#maxKeys)
      this.#weighted = new Map();
    let state = this.#weighted.get(key);

    if (state === undefined) {
      state = new SmoothWeightedState();
      this.#weighted.set(key, state);
    }

    const weights = new Map<string, number>();

    for (const candidate of candidates)
      if (candidate.weight > 0) weights.set(candidate.id, candidate.weight);
    state.prepare(weights);

    return pickSmoothWeighted(candidates, state.current);
  }

  /** A credential was removed: every key forgets its credit, so one added again under the same id starts at zero. */
  forget(id: string): void {
    for (const state of this.#weighted.values()) state.forget(id);
  }

  /** Test hook: number of tracked cursor keys. */
  get cursorKeys(): number {
    return this.#lastPicked.size;
  }
}
