/**
 * Bounded response reads (Go `io.ReadAll(io.LimitReader(body, limit+1))`): at most `limit + 1` bytes are buffered, so
 * an oversized body is detected without reading all of it.
 */
import { Effect, Stream } from "effect";
import type { HttpClientError, HttpClientResponse } from "effect/http";

/** A body read up to a limit: `overflow` when it is longer than the limit (`bytes` then holds `limit + 1` of them). */
export interface BoundedBody {
  readonly bytes: Uint8Array;
  readonly overflow: boolean;
}

/** Reads at most `limit + 1` bytes of `response`'s body. */
export const readBoundedBody = (
  response: HttpClientResponse.HttpClientResponse,
  limit: number,
): Effect.Effect<BoundedBody, HttpClientError.HttpClientError> =>
  Effect.gen(function* () {
    const chunks: Uint8Array[] = [];
    let size = 0;

    yield* response.stream.pipe(
      Stream.takeWhile(() => size <= limit),
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          const room = limit + 1 - size;
          const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;

          chunks.push(kept);
          size += kept.length;
        }),
      ),
    );

    const bytes = new Uint8Array(size);
    let offset = 0;

    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }

    return { bytes, overflow: size > limit };
  });

/** A {@link BoundedBody} decoded as UTF-8. */
export interface BoundedText {
  readonly text: string;
  readonly overflow: boolean;
}

/** {@link readBoundedBody} decoded as UTF-8 (a cut multi-byte character becomes U+FFFD). */
export const readBoundedText = (
  response: HttpClientResponse.HttpClientResponse,
  limit: number,
): Effect.Effect<BoundedText, HttpClientError.HttpClientError> =>
  Effect.map(readBoundedBody(response, limit), ({ bytes, overflow }) => ({
    text: new TextDecoder().decode(bytes),
    overflow,
  }));
