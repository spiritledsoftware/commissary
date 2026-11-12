// `requests.nonstream-keepalive-interval` (sdk/api/handlers/handlers.go StartNonStreamingKeepAlive): blank lines while a
// non-stream execution is pending, nothing committed before the first interval.
import { it } from "@effect/vitest";
import { Effect, Fiber, Predicate, Stream } from "effect";
import { HttpServerResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { expect } from "vite-plus/test";
import { withNonStreamKeepAlive } from "../../src/handlers/respond.ts";

const answer = (status: number, delaySeconds: number) =>
  Effect.sleep(`${delaySeconds} seconds`).pipe(
    Effect.as(
      HttpServerResponse.text(`{"status":${status}}`, {
        status,
        headers: { "content-type": "application/json", "x-upstream": "kept" },
      }),
    ),
  );

const collect = (response: HttpServerResponse.HttpServerResponse) =>
  Effect.gen(function* () {
    const body = response.body;

    if (!Predicate.isTagged(body, "Stream"))
      return yield* Effect.die(`unexpected body ${body._tag}`);

    return (yield* Stream.runCollect(Stream.orDie(body.stream))).map((chunk) =>
      new TextDecoder().decode(chunk),
    );
  });

it.effect(
  "keeps the real status and headers when the answer is ready before the first interval",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(withNonStreamKeepAlive(5, answer(429, 3)));
        yield* TestClock.adjust("3 seconds");
        const response = yield* Fiber.join(fiber);
        expect(response.status).toBe(429);
        expect(response.headers["x-upstream"]).toBe("kept");
        expect(response.body._tag).toBe("Uint8Array");
      }),
    ),
);

it.effect("writes one blank line per interval and commits 200 once the first one is out", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(withNonStreamKeepAlive(5, answer(429, 12)));
      yield* TestClock.adjust("5 seconds");
      const response = yield* Fiber.join(fiber);
      // Go has already flushed `200`: the failure only shows in the body that follows the blank lines.
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe("application/json");
      expect(response.headers["x-upstream"]).toBeUndefined();
      const body = yield* Effect.forkChild(collect(response));
      yield* Effect.yieldNow;
      // One interval at a time so the next tick is scheduled before the clock moves on.
      yield* TestClock.adjust("5 seconds");
      yield* TestClock.adjust("2 seconds");
      expect(yield* Fiber.join(body)).toEqual(["\n", "\n", '{"status":429}']);
    }),
  ),
);

it.effect("is a pass-through when disabled", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(withNonStreamKeepAlive(0, answer(200, 100)));
      yield* TestClock.adjust("100 seconds");
      expect((yield* Fiber.join(fiber)).status).toBe(200);
    }),
  ),
);
