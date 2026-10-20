/**
 * What Browser Run's two adapters share in reading its answers: the binding's Quick Actions (`browser-run.ts`) and the
 * crawl REST API (`browser-run-crawls.ts`) answer the same bodies (`{ result }`, or `{ errors }` on a refusal). A
 * failure is Browser Run's own words (at most {@link MAX_MESSAGE_LENGTH} characters), or a short one of Commissary's
 * when it answered something unreadable; a body Commissary caps is read chunk by chunk and given up as soon as it
 * passes its cap, never held whole.
 */
import { Effect, Schema } from "effect";
import { BrowserProviderError } from "./provider.ts";

/** The longest message of Browser Run's that is passed on. */
const MAX_MESSAGE_LENGTH = 500;

/** `value` without the keys whose values are undefined (`exactOptionalPropertyTypes`). */
export const compact = <T extends Record<string, unknown>>(
  value: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } =>
  // SAFETY: the entries kept are `value`'s own, minus those that are undefined.
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };

/** A failure of Browser Run's, with its HTTP status when it answered one. */
export const fail = (message: string, status?: number) =>
  new BrowserProviderError({
    message,
    ...(status === undefined ? {} : { status }),
  });

const unreadable = (status: number) =>
  fail("Browser Run answered something Commissary could not read", status);

const ErrorBody = Schema.Struct({
  errors: Schema.Array(Schema.Struct({ message: Schema.String })),
});

/** `text`, the body of `response`, parsed as JSON and decoded with `schema`. */
const decodedText = <S extends Schema.Decoder<unknown>>(
  response: Response,
  text: string,
  schema: S,
) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
    Effect.mapError(() => unreadable(response.status)),
  );

/** The JSON body of `response`, decoded with `schema`. */
export const decoded = <S extends Schema.Decoder<unknown>>(response: Response, schema: S) =>
  Effect.tryPromise({
    try: () => response.text(),
    catch: () => unreadable(response.status),
  }).pipe(Effect.flatMap((text) => decodedText(response, text, schema)));

/** Browser Run's own words about a refused or failed action. */
export const refusal = (response: Response) =>
  decoded(response, ErrorBody).pipe(
    Effect.map(({ errors }) => errors.map((error) => error.message).join("; ")),
    Effect.orElseSucceed(() => ""),
    Effect.flatMap((message) =>
      Effect.fail(
        fail(
          message === ""
            ? `Browser Run answered ${response.status}`
            : message.slice(0, MAX_MESSAGE_LENGTH),
          response.status,
        ),
      ),
    ),
  );

/** Stops reading a body; a stream that fails to cancel is left to the runtime, never a defect. */
export const cancel = (stream: { cancel(): Promise<void> }) =>
  Effect.tryPromise(() => stream.cancel()).pipe(Effect.ignore);

/**
 * The bytes of `response`'s body, read chunk by chunk and given up (the rest cancelled) with `tooLarge` as soon as they
 * pass `maxBytes`, or at once when its declared length does: an oversized body is never held whole.
 */
export const cappedBody = (response: Response, maxBytes: number, tooLarge: BrowserProviderError) =>
  Effect.gen(function* () {
    if (response.body === null) return new Uint8Array();

    if (Number(response.headers.get("content-length") ?? "0") > maxBytes) {
      yield* cancel(response.body);

      return yield* tooLarge;
    }

    const reader = response.body.getReader();
    const chunks: Array<Uint8Array> = [];
    let size = 0;

    for (;;) {
      const chunk = yield* Effect.tryPromise({
        try: () => reader.read(),
        catch: () => unreadable(response.status),
      }).pipe(Effect.onInterrupt(() => cancel(reader)));

      if (chunk.done) break;
      size += chunk.value.byteLength;

      if (size > maxBytes) {
        yield* cancel(reader);

        return yield* tooLarge;
      }

      chunks.push(chunk.value);
    }

    const data = new Uint8Array(size);
    let offset = 0;

    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return data;
  });

/** The JSON body of `response`, at most `maxBytes` (else `tooLarge`), decoded with `schema`. */
export const cappedJson = <S extends Schema.Decoder<unknown>>(
  response: Response,
  maxBytes: number,
  tooLarge: BrowserProviderError,
  schema: S,
) =>
  cappedBody(response, maxBytes, tooLarge).pipe(
    Effect.flatMap((bytes) => decodedText(response, new TextDecoder().decode(bytes), schema)),
  );
