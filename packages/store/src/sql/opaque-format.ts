import { isSqlContractObject, snapshotSqlContractValue } from "./contract-object.js";

/** Package-copy-compatible identity for opaque SQL values. */
export const sqlOpaqueFormatSymbol = Symbol.for("@commissary/store/sql-opaque-format");

/** Package-copy-compatible format version for core opaque SQL values. */
export const sqlOpaqueValueFormat = "commissary-sql-opaque@1";

/** Immutable creator and reader for one dialect metadata format. */
export interface SqlMetadataFormat<Kind extends string> {
  /** Copy and freeze one package-owned metadata value. */
  readonly create: <Options extends object>(kind: Kind, options: Options) => Readonly<Options>;
  /** Read the kind of one compatible package-owned metadata value. */
  readonly read: (value: unknown) => Kind | undefined;
}

/** Define one package-copy-compatible dialect metadata format. */
export function defineSqlMetadataFormat<const Kind extends string>(options: {
  readonly format: string;
  readonly kinds: ReadonlySet<Kind>;
  readonly owner: string;
}): SqlMetadataFormat<Kind> {
  const kinds: ReadonlySet<string> = new Set(options.kinds);

  const create = <Options extends object>(kind: Kind, value: Options): Readonly<Options> => {
    const snapshot = snapshotSqlContractValue(value);
    if (!isSqlContractObject(snapshot)) {
      throw new TypeError(`${options.owner} ${kind} helper requires an options object`);
    }
    // SAFETY: The snapshot retains every own option field and adds only the private format marker.
    return Object.freeze({
      ...snapshot,
      [sqlOpaqueFormatSymbol]: Object.freeze({ format: options.format, kind }),
    }) as Readonly<Options>;
  };

  const read = (value: unknown): Kind | undefined => {
    try {
      if (!isSqlContractObject(value) || !Object.isFrozen(value)) return undefined;
      const format = Reflect.get(value, sqlOpaqueFormatSymbol);
      if (
        !isSqlContractObject(format) ||
        !Object.isFrozen(format) ||
        Reflect.get(format, "format") !== options.format
      ) {
        return undefined;
      }
      const kind = Reflect.get(format, "kind");
      if (typeof kind !== "string" || !kinds.has(kind)) return undefined;
      // SAFETY: Membership in the copied format kind set was checked above.
      return kind as Kind;
    } catch {
      return undefined;
    }
  };

  return Object.freeze({ create, read });
}
