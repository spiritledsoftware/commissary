/**
 * The answers the Agents area's RPC methods give (the part's and the run objects'): plain data, a value or a refusal
 * with its code and message, which the management routes answer with a status.
 */

/** A value, or why it was refused. */
export type Refusable<E extends string, A> =
  | Ok<A>
  | { readonly ok: false; readonly error: E; readonly message: string };

/** A value (a {@link Refusable} that was not refused). */
export interface Ok<A> {
  readonly ok: true;
  readonly value: A;
}

export const ok = <A>(value: A): Ok<A> => ({ ok: true, value });

export const refuse = <E extends string>(error: E, message: string) =>
  ({ ok: false, error, message }) as const;

/** A time as the contract writes it. */
export const iso = (at: number): string => new Date(at).toISOString();
