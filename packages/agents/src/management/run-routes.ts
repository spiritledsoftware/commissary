/**
 * Agent runs on the management API (`AgentRunsGroup` in `@commissary/contract/agent-runs`, #227, ADR 0040): start a run
 * of an agent (`POST /agents/:id/runs`), list the caller's runs, show one, send it a message, wait for a turn, cancel
 * the running turn and delete the run (#234). The panel's chat (#234) and the agents toolkit (#229) are built on the
 * same operations. The list and a run's page carry each run's cost from its usage records (`cost_micros`, #234), read
 * through the references the app Worker fills (`AgentReferences.runCosts`), for exactly the runs the caller sees.
 *
 * The org's index of runs (the Agents part, `runs/runs.ts`) decides who sees a run (#232, ADR 0040): its starter, and
 * for a shared agent's run no one started its watchers, who watch it (its transcript and what it waits on), steer it
 * (messages, waits) and cancel it; and an org admin, who sees every shared agent's run as its metadata only (`403
 * forbidden` on messages and waits) and cancels any run of the org, a private agent's too, of which they learn only
 * whether a turn was cancelled. Any other run answers like an unknown one. Its starter and its watchers delete it, with
 * its child runs (#234; `403 forbidden` for an org admin), and the route then sweeps the deleted runs' objects. The run
 * itself is its Durable Object (`AGENT_RUN`, `runs/run-object.ts`), which this Worker reaches by the API Worker's
 * script name. A run started here is started by the member who asks, with the trigger kind `chat`.
 *
 * A start whose call of the run's object fails ends the run it created (`abandonRun`): the object may or may not have
 * taken it, so the run is not left looking idle. A start again with the same idempotency key then answers `409
 * run_ended`; a start with another key starts a new run.
 *
 * Like every Agents route, each answers 404 without the deployment's Dynamic Workers binding (`LOADER`).
 */
import { Effect, Option } from "effect";
import { HttpRouter } from "effect/http";
import { currentViewer, type Viewer } from "@commissary/auth";
import {
  type CancelledRun,
  type DeletedRun,
  MAX_WAIT_MS,
  type MessageSent,
  type RunDetail,
  type RunRetention,
  type RunView,
  SendMessage,
  StartRun,
  type StartedRun,
  WaitRun,
} from "@commissary/contract/agent-runs";
import { CurrentOrg, jsonReply, replyError } from "@commissary/core";
import { callControlPlane, platform } from "@commissary/state";
import { agentRunOf, agentsControlPlane, AgentsEnv } from "../env.ts";
import { sweepDeletedRuns } from "../runs/retention.ts";
import { MAX_IDEMPOTENCY_KEY, type RunsErrorCode, type RunsResult } from "../runs/runs.ts";
import { decode, orRefuseWith, param, route } from "./http.ts";
import type { AgentReferences } from "./references.ts";

/** How long a wait takes when the request names no timeout. */
const DEFAULT_WAIT_MS = 30_000;

const orRefuse = orRefuseWith<RunsErrorCode>({
  invalid: 422,
  forbidden: 403,
  not_found: 404,
  agent_disabled: 409,
  trigger_disabled: 409,
  run_ended: 409,
  unavailable: 503,
});

/** `422 invalid` for empty text or an idempotency key longer than the index takes. */
const checked = (text: string, field: string, key: string | undefined) => {
  if (text.trim() === "")
    return Effect.fail(replyError(422, "invalid", { message: `${field} is empty`, path: field }));

  if (key !== undefined && key.length > MAX_IDEMPOTENCY_KEY)
    return Effect.fail(
      replyError(422, "invalid", {
        message: `an idempotency key has at most ${MAX_IDEMPOTENCY_KEY} characters`,
        path: "idempotency_key",
      }),
    );

  return Effect.void;
};

/** Calls the run's object as the state RPC calls are (`callControlPlane`: a failure answers 502), then its refusal. */
const callRun = <A>(
  label: string,
  run: string,
  call: (stub: ReturnType<typeof agentRunOf>) => Promise<RunsResult<A>>,
) =>
  Effect.gen(function* () {
    const stub = agentRunOf(yield* AgentsEnv, yield* CurrentOrg, run);
    const result = yield* callControlPlane(`agent run ${label}`, stub, call);

    // SAFETY: the object's RPC answers plain data of `RunsResult<A>`; the stub's serialised type only loses the
    // readonly modifiers.
    return yield* orRefuse(result as RunsResult<A>);
  });

/**
 * The run `id` as the caller sees it in the org's index (#232), with why (`access`): anyone else's answers like an
 * unknown run (`404`).
 */
const visibleRun = (id: string) =>
  Effect.gen(function* () {
    const viewer = yield* currentViewer;

    return yield* orRefuse(
      yield* agentsControlPlane("viewRun", (stub) => stub.agents().viewRun(viewer, id)),
    );
  });

/**
 * The run `id` when the caller watches it (its starter, or its watcher): an org admin who sees only its metadata gets
 * `403 forbidden`.
 */
const watchedRun = (id: string) =>
  Effect.gen(function* () {
    const run = yield* visibleRun(id);

    if (run.access === "admin")
      return yield* replyError(403, "forbidden", {
        message: "an org admin sees this run's metadata only: its starter or watchers steer it",
      });

    return run;
  });

/**
 * A run as the panel shows it (`GET /agent-runs/:run`): what the index says, and, to its starter and its watchers, what
 * its object says it is now (its turns, activity, transcript, and what it and its child runs wait on). An org admin's
 * view is the index's metadata only: the object is not asked.
 */
const detailOf = (run: RunView) =>
  Effect.gen(function* () {
    // An org admin's view is the run's metadata (ADR 0040): its object, which holds the transcript, is not asked.
    if (run.access === "admin") return run satisfies RunDetail;
    const shown = yield* callRun("show", run.id, (stub) => stub.show());

    return {
      ...run,
      state: shown.state,
      turns: shown.turns,
      activity: shown.activity,
      transcript: shown.transcript,
      // An object from before #232 answers no `waiting`.
      ...(shown.waiting === undefined ? {} : { waiting: shown.waiting }),
    } satisfies RunDetail;
  });

/**
 * The current org's retention period for agent runs (#228), from the Platform registry, for a run's page (#234), which
 * reads it once (`GET /agent-runs/:run/retention`), not on each read of the run; `undefined` when the registry cannot
 * be read (logged): the page then says nothing of it.
 */
const retentionDays = Effect.gen(function* () {
  const org = yield* CurrentOrg;
  const found = yield* platform("getOrgById", (stub) => stub.getOrgById(org));

  return found?.runRetentionDays;
}).pipe(
  Effect.catch((error) =>
    Effect.logWarning("agent runs: retention period unread").pipe(
      Effect.annotateLogs({ detail: error.message }),
      Effect.as(undefined),
    ),
  ),
);

const start = Effect.gen(function* () {
  const viewer = yield* currentViewer;
  const org = yield* CurrentOrg;
  const agent = yield* param("id");
  const body = yield* decode(StartRun);

  yield* checked(body.input, "input", body.idempotency_key);

  const started = yield* orRefuse(
    yield* agentsControlPlane("startRun", (stub) =>
      stub.agents().startRun(viewer, agent, "chat", body.idempotency_key),
    ),
  );

  const { run } = started;

  // The run's first turn: a start found again by its idempotency key finds it.
  const first = yield* callRun("start", run.id, (stub) =>
    stub.start({ org, id: run.id }, body.input),
  ).pipe(
    Effect.tapError(() =>
      started.created
        ? agentsControlPlane("abandonRun", (stub) => stub.agents().abandonRun(viewer, run.id)).pipe(
            Effect.ignore,
          )
        : Effect.void,
    ),
  );

  const current = yield* visibleRun(run.id);

  return jsonReply(201, { run: current, turn: first.turn } satisfies StartedRun);
});

const message = Effect.gen(function* () {
  const run = yield* watchedRun(yield* param("run"));
  const body = yield* decode(SendMessage);

  yield* checked(body.message, "message", body.idempotency_key);

  const sent = yield* callRun("message", run.id, (stub) =>
    stub.message(body.message, body.idempotency_key),
  );

  return jsonReply(200, sent satisfies MessageSent);
});

const wait = Effect.gen(function* () {
  const run = yield* watchedRun(yield* param("run"));
  const body = yield* decode(WaitRun);
  const timeout = body.timeout_ms ?? DEFAULT_WAIT_MS;

  if (timeout < 0 || timeout > MAX_WAIT_MS)
    return yield* replyError(422, "invalid", {
      message: `timeout_ms is between 0 and ${MAX_WAIT_MS}`,
      path: "timeout_ms",
    });

  const waited = yield* callRun("wait", run.id, (stub) => stub.wait(body.turn, timeout));

  return jsonReply(200, {
    finished: waited.finished,
    state: waited.state,
    turn: waited.turn,
    ...(waited.activity === undefined ? {} : { activity: waited.activity }),
    ...(waited.waiting === undefined || waited.waiting.length === 0
      ? {}
      : { waiting: waited.waiting }),
  });
});

const cancel = Effect.gen(function* () {
  const id = yield* param("run");
  const viewer = yield* currentViewer;

  // Its starter, its watchers, or an org admin, any run of the org (#232, ADR 0040).
  const seen = yield* orRefuse(
    yield* agentsControlPlane("cancellableRun", (stub) => stub.agents().cancellableRun(viewer, id)),
  );

  const cancelled = yield* callRun("cancel", id, (stub) => stub.cancel());

  // An org admin who does not see the run (a private agent's) learns only whether a turn was cancelled.
  if (seen === null) return jsonReply(200, { cancelled } satisfies CancelledRun);

  return jsonReply(200, { run: yield* visibleRun(id), cancelled } satisfies CancelledRun);
});

const remove = Effect.gen(function* () {
  const id = yield* param("run");
  const viewer = yield* currentViewer;

  // Its starter or its watchers (#234); an org admin who sees its metadata only gets `403`, anyone else `404`.
  const removed = yield* orRefuse(
    yield* agentsControlPlane("deleteRun", (stub) => stub.agents().deleteRun(viewer, id)),
  );

  // It left the index with its child runs: their objects, which hold the transcripts, are deleted now (#228).
  yield* sweepDeletedRuns(yield* AgentsEnv, yield* CurrentOrg);

  return jsonReply(200, { id, deleted: removed.deleted } satisfies DeletedRun);
});

/** The run's retention period (`GET /agent-runs/:run/retention`), for whoever sees the run. */
const retention = Effect.gen(function* () {
  yield* visibleRun(yield* param("run"));
  const days = yield* retentionDays;

  return jsonReply(
    200,
    (days === undefined ? {} : { retention_days: days }) satisfies RunRetention,
  );
});

/** `view` with its cost from `costs` (#234): `0` for a run with no priced record. */
const costed = <V extends RunView>(view: V, costs: ReadonlyMap<string, number>): V => ({
  ...view,
  cost_micros: costs.get(view.id) ?? 0,
});

/**
 * The agent run routes (mounted by `managementRoutes`, `routes.ts`), with what they read of the other areas: the runs'
 * costs (`references.runCosts`, #234).
 */
export const runRoutes = <R>(references: AgentReferences<R>) => {
  /**
   * `views` with what each costs so far, as `viewer` may read it (#234); when the costs cannot be read, none says one
   * (not known, rather than `0`).
   */
  const withCosts = <V extends RunView>(views: ReadonlyArray<V>, viewer: Viewer) =>
    Effect.map(
      references.runCosts(
        views.map((view) => view.id),
        viewer.member,
      ),
      Option.match({
        onNone: () => views,
        onSome: (costs) => views.map((view) => costed(view, costs)),
      }),
    );

  /** One run's view with its cost, as {@link withCosts}. */
  const withCost = <V extends RunView>(view: V, viewer: Viewer) =>
    Effect.map(
      references.runCosts([view.id], viewer.member),
      Option.match({ onNone: () => view, onSome: (costs) => costed(view, costs) }),
    );

  const list = Effect.gen(function* () {
    const viewer = yield* currentViewer;

    const listed = yield* agentsControlPlane("viewRuns", (stub) => stub.agents().viewRuns(viewer));

    return jsonReply(200, { runs: yield* withCosts(listed.runs, viewer) });
  });

  const get = Effect.gen(function* () {
    const viewer = yield* currentViewer;
    const run = yield* visibleRun(yield* param("run"));

    return jsonReply(200, yield* withCost(yield* detailOf(run), viewer));
  });

  return HttpRouter.addAll([
    route("POST", "/agents/:id/runs", start),
    route("GET", "/agent-runs", list),
    route("GET", "/agent-runs/:run", get),
    route("DELETE", "/agent-runs/:run", remove),
    route("POST", "/agent-runs/:run/messages", message),
    route("POST", "/agent-runs/:run/wait", wait),
    route("GET", "/agent-runs/:run/retention", retention),
    route("POST", "/agent-runs/:run/cancel", cancel),
  ]);
};
