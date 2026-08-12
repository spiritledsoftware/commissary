/** Stable reason that PostgreSQL binding rejected a database or requested capability. */
export type DrizzlePostgresBindingErrorReason =
  | "invalid-database"
  | "probe-failed"
  | "invalid-version-result"
  | "unsupported-postgres-version"
  | "transaction-unavailable";

/** PostgreSQL binding failure raised before a Store value exists. */
export class DrizzlePostgresBindingError extends Error {
  /** Stable error class name. */
  override readonly name = "DrizzlePostgresBindingError";
  /** Stable binding failure reason. */
  readonly reason: DrizzlePostgresBindingErrorReason;
  /** Normalized PostgreSQL server version for an unsupported-version failure. */
  declare readonly version?: number;
  /** Original probe failure, when one was available. */
  declare readonly cause?: unknown;

  /**
   * Create one PostgreSQL binding failure without exposing probe data in its message.
   * Messages and causes are not safe default telemetry.
   */
  constructor(options: {
    readonly reason: DrizzlePostgresBindingErrorReason;
    readonly version?: number;
    readonly cause?: unknown;
  }) {
    const hasCause = Object.hasOwn(options, "cause");
    super(
      `Drizzle PostgreSQL binding failed: ${options.reason}`,
      ...(hasCause ? [{ cause: options.cause }] : []),
    );
    this.reason = options.reason;
    if (options.version !== undefined) this.version = options.version;
    if (hasCause) this.cause = options.cause;
  }
}
