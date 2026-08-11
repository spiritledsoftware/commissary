/** Test whether an unknown value is a non-array SQL contract object. */
export function isSqlContractObject(
  value: unknown,
): value is Readonly<Record<PropertyKey, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Test whether a SQL contract object contains only the allowed string keys. */
export function hasOnlySqlContractKeys(value: object, allowed: ReadonlySet<string>): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
}

function snapshotSqlContractValueInternal(
  value: unknown,
  preserve: (value: Readonly<Record<PropertyKey, unknown>>) => boolean,
  snapshots: Map<object, object>,
): unknown {
  if (Array.isArray(value)) {
    const existing = snapshots.get(value);
    if (existing !== undefined) return existing;
    const snapshot: unknown[] = [];
    snapshots.set(value, snapshot);
    snapshot.push(
      ...value.map((item) => snapshotSqlContractValueInternal(item, preserve, snapshots)),
    );
    return Object.freeze(snapshot);
  }
  if (!isSqlContractObject(value) || preserve(value)) return value;
  const existing = snapshots.get(value);
  if (existing !== undefined) return existing;
  const snapshot: Record<PropertyKey, unknown> = {};
  snapshots.set(value, snapshot);
  for (const key of Reflect.ownKeys(value)) {
    Object.defineProperty(snapshot, key, {
      value: snapshotSqlContractValueInternal(Reflect.get(value, key), preserve, snapshots),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return Object.freeze(snapshot);
}

const preserveNoSqlContractValue = (): boolean => false;

/** Copy and freeze caller-owned SQL contract containers while retaining scalar values by reference. */
export function snapshotSqlContractValue(
  value: unknown,
  preserve: (value: Readonly<Record<PropertyKey, unknown>>) => boolean = preserveNoSqlContractValue,
): unknown {
  return snapshotSqlContractValueInternal(value, preserve, new Map());
}
