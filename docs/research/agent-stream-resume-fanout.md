# Agent stream resume and fan-out

Source review: 2026-07-28 — Flue `@flue/runtime@2.0.0-nightly.202607240825` (`b814b82`), Vercel AI SDK `ai@7.0.40` (`8bedb2c`) plus `resumable-stream@2.2.12`, OpenCode `1.18.8` (`9e432a678`), pi-mono `0.82.1` (`063fb963`), Eve `0.27.8` (`f736533`), and Hermes Agent `0.19.0` (`1dfe781ed`).

## Answer

These systems implement four different things that should not share one name:

- **Ephemeral multicast:** several live consumers, process-bound.
- **Durable replay:** an ordered stored log and a per-consumer cursor.
- **Transport resume:** reconnecting HTTP/WebSocket delivery; only lossless when backed by durable replay.
- **Backpressure:** whether a slow sink/consumer blocks generation, buffers, disconnects, or drops.

| System            | Producer → multiple consumers                                                                                                                                                    | Replay / cursor                                                                                                                                       | Storage                                                                                                                                                                 | Persistence backpressures generation?                                                                                                           | No event loss?                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Flue**          | Each reader/SSE connection independently reads the canonical stream. A process-local listener `Set` only wakes readers.                                                          | Read after opaque batch `offset`; `-1` is before the log, `now` is tail.                                                                              | Atomic append-only conversation batches in the configured SQLite/SQL/Mongo store.                                                                                       | **Partly:** deltas coalesce for up to 1 s; live publication waits for append, and block boundaries flush. Slow readers do not block generation. | **Yes for retained canonical records**; wake notifications are only best effort.                                              |
| **Vercel AI SDK** | Core uses `ReadableStream.tee()`. Its documented optional `resumable-stream` integration assigns extra consumers Redis Pub/Sub channels.                                         | `resumable-stream` accepts a character count (`skipCharacters`); the AI SDK recipe normally identifies only the stream and replays it from the start. | AI SDK stores nothing. `resumable-stream` keeps chunks in the **producer process’s `chunks[]`**; Redis stores a sentinel and carries Pub/Sub messages, not the backlog. | No durable sink. AI SDK does not await its tee consumer. The wrapper awaits Redis publication, not client consumption.                          | **No. Producer crash loses the backlog.** It only survives HTTP disconnect/load balancing while that producer remains alive.  |
| **OpenCode**      | Core has live PubSubs plus a durable per-aggregate stream; each durable consumer has its own sequence. Public `/event` SSE instead uses one unbounded live queue per connection. | Durable API reads `seq > after`; public SSE has no SSE `id`, `Last-Event-ID`, or replay cursor.                                                       | SQLite `event` rows unique by `(aggregate_id, seq)` plus an aggregate head table.                                                                                       | **Yes:** model deltas await the SQLite transaction before notification. Slow public SSE clients buffer separately.                              | **Yes for the durable aggregate API** while rows are retained; **no for public SSE**.                                         |
| **pi-mono**       | `Agent.subscribe()` awaits every listener in registration order. Its lower-level `EventStream` is one queue, so multiple iterators compete rather than fan out.                  | No event cursor/replay. `afterEntrySeq` pages session entries, not lifecycle events.                                                                  | Completed messages/session entries in JSONL or session storage; deltas are not logged as replayable events.                                                             | Awaited subscribers backpressure. Coding-agent message persistence is synchronous at `message_end`, after UI notification, not per delta.       | **No for live events.** Restore reconstructs state, not the observation stream.                                               |
| **Eve**           | One Workflow durable stream; every attachment opens an independent readable at an index.                                                                                         | Absolute event-count `startIndex`; negative values are tail-relative. `follow: false` pins the opening tail via `x-eve-stream-tail-index`.            | Workflow world streams: `.eve/.workflow-data` locally, Vercel Workflow in production, or a custom world such as Postgres.                                               | **Yes, bounded:** generation can run ahead by 64 source events or 64 KiB of deltas; then it awaits capacity. Slow readers are independent.      | **Yes for retained recorded events:** events are recorded before a step completes and reconnect continues at the exact count. |
| **Hermes Agent**  | Core calls up to two callbacks. A dashboard sidecar queues frames to `/api/pub`; the server broadcasts each frame to all `/api/events` sockets.                                  | No live-event cursor/replay. `session.resume` returns persisted messages plus an in-process inflight snapshot—snapshot recovery, not event replay.    | Final messages in SQLite `state.db`; inflight state in memory; dashboard frames are not stored.                                                                         | **No:** the sidecar uses `put_nowait` into a 256-item daemon queue and drops on overflow.                                                       | **No.** Disconnect, overflow, or process death may lose events.                                                               |

## Source mechanics

### Flue

`ConversationStreamStore` exposes `append`, cursor-based `read`, and `subscribe`; its append contract requires all records at one offset to be atomic ([contract](https://github.com/withastro/flue/blob/b814b82/packages/runtime/src/runtime/conversation-stream-store.ts#L44-L86)). Offsets encode integer sequence numbers ([source](https://github.com/withastro/flue/blob/b814b82/packages/runtime/src/runtime/stream-offsets.ts#L1-L42)). The listener registry is explicitly a process-local `Map<string, Set<() => void>>` ([source](https://github.com/withastro/flue/blob/b814b82/packages/runtime/src/runtime/conversation-stream-store.ts#L142-L180)); SSE repeatedly reads the durable store after `currentOffset`, so a missed wake changes latency, not correctness ([source](https://github.com/withastro/flue/blob/b814b82/packages/runtime/src/runtime/handle-conversation-routes.ts#L195-L271)). Deltas are exposed only after their coalesced canonical append resolves, and completion forces a flush ([source](https://github.com/withastro/flue/blob/b814b82/packages/runtime/src/session.ts#L2255-L2289)).

### Vercel AI SDK

`createUIMessageStreamResponse` tees the SSE stream and invokes `consumeSseStream` without awaiting it ([source](https://github.com/vercel/ai/blob/8bedb2c/packages/ai/src/ui-message-stream/create-ui-message-stream-response.ts#L23-L40)); `streamText` notes that recursive teeing buffers on the server ([source](https://github.com/vercel/ai/blob/8bedb2c/packages/ai/src/generate-text/stream-text.ts#L2590-L2600)). Official docs delegate resumability to application storage, Redis, and `resumable-stream` ([docs](https://github.com/vercel/ai/blob/8bedb2c/content/docs/04-ai-sdk-ui/03-chatbot-resume-streams.mdx#L20-L44)).

The exact `resumable-stream@2.2.12` source allocates `const chunks = []`, sends late listeners `chunks.join("").slice(skipCharacters || 0)`, and writes only a 24-hour sentinel to Redis; future chunks travel by per-listener Pub/Sub ([published package source](https://unpkg.com/resumable-stream@2.2.12/dist/runtime.js)). `waitUntil` keeps the producer alive after the HTTP response. Redis therefore does **not** make the chunk history durable; a producer crash destroys replay.

### OpenCode

The durable session APIs are:

```ts
readonly events: (input: { sessionID: SessionSchema.ID; after?: number }) =>
  Stream.Stream<SessionEvent.DurableEvent, NotFoundError>
readonly history: (input: { sessionID: SessionSchema.ID; after?: number; limit: number }) =>
  Effect.Effect<{ events: ReadonlyArray<SessionEvent.DurableEvent>; hasMore: boolean }, NotFoundError>
```

([source](https://github.com/anomalyco/opencode/blob/9e432a678/packages/core/src/session.ts#L113-L145)). Publishing commits the event and head sequence in an immediate SQLite transaction before notifying ([source](https://github.com/anomalyco/opencode/blob/9e432a678/packages/core/src/event.ts#L224-L397)). A durable subscriber registers a one-slot sliding wake before its initial database read, then reads every row after its local sequence on each wake; coalesced wakes cannot lose rows ([source](https://github.com/anomalyco/opencode/blob/9e432a678/packages/core/src/event.ts#L535-L607)). Text/reasoning deltas await this publish ([source](https://github.com/anomalyco/opencode/blob/9e432a678/packages/core/src/session/runner/publish-llm-event.ts#L244-L288)). Public SSE is separate: an unbounded queue, `id: undefined`, and no replay ([source](https://github.com/anomalyco/opencode/blob/9e432a678/packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts#L9-L90)).

### pi-mono

`Agent.subscribe` adds listeners to a `Set` and event dispatch awaits each listener ([API](https://github.com/badlogic/pi-mono/blob/063fb963/packages/agent/src/agent.ts#L233-L246), [dispatch](https://github.com/badlogic/pi-mono/blob/063fb963/packages/agent/src/agent.ts#L540-L576)). `EventStream` has one queue and shifts one waiter/item per event, so it is single-consumer in effect ([source](https://github.com/badlogic/pi-mono/blob/063fb963/packages/ai/src/utils/event-stream.ts#L3-L66)). Coding-agent UI listeners run before `appendMessage` ([source](https://github.com/badlogic/pi-mono/blob/063fb963/packages/coding-agent/src/core/agent-session.ts#L615-L656)); JSONL storage synchronously appends session entries ([source](https://github.com/badlogic/pi-mono/blob/063fb963/packages/coding-agent/src/core/session-manager.ts#L1009-L1067)). Its harness design states “atomic snapshot plus live event stream,” “no event replay,” and that partial provider streams are never persisted ([source](https://github.com/badlogic/pi-mono/blob/063fb963/packages/agent/docs/harness.md#L4-L16)).

### Eve

Each HTTP stream request calls `getEventStream({ startIndex })` and optionally returns the durable tail ([source](https://github.com/vercel/eve/blob/f736533/packages/eve/src/public/channels/eve.ts#L428-L469)); the runtime maps this to `getRun(sessionId).getReadable({ startIndex })` and `getTailIndex()` ([source](https://github.com/vercel/eve/blob/f736533/packages/eve/src/execution/workflow-runtime.ts#L218-L238)). Workflow worlds own state, queues, hooks, and streams; local storage is `.eve/.workflow-data` ([docs](https://github.com/vercel/eve/blob/f736533/docs/concepts/execution-model-and-durability.mdx#L15-L39)).

The client increments `startIndex` for every parsed event and reconnects from that value ([source](https://github.com/vercel/eve/blob/f736533/packages/eve/src/client/open-stream.ts#L91-L190)). Eve documents that every event is recorded before the step completes ([docs](https://github.com/vercel/eve/blob/f736533/docs/concepts/sessions-runs-and-streaming.md#L113-L134)). Its ordered emitter caps the pending source at 64 events or 64 KiB, coalesces adjacent compatible deltas, and awaits capacity ([source](https://github.com/vercel/eve/blob/f736533/packages/eve/src/harness/ordered-stream-emitter.ts#L7-L34), [source](https://github.com/vercel/eve/blob/f736533/packages/eve/src/harness/ordered-stream-emitter.ts#L57-L153)); the sink awaits the Workflow writer ([source](https://github.com/vercel/eve/blob/f736533/packages/eve/src/execution/workflow-steps.ts#L291-L298)).

### Hermes Agent

Hermes calls both registered stream callbacks, catches exceptions, and records delivery if one returns ([source](https://github.com/NousResearch/hermes-agent/blob/1dfe781ed/run_agent.py#L5602-L5687)). Its dashboard publisher calls itself best effort, uses a 256-item daemon queue, and returns `false` on `queue.Full` ([source](https://github.com/NousResearch/hermes-agent/blob/1dfe781ed/tui_gateway/event_publisher.py#L1-L23), [source](https://github.com/NousResearch/hermes-agent/blob/1dfe781ed/tui_gateway/event_publisher.py#L32-L98)). The server’s process-local subscriber set broadcasts each frame without storing it ([source](https://github.com/NousResearch/hermes-agent/blob/1dfe781ed/hermes_cli/web_server.py#L17751-L17764), [source](https://github.com/NousResearch/hermes-agent/blob/1dfe781ed/hermes_cli/web_server.py#L18628-L18665)). Durable recovery instead reads the SQLite `messages` table and may add a live inflight snapshot ([schema](https://github.com/NousResearch/hermes-agent/blob/1dfe781ed/hermes_state.py#L1289-L1317), [resume payload](https://github.com/NousResearch/hermes-agent/blob/1dfe781ed/tui_gateway/server.py#L7947-L7986)).

## Observation API DX

The reviewed systems generally do **not** require every in-process observer to wrap or independently consume the output stream:

- Vercel AI SDK accepts per-call lifecycle callbacks such as `onChunk`, `onError`, `onAbort`, and `onEnd`; `onChunk` is awaited and pauses stream processing until it settles ([contract](https://github.com/vercel/ai/blob/8bedb2c/packages/ai/src/generate-text/stream-text.ts#L330-L348), [dispatch](https://github.com/vercel/ai/blob/8bedb2c/packages/ai/src/generate-text/stream-text.ts#L1169-L1182)).
- pi-mono exposes `Agent.subscribe(listener)` and awaits every registered listener in order before advancing ([subscription](https://github.com/badlogic/pi-mono/blob/063fb963/packages/agent/src/agent.ts#L233-L246), [dispatch](https://github.com/badlogic/pi-mono/blob/063fb963/packages/agent/src/agent.ts#L522-L575)).
- TanStack AI composes ordered `ChatMiddleware` lifecycle hooks, with `onStart`, `onChunk`, and `onFinish` used directly for logging and observation ([contract](https://github.com/TanStack/ai/blob/1120f0f8824262b4fd1d3788e606793158d6ac3c/packages/ai/src/activities/chat/middleware/types.ts#L418-L447)).
- Flue's Agent Client accepts an `onEvent` callback while observing a durable submission, and its Agent authoring model also includes lifecycle Hooks ([client contract](https://github.com/withastro/flue/blob/b814b82/packages/runtime/src/agent-client.ts#L70-L90), [dispatch](https://github.com/withastro/flue/blob/b814b82/packages/runtime/src/agent-client.ts#L416-L433)).
- OpenCode exposes process-local PubSub subscriptions alongside its cursor-based durable event API ([source](https://github.com/anomalyco/opencode/blob/9e432a678/packages/core/src/event.ts#L534-L603)). Hermes likewise invokes registered callbacks directly before its optional dashboard relay.

The common split is direct process-local callbacks or middleware for convenient integration composition, with transport fan-out, reconnectability, and replay handled separately. A process-local Hook subscription registry with no per-subscriber queue or replay is therefore not the same commitment as a transport subscriber registry.

## Recommendation for Commissary

Keep the architecture's smallest stable core primitive: **typed process-local Hook subscriptions captured by `execute`, plus Execution IDs, an independently awaitable result, and explicit abort**. Core should dispatch canonical Execution Events through `Hook.onExecutionEvent` but own no event queue or stream. The current prototype still exposes an older single-consumer shape under `ExecutionAttempt.signals` ([source](../../packages/core/src/runtime.ts#L182-L223)); that prototype is evidence for adapter behavior, not the target core boundary.

Because live streaming is table stakes for an agent framework, the **first official adapter built immediately after core must be the Stream Adapter**. It should register a dynamic `onExecutionEvent` Hook before `execute`, then remove that process-local registration after `execute` returns because the active Execution has already captured it. It wraps the Execution with one bounded single-consumer `AsyncIterable`, and its Effect entry point exposes the same events as an Effect `Stream`.

The Stream Adapter owns:

- buffer capacity, with a bounded default;
- nonblocking overflow and a coalesced `{ type: "events-dropped", count }` marker;
- terminal Error Event delivery and stream close ordering;
- text projection by filtering canonical nested `model-event` values;
- single-consumer enforcement and local cancellation of consumption.

It does not backpressure core, abort a Run when consumption stops, or promise replay. Today's prototype queue is push-only and unbounded ([source](../../packages/core/src/runtime-implementation.ts#L159-L213)); moving the queue into this adapter makes the bounded policy explicit without making it a Runtime concern.

A later relay adapter should consume the Stream Adapter output exactly once and own:

- process-local multicast queues and downstream overflow policy;
- optional append-only event batches keyed by Execution or Run, with an adapter-local monotonic cursor;
- `read(after, limit)` plus wake or long-poll, with the durable read—not the wake—closing races;
- SSE, NDJSON, or WebSocket encoding, authorization, cursor mapping, retention, and cleanup;
- snapshot rehydration from durable Run and Thread truth when exact event replay is unnecessary.

This relay can provide multicast and **best-effort** persisted replay, but it cannot truthfully promise crash-lossless capture: the process may die after core dispatches an Event and before the relay appends it.

If a future official adapter must guarantee no event loss, the smallest additional core seam is **not** another transport subscriber registry or per-subscriber queue. It is an optional **awaited, bounded event-sink append at the emission boundary**. Core would wait for durable append before observation; all readers, cursors, wake-ups, transports, and retention remain adapter-owned. That combines Flue/OpenCode's commit-before-notify rule with Eve's bounded backpressure without expanding ordinary core observation.
