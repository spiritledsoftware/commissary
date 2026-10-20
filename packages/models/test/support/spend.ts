// Test doubles for Spend limits: an in-memory {@link SpendBook} (the ControlPlane keeps limits and counters in SQLite,
// `@commissary/state/spend`) and a small constructor for limits.
import type { Period } from "@commissary/state/spend";
import type { SpendBook } from "@commissary/state/spend";
import { DEFAULT_TIME_ZONE, DEFAULT_WEEK_START } from "@commissary/state/spend";
import type {
  LimitSource,
  SpendLimit,
  SpendScope,
  SpendSettings,
  SubjectKind,
} from "@commissary/state/spend";

export const USD = 1_000_000;

let counter = 0;

export const limit = (
  kind: SubjectKind,
  subject: string,
  period: Period,
  amountMicros: number,
  source: LimitSource = "admin",
): SpendLimit => {
  counter += 1;

  return {
    id: `limit-${counter}`,
    kind,
    subject,
    period,
    amountMicros,
    source,
    revision: 1,
    createdAt: 0,
    updatedAt: 0,
    updatedBy: "test",
  };
};

export class MemorySpendBook implements SpendBook {
  readonly #limits: Array<SpendLimit>;
  readonly #counters = new Map<string, number>();
  #settings: SpendSettings;

  constructor(limits: ReadonlyArray<SpendLimit> = [], settings: Partial<SpendSettings> = {}) {
    this.#limits = [...limits];
    this.#settings = {
      timeZone: settings.timeZone ?? DEFAULT_TIME_ZONE,
      weekStart: settings.weekStart ?? DEFAULT_WEEK_START,
    };
  }

  settings = (): SpendSettings => this.#settings;
  limits = (): ReadonlyArray<SpendLimit> => this.#limits;

  configure(settings: Partial<SpendSettings>): void {
    this.#settings = { ...this.#settings, ...settings };
  }

  add(...limits: ReadonlyArray<SpendLimit>): void {
    this.#limits.push(...limits);
  }

  spent = (scope: SpendScope, period: Period, periodStart: number): number =>
    this.#counters.get(this.#key(scope, period, periodStart)) ?? 0;

  charge = (scope: SpendScope, period: Period, periodStart: number, micros: number): void => {
    const key = this.#key(scope, period, periodStart);
    this.#counters.set(key, (this.#counters.get(key) ?? 0) + micros);
  };

  #key = (scope: SpendScope, period: Period, periodStart: number): string =>
    `${scope.kind}|${scope.subject}|${period}|${periodStart}`;
}
