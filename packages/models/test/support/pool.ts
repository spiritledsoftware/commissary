// Test helpers for the credential pool outside the Durable Object: an in-memory PoolStore, an injected clock and a
// ControlPlane-API facade (`ControlPlaneApi`) so the Worker-side picker/conductor can be tested with deterministic time.
import { Effect, Layer } from "effect";
import { parseConfigYaml } from "../../src/config/codec.ts";
import type { Config } from "../../src/config/schema.ts";
import { ALLOW_ALL, type Reach } from "../../src/grants/reach.ts";
import type { StoredCredential } from "../../src/credentials/derive.ts";
import type { CredentialState } from "../../src/credentials/model.ts";
import { CredentialPool, type PoolOptions, type PoolStore } from "../../src/credentials/pool.ts";
import {
  type ControlPlaneApi,
  makeControlPlanePicker,
} from "../../src/executor/control-plane-picker.ts";
import { CredentialPicker } from "../../src/executor/picker.ts";

export class MemoryPoolStore implements PoolStore {
  readonly credentials = new Map<string, StoredCredential>();
  readonly states = new Map<string, CredentialState>();
  list = () => [...this.credentials.values()];
  get = (id: string) => this.credentials.get(id);
  upsert = (id: string, provider: string, metadata: StoredCredential["metadata"]) => {
    const existing = this.credentials.get(id);

    const record: StoredCredential = {
      id,
      provider,
      metadata,
      credentialVersion: (existing?.credentialVersion ?? 0) + 1,
      createdAt: 0,
      updatedAt: 0,
    };

    this.credentials.set(id, record);

    return { record, created: existing === undefined, credentialsChanged: true };
  };
  setDisabled = (id: string, disabled: boolean) => {
    const existing = this.credentials.get(id);

    if (existing === undefined) return undefined;
    const record = { ...existing, metadata: { ...existing.metadata, disabled } };
    this.credentials.set(id, record);

    return record;
  };
  remove = (id: string) => this.credentials.delete(id);
  loadStates = () => new Map(this.states);
  saveState = (id: string, state: CredentialState) => {
    this.states.set(id, state);
  };
  deleteState = (id: string) => {
    this.states.delete(id);
  };
}

/** Mutable test clock shared by the pool (`now`) and tests (`advance`). */
export class TestNow {
  constructor(public value = 1_800_000_000_000) {}
  readonly now = () => this.value;
  advance(ms: number): void {
    this.value += ms;
  }
}

export interface PoolHarness {
  readonly pool: CredentialPool;
  readonly store: MemoryPoolStore;
  readonly clock: TestNow;
  readonly config: Config;
}

export const loadConfig = (yaml: string): Promise<Config> =>
  Effect.runPromise(parseConfigYaml(yaml));

export const makePool = async (
  yaml: string,
  options: {
    readonly store?: MemoryPoolStore;
    readonly clock?: TestNow;
    /** What a member may use; everything unless a test says otherwise. */
    readonly reach?: (member: string | undefined) => Reach;
    /** The org's Spend limits (`@commissary/state/spend`). */
    readonly spend?: PoolOptions["spend"];
    /** Members' private provider key groups: YAML configs by owner (member id). */
    readonly privateConfigs?: Readonly<Record<string, string>>;
  } = {},
): Promise<PoolHarness> => {
  const config = await loadConfig(yaml);
  const store = options.store ?? new MemoryPoolStore();
  const clock = options.clock ?? new TestNow();

  const privateConfigs = await Promise.all(
    Object.entries(options.privateConfigs ?? {}).map(async ([owner, yaml]) => ({
      owner,
      config: await loadConfig(yaml),
    })),
  );

  const pool = new CredentialPool({
    store,
    config: () => ({ version: 1, config }),
    now: clock.now,
    reach: options.reach ?? (() => ALLOW_ALL),
    ...(options.spend === undefined ? {} : { spend: options.spend }),
    ...(privateConfigs.length === 0
      ? {}
      : { privateKeys: () => ({ version: 1, configs: privateConfigs }) }),
  });

  return { pool, store, clock, config };
};

/** The ControlPlane RPC surface backed by an in-process pool (wire decoding is covered by the DO tests). */
export const poolApi = (pool: CredentialPool): ControlPlaneApi => ({
  pick: async (request) => pool.pick(request),
  report: async (lease, result) => pool.report(lease, result),
  planRetry: async (query) => pool.planRetry(query),
});

/** `CredentialPicker` over an in-process pool: the production adapter without the Durable Object. */
export const poolPickerLayer = (pool: CredentialPool): Layer.Layer<CredentialPicker> =>
  Layer.succeed(
    CredentialPicker,
    makeControlPlanePicker(() => poolApi(pool)),
  );
