/**
 * Agent runs on the management API (`AgentRunsGroup` in `@commissary/contract/agent-runs`, #227, ADR 0040): start a run
 * of an agent (`POST /agents/:id/runs`), list the caller's runs, show one, send it a message, wait for a turn and cancel
 * the running turn. The panel's chat (#234) and the agents toolkit (#229) are built on the same operations.
 *
 * The org's index of runs (the Agents part, `runs/runs.ts`) decides who sees a run: its starter only, for now (watchers
 * and org admins come with #232); any other run answers like an unknown one. The run itself is its Durable Object
 * (`AGENT_RUN`, `runs/run-object.ts`), which this Worker reaches by the API Worker's script name. A run started here is
 * started by the member who asks, with the trigger kind `chat`.
 *
 * A start whose call of the run's object fails ends the run it created (`abandonRun`): the object may or may not have
 * taken it, so the run is not left looking idle. A start again with the same idempotency key then answers `409
 * run_ended`; a start with another key starts a new run.
 *
 * Like every Agents route, each answers 404 without the deployment's Dynamic Workers binding (`LOADER`).
 */
import { Effect } from "effect";
import { HttpRouter } from "effect/http";
import { currentViewer } from "@commissary/auth";
import {
  type CancelledRun,
  MAX_WAIT_MS,
  type MessageSent,
  type RunDetail,
  SendMessage,
  StartRun,
  type StartedRun,
  WaitRun,
} from "@commissary/contract/agent-runs";
import { CurrentOrg, jsonReply, replyError } from "@commissary/core";
import { callControlPlane } from "@commissary/state";
import { agentRunOf, agentsControlPlane, AgentsEnv } from "../env.ts";
import { MAX_IDEMPOTENCY_KEY, type RunsErrorCode, type RunsResult } from "../runs/runs.ts";
import { decode, orRefuseWith, param, route } from "./http.ts";

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

/** The run `id` as its starter sees it in the org's index: anyone else's answers like an unknown run (`404`). */
const visibleRun = (id: string) =>
  Effect.gen(function* () {
    const viewer = yield* currentViewer;

    return yield* orRefuse(
      yield* agentsControlPlane("getRun", (stub) => stub.agents().getRun(viewer, id)),
    );
  });

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

const list = Effect.gen(function* () {
  const viewer = yield* currentViewer;

  return jsonReply(
    200,
    yield* agentsControlPlane("listRuns", (stub) => stub.agents().listRuns(viewer)),
  );
});

const get = Effect.gen(function* () {
  const run = yield* visibleRun(yield* param("run"));
  const shown = yield* callRun("show", run.id, (stub) => stub.show());

  return jsonReply(200, {
    ...run,
    state: shown.state,
    turns: shown.turns,
    activity: shown.activity,
    transcript: shown.transcript,
  } satisfies RunDetail);
});

const message = Effect.gen(function* () {
  const run = yield* visibleRun(yield* param("run"));
  const body = yield* decode(SendMessage);

  yield* checked(body.message, "message", body.idempotency_key);

  const sent = yield* callRun("message", run.id, (stub) =>
    stub.message(body.message, body.idempotency_key),
  );

  return jsonReply(200, sent satisfies MessageSent);
});

const wait = Effect.gen(function* () {
  const run = yield* visibleRun(yield* param("run"));
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
  });
});

const cancel = Effect.gen(function* () {
  const id = yield* param("run");

  yield* visibleRun(id);
  const cancelled = yield* callRun("cancel", id, (stub) => stub.cancel());
  const run = yield* visibleRun(id);

  return jsonReply(200, { run, cancelled } satisfies CancelledRun);
});

/** The agent run routes (mounted by `managementRoutes`, `routes.ts`). */
export const runRoutes = HttpRouter.addAll([
  route("POST", "/agents/:id/runs", start),
  route("GET", "/agent-runs", list),
  route("GET", "/agent-runs/:run", get),
  route("POST", "/agent-runs/:run/messages", message),
  route("POST", "/agent-runs/:run/wait", wait),
  route("POST", "/agent-runs/:run/cancel", cancel),
]);
