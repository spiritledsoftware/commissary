// CLIProxyAPI b9bb031d: every client frame of a live Responses WebSocket is authorised again before it is run, so a
// credential revoked after the upgrade stops working on the socket. The hand-off of `socket.ts`, driven directly.
import { describe, expect, it } from "@effect/vitest";
import { Effect, Queue, Stream } from "effect";
import { ExecutionError } from "../src/executor/errors.ts";
import { runResponsesSocket, type SocketDeps } from "../src/handlers/responses/websocket/socket.ts";
import { defaultToolCaches } from "../src/handlers/responses/websocket/tool-cache.ts";

const frame = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: "response.create",
    model: "gpt-5.4",
    input: [{ type: "message", role: "user", content: "hi" }],
    ...extra,
  });

const COMPLETED = `event: response.completed\ndata: ${JSON.stringify({
  type: "response.completed",
  response: { id: "resp_1", status: "completed", output: [] },
})}\n\n`;

interface Run {
  readonly sent: Array<Record<string, unknown>>;
  readonly closes: Array<{ code: number; reason: string }>;
  readonly executed: string[];
}

/** Plays `frames` into a socket whose turns complete at once, with `authorize` as the per-turn check. */
const play = (frames: string[], authorize: SocketDeps<never>["authorize"]): Effect.Effect<Run> =>
  Effect.gen(function* () {
    const run: Run = { sent: [], closes: [], executed: [] };
    const raw = yield* Queue.unbounded<string, import("effect/Cause").Done>();

    for (const text of frames) Queue.offerUnsafe(raw, text);
    yield* Queue.end(raw);

    yield* runResponsesSocket<never>(
      {
        io: {
          send: (text) => void run.sent.push(JSON.parse(text) as Record<string, unknown>),
          close: (code, reason) => void run.closes.push({ code, reason }),
        },
        sessionId: "s1",
        headers: new Headers(),
        toolSessionKey: "",
        toolCaches: defaultToolCaches,
        ...(authorize === undefined ? {} : { authorize }),
        execute: (input) => {
          run.executed.push(input.model);

          return Effect.succeed({ headers: new Headers(), chunks: Stream.make(COMPLETED) });
        },
        hasAlternative: () => Effect.succeed(false),
      },
      raw,
    );

    return run;
  });

const refusal = new ExecutionError({ status: 401, message: "Invalid API key" });

describe("Responses WebSocket turn re-authorisation", () => {
  it.effect("runs a turn whose check passes", () =>
    Effect.gen(function* () {
      const run = yield* play([frame()], Effect.succeed(undefined));

      expect(run.executed).toEqual(["gpt-5.4"]);
      expect(run.sent.filter((payload) => payload["type"] === "error")).toEqual([]);
    }),
  );

  it.effect(
    "answers a refused turn with an error frame, runs nothing and keeps the socket open",
    () =>
      Effect.gen(function* () {
        const run = yield* play([frame({ event_id: "evt_1" })], Effect.succeed(refusal));

        expect(run.executed).toEqual([]);
        expect(run.sent).toHaveLength(1);
        expect(run.sent[0]).toMatchObject({
          type: "error",
          status: 401,
          error: { message: "Invalid API key", event_id: "evt_1" },
        });
        expect(run.closes).toEqual([]);
      }),
  );

  it.effect("checks every turn, so a grant withdrawn between two turns stops the second", () =>
    Effect.gen(function* () {
      let checks = 0;

      const run = yield* play(
        [frame(), frame({ input: [{ type: "message", role: "user", content: "again" }] })],
        Effect.sync(() => (++checks > 1 ? refusal : undefined)),
      );

      expect(checks).toBe(2);
      expect(run.executed).toEqual(["gpt-5.4"]);
      expect(run.sent.filter((payload) => payload["type"] === "error")).toHaveLength(1);
    }),
  );
});
