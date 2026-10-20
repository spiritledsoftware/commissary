/**
 * The agent run's Durable Object (#227, ADR 0040): one object per run, named by its org and id, holding the run's
 * pi-durable harness on its own SQLite (`pi.ts`, the only module that imports the pi packages, loaded on the first
 * event). The org's index of runs is the ControlPlane's (`store.ts`); this object holds the run itself: its transcript
 * and its turns.
 *
 * **Turns.** A turn is one input and the work up to its answer. A message to an idle run starts a turn, which reads the
 * agent's definition as it stands then (`beginTurn` of the Agents part, which keeps that reading as the turn's reach):
 * an agent disabled or removed since, or a starter who may no longer use it, ends the run there. A message while a turn
 * runs joins it as steering. Cancelling aborts the running turn; the run stays and takes the next message. A
 * resubmitted start or message with the same idempotency key finds the turn it started.
 *
 * **Where it lives.** In the API Worker (ADR 0030's amendment), so that it reaches the client API without a binding:
 * every request of the harness goes to the run gateway ({@link RunGateway}), the API Worker's own entrypoint, over
 * `ctx.exports`, which serves the client API (models) and the MCP endpoint (tools) as the run's principal, under every
 * gate (docs/ARCHITECTURE.md, "Agents"). The API Worker's class (`AgentRun`, apps/api/src/http/run-gateway.ts) extends
 * this one, wiring it with that loopback binding ({@link AgentRunWiring}); Agents' tests wire it with a fake. The
 * gateway is a private field, so no RPC caller of the object reaches it, and a start must name the run the object is
 * (its name), so no caller makes an object act as another run.
 *
 * **Spend.** A spend limit's refusal, of a model call or a tool call, ends the turn with the refusal as its answer; the
 * run stays open. The refusal is kept in the object's storage until the turn settles.
 *
 * **Resume.** While a turn runs, an alarm wakes the object every {@link HEARTBEAT_MS}: after an eviction or a deploy of
 * the API Worker (every merge) it reopens the harness, which continues the turn (`resume()`): a finished tool call is
 * never made again, an interrupted one answers the model as interrupted, and a model call cut off is made again. A
 * storage failure closes the harness; the next event reopens it.
 *
 * Its calls that change the run run one at a time (`#serial`); waiting and showing do not wait for them.
 */
import { DurableObject } from "cloudflare:workers";
import { Effect, Option, Schema } from "effect";
import type {
  RunActivity,
  RunState,
  TranscriptEntry,
  TurnStatus,
  TurnView,
} from "@commissary/contract/agent-runs";
import { OrgId } from "@commissary/core";
import { type AgentsControlPlane, agentRunName } from "../env.ts";
import { iso, ok, refuse } from "../result.ts";
import type { PiEntry, PiRun, Settled } from "./pi.ts";
import type { RunContext, RunsResult } from "./runs.ts";

/** How often an object with a running turn wakes, so a turn an eviction or a deploy cut off resumes. */
export const HEARTBEAT_MS = 60_000;

/** How long a cancel waits for the aborted turn to settle before it closes the harness. */
const CANCEL_SETTLE_MS = 10_000;

/** How many of the newest transcript entries `show` returns, and how many the recent activity covers. */
const TRANSCRIPT_LIMIT = 200;

const ACTIVITY_LIMIT = 10;

/** How much of an entry's text the recent activity shows. */
const ACTIVITY_TEXT = 300;

/** The API Worker's run gateway, as the run reaches it: a client API request as the run. */
export interface RunGateway {
  serve(org: OrgId, run: string, request: Request): Promise<Response>;
}

/** What the run's object reads from its Worker's env. */
export interface AgentRunEnv {
  /** The org's ControlPlane: the run's definition at each turn, and its state in the org's index. */
  readonly CONTROL_PLANE: DurableObjectNamespace<AgentsControlPlane>;
}

/** The run an object is asked to start: its org and id, which its name must be. */
export interface RunInit {
  readonly org: OrgId;
  readonly id: string;
}

/** A message the run took: the turn it started or joined. */
export interface Delivered {
  readonly turn: TurnView;
  readonly delivery: "turn" | "steering";
}

/** What the run is now: its state, its turns (oldest first), its recent activity and its transcript. */
export interface RunShown {
  readonly state: RunState;
  readonly turns: ReadonlyArray<TurnView>;
  readonly activity: ReadonlyArray<RunActivity>;
  readonly transcript: ReadonlyArray<TranscriptEntry>;
}

/** What a wait found: the finished turn, or on timeout the turn as it is with the latest activity. */
export interface Waited {
  readonly finished: boolean;
  readonly state: RunState;
  readonly turn: TurnView;
  readonly activity?: ReadonlyArray<RunActivity>;
}

const StoredMeta = Schema.Struct({
  org: OrgId,
  id: Schema.String,
  createdAt: Schema.Number,
  /** Why the run ended: its agent was disabled or removed, or its member left. */
  ended: Schema.optionalKey(Schema.String),
  /** The last turn's number. */
  seq: Schema.Int,
});

type StoredMeta = typeof StoredMeta.Type;

const StoredTurn = Schema.Struct({
  id: Schema.String,
  submission: Schema.String,
  /** The submissions of the messages that joined it as steering, oldest first: its answer is the last one's. */
  steering: Schema.optionalKey(Schema.Array(Schema.String)),
  input: Schema.String,
  status: Schema.Literals(["running", "done", "failed", "cancelled"]),
  answer: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
  startedAt: Schema.Number,
  finishedAt: Schema.optionalKey(Schema.Number),
});

type StoredTurn = typeof StoredTurn.Type;

const decodeMeta = Schema.decodeUnknownOption(StoredMeta);

const decodeTurn = Schema.decodeUnknownOption(StoredTurn);

const META = "run";

/** The ids of the run's turns, oldest first. */
const TURNS = "turns";

/** The running turn's id. */
const ACTIVE = "active";

/** A spend limit's refusal the running turn met: its answer. */
const REFUSAL = "refusal";

const turnKey = (id: string) => `turn:${id}`;

/** Set while the turn `id` is being cancelled. */
const cancelKey = (id: string) => `cancel:${id}`;

/** The submission a turn's answer comes from: its last steering message's, else its input's. */
const lastSubmission = (turn: StoredTurn): string => turn.steering?.at(-1) ?? turn.submission;

/** The turn an idempotency key started or joined. */
const idempotencyKey = (key: string) => `key:${key}`;

const turnView = (turn: StoredTurn): TurnView => ({
  id: turn.id,
  status: turn.status,
  input: turn.input,
  ...(turn.answer === undefined ? {} : { answer: turn.answer }),
  ...(turn.error === undefined ? {} : { error: turn.error }),
  started_at: iso(turn.startedAt),
  ...(turn.finishedAt === undefined ? {} : { finished_at: iso(turn.finishedAt) }),
});

const clipped = (text: string): string =>
  text.length <= ACTIVITY_TEXT ? text : `${text.slice(0, ACTIVITY_TEXT - 1)}…`;

/** The recent activity of the run: its newest entries as one line each. */
const activityOf = (entries: ReadonlyArray<PiEntry>): ReadonlyArray<RunActivity> =>
  entries
    .flatMap((entry): ReadonlyArray<RunActivity> => {
      const at = iso(entry.at);

      switch (entry.role) {
        case "user":
          return [{ kind: "input", text: clipped(entry.text), at }];
        case "assistant":
          return [
            ...(entry.text === ""
              ? []
              : [{ kind: "answer" as const, text: clipped(entry.text), at }]),
            ...(entry.toolCalls ?? []).map((call) => ({
              kind: "tool_call" as const,
              text: clipped(call.arguments),
              tool: call.name,
              at,
            })),
          ];
        case "tool":
          return [
            {
              kind: entry.isError === true ? "error" : "tool_result",
              text: clipped(entry.text),
              ...(entry.tool === undefined ? {} : { tool: entry.tool }),
              at,
            },
          ];
      }
    })
    .slice(-ACTIVITY_LIMIT);

const transcriptOf = (entries: ReadonlyArray<PiEntry>): ReadonlyArray<TranscriptEntry> =>
  entries.map((entry) => ({
    role: entry.role,
    text: entry.text,
    ...(entry.toolCalls === undefined ? {} : { tool_calls: entry.toolCalls }),
    ...(entry.tool === undefined ? {} : { tool: entry.tool }),
    ...(entry.isError === undefined ? {} : { is_error: entry.isError }),
    at: iso(entry.at),
  }));

/** The body of a spend limit's refusal (`spend_limit_reached`, the client API's 429), if `body` is one. */
const SpendRefusal = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.Struct({ code: Schema.Literal("spend_limit_reached"), message: Schema.String }),
  }),
);

const decodeSpendRefusal = Schema.decodeUnknownOption(SpendRefusal);

/**
 * `request` as the run gateway takes it: without its abort signal, which cannot be sent over RPC, and without the
 * placeholder key pi-ai's client sends (the run is its own principal: no request of a run carries a credential).
 */
const forGateway = (request: Request): Request => {
  const headers = new Headers(request.headers);

  headers.delete("authorization");

  return new Request(request.url, {
    method: request.method,
    headers,
    body: request.body,
    redirect: request.redirect,
  });
};

/**
 * The response of `call` as long as `signal` is not aborted: an abort rejects the wait with its reason and cancels the
 * response's body, so a cancelled turn stops reading its model's stream.
 */
const abortable = async (call: Promise<Response>, signal: AbortSignal): Promise<Response> => {
  signal.throwIfAborted();

  const aborted = new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

  // Handled here: it rejects only on an abort, which the races below report.
  aborted.catch(() => undefined);

  void call.then(
    (late) => {
      if (signal.aborted) void late.body?.cancel().catch(() => undefined);
    },
    () => undefined,
  );

  const response = await Promise.race([call, aborted]);
  const source = response.body;

  if (source === null) return response;
  const reader = source.getReader();

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await Promise.race([reader.read(), aborted]);

      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });

  signal.addEventListener("abort", () => void reader.cancel(signal.reason).catch(() => undefined), {
    once: true,
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

/** Logs a failure that fails no call (the Worker's logs), with the run and what failed. */
const warn = (message: string, run: string, ...details: ReadonlyArray<string>): void =>
  Effect.runSync(
    Effect.logWarning(message).pipe(Effect.annotateLogs({ run, detail: details.join(" ") })),
  );

const RUN_NOT_FOUND = refuse("not_found", "run not found");

/** How the API Worker wires the run's object (its constructor's third argument). */
export interface AgentRunWiring {
  /** The run gateway: deployed, the API Worker's own entrypoint, over its loopback binding (`ctx.exports`). */
  readonly gateway: () => RunGateway;
  /**
   * Under `alchemy dev` only: the dev registry reaches an object by its hex id, which drops `ctx.id.name`
   * (apps/api/src/dev.ts), so a start there cannot be checked against the object's name. Never set deployed.
   */
  readonly unnamedInDev?: boolean;
}

/**
 * The agent run's Durable Object. It reaches the run's definition through the org's ControlPlane (its env,
 * {@link AgentRunEnv}) and its models and tools through the run gateway its Worker wires it with
 * ({@link AgentRunWiring}), which no RPC method exposes: the object's RPC callers (the app Worker's management routes)
 * reach the run, never the gateway.
 */
export abstract class AgentRunObject extends DurableObject<AgentRunEnv> {
  readonly #wiring: AgentRunWiring;
  /** The harness as this instance opened it; dropped when it closes, so the next event reopens it. */
  #pi: Promise<PiRun> | undefined;
  /** The call running now: the next one starts once it settled. */
  #queue: Promise<unknown> = Promise.resolve();
  /** The turns this instance waits on, so each is watched once. */
  readonly #watched = new Set<string>();

  constructor(ctx: DurableObjectState, env: AgentRunEnv, wiring: AgentRunWiring) {
    super(ctx, env);
    this.#wiring = wiring;
  }

  /** Runs `call` once every call before it settled. */
  #serial<A>(call: () => Promise<A>): Promise<A> {
    const running = this.#queue.then(call, call);

    this.#queue = running.catch(() => undefined);

    return running;
  }

  #meta(): StoredMeta | undefined {
    const stored = this.ctx.storage.kv.get(META);

    return stored === undefined ? undefined : Option.getOrUndefined(decodeMeta(stored));
  }

  #turn(id: string): StoredTurn | undefined {
    const stored = this.ctx.storage.kv.get(turnKey(id));

    return stored === undefined ? undefined : Option.getOrUndefined(decodeTurn(stored));
  }

  #turns(): ReadonlyArray<StoredTurn> {
    const ids = this.ctx.storage.kv.get<ReadonlyArray<string>>(TURNS) ?? [];

    return ids.flatMap((id) => this.#turn(id) ?? []);
  }

  #active(): StoredTurn | undefined {
    const id = this.ctx.storage.kv.get<string>(ACTIVE);

    return id === undefined ? undefined : this.#turn(id);
  }

  #state(meta: StoredMeta): RunState {
    if (meta.ended !== undefined) return "ended";

    return this.#active() === undefined ? "idle" : "running";
  }

  /** The org's ControlPlane, as Agents sees it. */
  #controlPlane(meta: StoredMeta) {
    return this.env.CONTROL_PLANE.getByName(meta.org).agents();
  }

  /** Tells the org's index the run's state; a failure is only logged (the next change tells it again). */
  async #report(meta: StoredMeta, state: RunState): Promise<void> {
    try {
      await this.#controlPlane(meta).runStateChanged(meta.id, state);
    } catch (error) {
      warn("agent run: state not reported", meta.id, String(error));
    }
  }

  /**
   * Records a spend limit's refusal (a model's or a tool's) as the running turn's answer, in the object's storage so an
   * eviction keeps it: the turn ends with it (ADR 0040) when it settles.
   */
  #refused(message: string): void {
    this.ctx.storage.kv.put(REFUSAL, message);
  }

  /** The run's requests, to the client API as the run (the run gateway); spend refusals end the turn (see above). */
  #fetch(meta: StoredMeta): typeof fetch {
    return async (input, init) => {
      const asked = new Request(input, init);

      // An abort signal does not cross RPC: the request goes without it, and the signal is honoured on this side.
      const call = this.#wiring.gateway().serve(meta.org, meta.id, forGateway(asked));
      const response = await abortable(call, asked.signal);

      if (response.status !== 429) return response;
      const body = await response.text();
      const refusal = Option.getOrUndefined(decodeSpendRefusal(body));

      if (refusal === undefined)
        return new Response(body, { status: response.status, headers: response.headers });

      this.#refused(refusal.error.message);

      // Not a transient 429: no retry changes it, so the model client must not wait for its `Retry-After`.
      return new Response(body, {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    };
  }

  /** The run's harness, opened on first use: its tools listed, and what the last process left running resumed. */
  #harness(meta: StoredMeta): Promise<PiRun> {
    if (this.#pi !== undefined) return this.#pi;

    const opening = (async () => {
      const { openPiRun } = await import("./pi.ts");

      const pi = await openPiRun({
        storage: this.ctx.storage,
        fetch: this.#fetch(meta),
        report: (message) => warn("agent run: harness reported", meta.id, message),
        refused: (message) => {
          this.#refused(message);
          // The tool's call answers first; the turn then stops, and settles with the refusal as its answer.
          void (async () => {
            try {
              await pi.abort();
            } catch (error) {
              warn("agent run: turn not stopped", meta.id, String(error));
            }
          })();
        },
      });

      void pi.closed.then(() => {
        if (this.#pi === opening) this.#pi = undefined;
      });

      try {
        await pi.refreshTools();
      } catch (error) {
        // A turn still starts: its tool list is refreshed again at the next turn.
        warn("agent run: tools not listed", meta.id, String(error));
      }

      pi.resume();

      return pi;
    })();

    this.#pi = opening;
    opening.catch(() => {
      if (this.#pi === opening) this.#pi = undefined;
    });

    return opening;
  }

  /** Closes the harness, if open, without waiting on it: the next event opens it again. */
  #drop(meta: StoredMeta): void {
    const pi = this.#pi;

    this.#pi = undefined;

    void (async () => {
      try {
        await (await pi)?.close();
      } catch (error) {
        warn("agent run: harness not closed", meta.id, String(error));
      }
    })();
  }

  /** Watches the running turn until it settles (once per instance). */
  #watch(meta: StoredMeta, turn: StoredTurn): void {
    if (this.#watched.has(turn.id)) return;
    this.#watched.add(turn.id);

    void (async () => {
      try {
        const pi = await this.#harness(meta);
        const settled = await this.#settle(pi, turn.id);

        if (settled !== undefined) await this.#finish(meta, turn.id, settled);
      } catch (error) {
        // The harness closed under the wait (a storage failure, an eviction): the next event or alarm picks it up.
        warn("agent run: turn not watched", meta.id, turn.id, String(error));
      } finally {
        this.#watched.delete(turn.id);
      }
    })();
  }

  /**
   * Waits for the turn `id` to settle, for at most `timeoutMs` when given (`undefined` once it passed): for its last
   * submission, and again for a steering message that joined it meanwhile.
   */
  async #settle(pi: PiRun, id: string, timeoutMs?: number): Promise<Settled | undefined> {
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;

    for (;;) {
      const turn = this.#turn(id);

      if (turn === undefined) return undefined;
      const current = lastSubmission(turn);

      const settled = await pi.settle(
        current,
        deadline === undefined ? undefined : Math.max(0, deadline - Date.now()),
      );

      if (settled === undefined) return undefined;
      const now = this.#turn(id);

      // Done unless a steering message joined the turn while it was answered: then its answer is the turn's.
      if (now === undefined || lastSubmission(now) === current) return settled;
    }
  }

  /** Records how a turn settled, once; the run is idle again. */
  async #finish(meta: StoredMeta, id: string, settled: Settled): Promise<StoredTurn | undefined> {
    const turn = this.#turn(id);

    if (turn === undefined || turn.status !== "running") return turn;
    const refusal = this.ctx.storage.kv.get<string>(REFUSAL);
    const cancelled = this.ctx.storage.kv.get<boolean>(cancelKey(id)) === true;

    let status: TurnStatus;
    let outcome: Pick<StoredTurn, "answer" | "error">;

    if (refusal !== undefined) {
      // A spend limit's refusal is the turn's answer (ADR 0040), whatever the model made of it: the run stays open.
      status = "done";
      outcome = { answer: refusal };
    } else if (settled.status === "done") {
      status = "done";
      outcome = { answer: settled.answer };
    } else if (cancelled) {
      status = "cancelled";
      outcome = {};
    } else {
      status = "failed";
      outcome = { error: settled.detail === "" ? settled.reason : settled.detail };
    }

    const finished: StoredTurn = { ...turn, status, ...outcome, finishedAt: Date.now() };

    this.ctx.storage.kv.put(turnKey(id), finished);
    this.ctx.storage.kv.delete(cancelKey(id));
    this.ctx.storage.kv.delete(REFUSAL);

    if (this.ctx.storage.kv.get<string>(ACTIVE) === id) {
      this.ctx.storage.kv.delete(ACTIVE);
      await this.ctx.storage.deleteAlarm();
      await this.#report(meta, this.#state(meta));
    }

    return finished;
  }

  /**
   * Starts the run `init` (the index's row) with its first turn's `input`. The object checks that it is that run's
   * (its name is `<org>:<run>`), so no caller can make it act as another run. A start the index found again (the same
   * idempotency key) finds the first turn.
   */
  start(init: RunInit, input: string): Promise<RunsResult<Delivered>> {
    return this.#serial(async () => {
      const name = this.ctx.id.name;

      if (
        name !== agentRunName(init.org, init.id) &&
        !(name === undefined && this.#wiring.unnamedInDev === true)
      )
        return RUN_NOT_FOUND;

      if (this.#meta() === undefined)
        this.ctx.storage.kv.put(META, {
          org: init.org,
          id: init.id,
          createdAt: Date.now(),
          seq: 0,
        } satisfies StoredMeta);

      return await this.#message(input, "start");
    });
  }

  /** Sends `message` into the run: steering of the running turn, or a new turn on an idle run. */
  message(message: string, key?: string): Promise<RunsResult<Delivered>> {
    return this.#serial(() => this.#message(message, key === undefined ? undefined : `msg:${key}`));
  }

  /** Ends the run: its agent or its starter can no longer go on (`beginTurn` said why). */
  async #end(meta: StoredMeta, why: string): Promise<RunsResult<never>> {
    const ended: StoredMeta = { ...meta, ended: why };

    this.ctx.storage.kv.put(META, ended);
    await this.#report(ended, "ended");

    return refuse("run_ended", why);
  }

  async #message(input: string, key: string | undefined): Promise<RunsResult<Delivered>> {
    const meta = this.#meta();

    if (meta === undefined) return RUN_NOT_FOUND;

    if (key !== undefined) {
      const known = this.ctx.storage.kv.get<{ turn: string; delivery: "turn" | "steering" }>(
        idempotencyKey(key),
      );

      const turn = known === undefined ? undefined : this.#turn(known.turn);

      if (known !== undefined && turn !== undefined)
        return ok({ turn: turnView(turn), delivery: known.delivery });
    }

    if (meta.ended !== undefined) return refuse("run_ended", meta.ended);

    let context: RunContext | undefined;

    // A new turn reads the definition as it stands (ADR 0040): an agent disabled or removed since, or a starter who
    // may no longer use it, ends the run here. Steering joins the running turn, which keeps the definition it read.
    if (this.#active() === undefined) {
      const found: RunsResult<RunContext> = await this.#controlPlane(meta).beginTurn(meta.id);

      if (!found.ok) {
        if (found.error === "run_ended" || found.error === "not_found")
          return await this.#end(meta, found.message);

        return refuse("unavailable", found.message);
      }

      context = found.value;
      this.ctx.storage.kv.delete(REFUSAL);
    }

    const pi = await this.#harness(meta);

    if (context !== undefined)
      try {
        await pi.refreshTools();
      } catch (error) {
        warn("agent run: tools not listed", meta.id, String(error));
      }

    const seq = meta.seq + 1;
    const id = `turn_${seq}`;

    const submitted = await pi.submit(
      input,
      key ?? id,
      context === undefined
        ? undefined
        : { model: context.model, thinking: context.thinking, instructions: context.instructions },
    );

    this.ctx.storage.kv.put(META, { ...meta, seq });

    // Read again after the awaits: the running turn may have finished meanwhile (`#finish`).
    const active = this.#active();

    if (submitted.delivery === "steering" && active !== undefined) {
      this.ctx.storage.kv.put(turnKey(active.id), {
        ...active,
        steering: [...(active.steering ?? []), submitted.submission],
      } satisfies StoredTurn);

      if (key !== undefined)
        this.ctx.storage.kv.put(idempotencyKey(key), { turn: active.id, delivery: "steering" });

      return ok({ turn: turnView(active), delivery: "steering" });
    }

    const turn: StoredTurn = {
      id,
      submission: submitted.submission,
      input,
      status: "running",
      startedAt: Date.now(),
    };

    this.ctx.storage.kv.put(turnKey(id), turn);
    this.ctx.storage.kv.put(TURNS, [
      ...(this.ctx.storage.kv.get<ReadonlyArray<string>>(TURNS) ?? []),
      id,
    ]);
    this.ctx.storage.kv.put(ACTIVE, id);

    if (key !== undefined)
      this.ctx.storage.kv.put(idempotencyKey(key), { turn: id, delivery: "turn" });

    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
    await this.#report(meta, "running");
    this.#watch(meta, turn);

    return ok({ turn: turnView(turn), delivery: "turn" });
  }

  /**
   * Waits for the turn `id` (the latest when left out) to finish, for at most `timeoutMs`; on timeout answers the turn
   * as it is with the latest activity. It never cancels anything.
   */
  async wait(id: string | undefined, timeoutMs: number): Promise<RunsResult<Waited>> {
    const meta = this.#meta();
    const turn = id === undefined ? this.#turns().at(-1) : this.#turn(id);

    if (meta === undefined || turn === undefined) return refuse("not_found", "turn not found");

    if (turn.status !== "running")
      return ok({ finished: true, state: this.#state(meta), turn: turnView(turn) });

    const pi = await this.#harness(meta);

    this.#watch(meta, turn);
    const settled = await this.#settle(pi, turn.id, timeoutMs);
    const finished = settled === undefined ? undefined : await this.#finish(meta, turn.id, settled);

    if (finished !== undefined && finished.status !== "running")
      return ok({ finished: true, state: this.#state(meta), turn: turnView(finished) });

    return ok({
      finished: false,
      state: this.#state(meta),
      turn: turnView(this.#turn(turn.id) ?? turn),
      activity: activityOf(await pi.entries(ACTIVITY_LIMIT)),
    });
  }

  /** The run as it is: its state, turns, recent activity and transcript. */
  async show(): Promise<RunsResult<RunShown>> {
    const meta = this.#meta();

    if (meta === undefined) return RUN_NOT_FOUND;
    const entries = await (await this.#harness(meta)).entries(TRANSCRIPT_LIMIT);

    return ok({
      state: this.#state(meta),
      turns: this.#turns().map(turnView),
      activity: activityOf(entries),
      transcript: transcriptOf(entries),
    });
  }

  /**
   * Aborts the running turn, if any (`false` when the run was idle); the run takes the next message. A harness that
   * does not settle within {@link CANCEL_SETTLE_MS} is closed, and the turn recorded as cancelled all the same.
   */
  cancel(): Promise<RunsResult<boolean>> {
    return this.#serial(async () => {
      const meta = this.#meta();

      if (meta === undefined) return RUN_NOT_FOUND;
      const active = this.#active();

      if (active === undefined) return ok(false);

      this.ctx.storage.kv.put(cancelKey(active.id), true);
      const pi = await this.#harness(meta);

      const settled = await Promise.race([
        pi.abort().then(async () => await this.#settle(pi, active.id, CANCEL_SETTLE_MS)),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), CANCEL_SETTLE_MS)),
      ]);

      if (settled === undefined) {
        warn("agent run: cancelled turn did not settle", meta.id, active.id);
        this.#drop(meta);
      }

      await this.#finish(
        meta,
        active.id,
        settled ?? { status: "unanswered", reason: "cancelled", detail: "" },
      );

      return ok(true);
    });
  }

  /**
   * Deletes the run: its harness closed, its alarm and all its storage (its transcript and turns) deleted. The org's
   * deletion calls it for each of its runs (`org-deletion.ts`) before it forgets them.
   */
  async purge(): Promise<void> {
    const meta = this.#meta();

    if (meta !== undefined) this.#drop(meta);
    this.#pi = undefined;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /** The heartbeat while a turn runs: reopens the harness after an eviction or a deploy, so the turn resumes. */
  override async alarm(): Promise<void> {
    const meta = this.#meta();
    const active = this.#active();

    if (meta === undefined || active === undefined) return;

    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
    await this.#harness(meta);
    this.#watch(meta, active);
  }
}
