/**
 * The agents toolkit's calls (#229, ADR 0040): what `agents_start`, `agents_message`, `agents_wait`, `agents_status` and
 * `agents_cancel` do, once Tools' MCP endpoint decided that the caller reaches the tool (the built-in toolkit `agents`:
 * reach, tool scope and tool class, Spend, approval rules) and handed the call to the Worker it runs in. The Worker
 * fills Tools' port (`AgentsToolkitPort`) with {@link agentsToolkitCalls}; Agents imports nothing of Tools, and this
 * module answers that port's shape.
 *
 * Who calls (`ToolkitCaller`, `runs/runs.ts`): a member through an API key, who sees only the runs that key started; a
 * member signed in, who sees every run they started; or an agent run, whose start makes a **child run** and which sees
 * the child runs it started. Any other run answers like an unknown one. A run's object (`AGENT_RUN`) is reached as the
 * management routes reach it (`run-routes.ts`), and a start whose call of it fails ends the run it created.
 *
 * Every answer is an MCP tool result, its text a JSON document; a refusal is one with `isError`, so the model can
 * correct itself. Nothing fails the call.
 */
import { Data, Effect, Result, Schema } from "effect";
import type { AccessIdentity } from "@commissary/auth";
import type { RunView, TurnView } from "@commissary/contract/agent-runs";
import {
  CancelArguments,
  DEFAULT_WAIT_SECONDS,
  MAX_WAIT_SECONDS,
  MessageArguments,
  StartArguments,
  StatusArguments,
  WaitArguments,
} from "@commissary/contract/agents-toolkit";
import type { OrgId, Reply } from "@commissary/core";
import { callControlPlane, controlPlaneOf } from "@commissary/state";
import { type AgentsBindings, type AgentsControlPlaneStub, agentRunOf } from "../env.ts";
import { MAX_IDEMPOTENCY_KEY, type RunsResult, type ToolkitCaller } from "../runs/runs.ts";

/** A call of the agents toolkit, as Tools' MCP endpoint hands it over (its `AgentsToolkitRequest`). */
export interface ToolkitRequest {
  readonly identity: AccessIdentity;
  readonly org: OrgId;
  /** The tool's upstream name. */
  readonly tool: string;
  readonly arguments: Schema.JsonObject;
  /** The agents the caller's tool scope names; `undefined`: every agent within reach. */
  readonly scopeAgents?: ReadonlyArray<string> | undefined;
}

/** An answer that ends the call early: a refusal, as the tool result the model gets. */
class Answered extends Data.TaggedError("Answered")<{ readonly result: Schema.JsonObject }> {}

const toolText = (text: string, isError: boolean): Schema.JsonObject => ({
  content: [{ type: "text", text }],
  isError,
});

/** A tool result whose text is `value` as JSON. */
const jsonResult = (value: Schema.Json): Schema.JsonObject =>
  toolText(JSON.stringify(value, null, 2), false);

/** Ends the call with the tool error `text`. */
const refused = (text: string) => Effect.fail(new Answered({ result: toolText(text, true) }));

const UNREACHABLE = toolText("Commissary could not reach the org's agents; try again.", true);

/** Who calls, as the Agents area sees them; none for a caller without a member (an Access service token). */
const callerOf = (identity: AccessIdentity): ToolkitCaller | undefined => {
  const { principal } = identity;

  if (principal.kind === "run") return { kind: "run", runId: principal.runId };

  if (principal.kind === "key")
    return { kind: "member", member: principal.memberId, apiKeyId: principal.keyId };

  return identity.memberId === undefined
    ? undefined
    : { kind: "member", member: identity.memberId };
};

/**
 * Who claims a run's results (`Claimant`): each caller claims every result once, so one member's API keys, the member
 * signed in, and a run each wait for every turn.
 */
const claimantOf = (caller: ToolkitCaller): string => {
  if (caller.kind === "run") return `run:${caller.runId}`;

  return caller.apiKeyId === undefined ? `member:${caller.member}` : `key:${caller.apiKeyId}`;
};

/** The arguments of a call, decoded with `schema`, or a tool error that says what is wrong with them. */
const decoded = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  args: Schema.JsonObject,
) => {
  const result = Schema.decodeUnknownResult(schema)(args);

  return Result.isFailure(result)
    ? refused(`Invalid arguments: ${result.failure.message}`)
    : Effect.succeed(result.success);
};

/** A message or input that is empty, or an idempotency key longer than a run takes, is refused before anything runs. */
const checked = (text: string, field: string, key: string | undefined) => {
  if (text.trim() === "") return refused(`Invalid arguments: ${field} is empty.`);

  if (key !== undefined && key.length > MAX_IDEMPOTENCY_KEY)
    return refused(
      `Invalid arguments: an idempotency key has at most ${MAX_IDEMPOTENCY_KEY} characters.`,
    );

  return Effect.void;
};

/** A turn as the toolkit answers it. */
const turnOf = (turn: TurnView) => ({
  id: turn.id,
  status: turn.status,
  ...(turn.answer === undefined ? {} : { answer: turn.answer }),
  ...(turn.error === undefined ? {} : { error: turn.error }),
});

/** A run as the toolkit lists it. */
const runOf = (run: RunView) => ({
  run: run.id,
  agent: run.agent.name ?? run.agent.id,
  status: run.state,
  ...(run.starter?.kind === "run" ? { started_by_run: run.starter.id } : {}),
  updated_at: run.updated_at,
});

/** The agents toolkit's calls over `env`'s ControlPlanes and runs' objects (the Worker's request context fills Tools' port with it). */
export const agentsToolkitCalls = (env: Pick<AgentsBindings, "CONTROL_PLANE" | "AGENT_RUN">) => {
  const agents = <R>(org: OrgId, label: string, call: (stub: AgentsControlPlaneStub) => R) =>
    callControlPlane(label, controlPlaneOf(env, org), call);

  /** Calls the run's object; its refusal ends the call with `refusal`'s words for it. */
  const onRun = <A>(
    org: OrgId,
    run: string,
    label: string,
    call: (stub: ReturnType<typeof agentRunOf>) => Promise<RunsResult<A>>,
    refusal: (error: string, message: string) => string,
  ): Effect.Effect<A, Answered | Reply> =>
    Effect.gen(function* () {
      const result = yield* callControlPlane(`agent run ${label}`, agentRunOf(env, org, run), call);

      // SAFETY: the object's RPC answers plain data of `RunsResult<A>`; the stub's serialised type only loses the
      // readonly modifiers.
      const answer = result as RunsResult<A>;

      return answer.ok ? answer.value : yield* refused(refusal(answer.error, answer.message));
    });

  const unknownRun = (run: string) =>
    `Unknown run ${run}. agents_status lists the runs you started.`;

  /** The run `run` as `caller` sees it; any other is an unknown run. */
  const visible = (org: OrgId, caller: ToolkitCaller, run: string) =>
    Effect.gen(function* () {
      const found = yield* agents(org, "getToolkitRun", (stub) =>
        stub.agents().getToolkitRun(caller, run),
      );

      return found.ok ? found.value : yield* refused(unknownRun(run));
    });

  /** The words for a refusal of the run `run`'s object. */
  const runRefusal = (run: string) => (error: string, message: string) => {
    switch (error) {
      case "not_found":
        return message === "turn not found" ? `Run ${run} has no such turn.` : unknownRun(run);
      case "run_ended":
        return `Run ${run} ended: ${message}.`;
      default:
        return `Run ${run} could not take the call: ${message}.`;
    }
  };

  const start = Effect.fnUntraced(function* (
    request: ToolkitRequest,
    caller: ToolkitCaller,
  ): Effect.fn.Return<Schema.JsonObject, Answered | Reply> {
    const args = yield* decoded(StartArguments, request.arguments);

    yield* checked(args.input, "input", args.idempotency_key);

    const started = yield* agents(request.org, "startToolkitRun", (stub) =>
      stub.agents().startToolkitRun(caller, args.agent, request.scopeAgents, args.idempotency_key),
    );

    if (!started.ok)
      switch (started.error) {
        case "not_found":
          return yield* refused(
            `Unknown agent ${args.agent}. agents_start's description lists the agents you may run.`,
          );
        case "agent_disabled":
          return yield* refused(`The agent ${args.agent} is disabled.`);
        case "run_ended":
          return yield* refused("This run ended: it cannot start another.");
        default:
          return yield* refused(`The run was not started: ${started.message}.`);
      }

    const { run, created, child } = started.value;

    // The run's first turn: a start found again by its idempotency key finds it.
    const first = yield* onRun(
      request.org,
      run.id,
      "start",
      (stub) =>
        stub.start(
          { org: request.org, id: run.id, ...(child === undefined ? {} : { child }) },
          args.input,
        ),
      runRefusal(run.id),
    ).pipe(
      Effect.tapError(() =>
        created
          ? agents(request.org, "abandonToolkitRun", (stub) =>
              stub.agents().abandonToolkitRun(caller, run.id),
            ).pipe(Effect.ignore)
          : Effect.void,
      ),
    );

    return jsonResult({ run: run.id, turn: first.turn.id, status: first.turn.status });
  });

  const message = Effect.fnUntraced(function* (
    request: ToolkitRequest,
    caller: ToolkitCaller,
  ): Effect.fn.Return<Schema.JsonObject, Answered | Reply> {
    const args = yield* decoded(MessageArguments, request.arguments);

    yield* checked(args.message, "message", args.idempotency_key);
    const run = yield* visible(request.org, caller, args.run);

    const sent = yield* onRun(
      request.org,
      run.id,
      "message",
      (stub) => stub.message(args.message, args.idempotency_key),
      runRefusal(run.id),
    );

    return jsonResult({ run: run.id, turn: sent.turn.id, disposition: sent.delivery });
  });

  const wait = Effect.fnUntraced(function* (
    request: ToolkitRequest,
    caller: ToolkitCaller,
  ): Effect.fn.Return<Schema.JsonObject, Answered | Reply> {
    const args = yield* decoded(WaitArguments, request.arguments);
    const seconds = args.timeout ?? DEFAULT_WAIT_SECONDS;

    if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_WAIT_SECONDS)
      return yield* refused(
        `Invalid arguments: timeout is between 0 and ${MAX_WAIT_SECONDS} seconds.`,
      );

    const run = yield* visible(request.org, caller, args.run);

    const claimed = yield* onRun(
      request.org,
      run.id,
      "claim",
      (stub) => stub.claim(args.turn, Math.round(seconds * 1000), claimantOf(caller)),
      runRefusal(run.id),
    );

    if (claimed.turn === undefined)
      return jsonResult({
        run: run.id,
        status: claimed.state,
        result:
          claimed.delivered === true
            ? "none: you have every turn's result (some were delivered to you as messages), and no turn runs"
            : "none: you claimed every turn's result already, and no turn runs",
      });

    return jsonResult({
      run: run.id,
      status: claimed.state,
      finished: claimed.finished,
      turn: turnOf(claimed.turn),
      ...(claimed.activity === undefined ? {} : { latest_activity: claimed.activity }),
    });
  });

  const status = Effect.fnUntraced(function* (
    request: ToolkitRequest,
    caller: ToolkitCaller,
  ): Effect.fn.Return<Schema.JsonObject, Answered | Reply> {
    const args = yield* decoded(StatusArguments, request.arguments);

    if (args.run === undefined) {
      const listed = yield* agents(request.org, "listToolkitRuns", (stub) =>
        stub.agents().listToolkitRuns(caller),
      );

      return jsonResult({ runs: listed.runs.map(runOf) });
    }

    const run = yield* visible(request.org, caller, args.run);

    const shown = yield* onRun(
      request.org,
      run.id,
      "show",
      (stub) => stub.show(),
      runRefusal(run.id),
    );

    return jsonResult({
      ...runOf(run),
      status: shown.state,
      turns: shown.turns.map(turnOf),
      recent_activity: shown.activity,
    });
  });

  const cancel = Effect.fnUntraced(function* (
    request: ToolkitRequest,
    caller: ToolkitCaller,
  ): Effect.fn.Return<Schema.JsonObject, Answered | Reply> {
    const args = yield* decoded(CancelArguments, request.arguments);
    const run = yield* visible(request.org, caller, args.run);

    const cancelled = yield* onRun(
      request.org,
      run.id,
      "cancel",
      (stub) => stub.cancel(),
      runRefusal(run.id),
    );

    return jsonResult({ run: run.id, cancelled });
  });

  const TOOLS = { start, message, wait, status, cancel };

  return {
    /** Answers a call of the agents toolkit with its tool result; never fails. */
    call: (request: ToolkitRequest): Effect.Effect<Schema.JsonObject> => {
      const caller = callerOf(request.identity);

      if (caller === undefined)
        return Effect.succeed(
          toolText(
            "The agents toolkit needs a member of the org, or an agent run, to call it.",
            true,
          ),
        );

      if (!Object.hasOwn(TOOLS, request.tool))
        return Effect.succeed(toolText(`The agents toolkit has no tool ${request.tool}.`, true));

      // SAFETY: `request.tool` is one of `TOOLS`' own keys, checked just above.
      const tool = TOOLS[request.tool as keyof typeof TOOLS];

      return tool(request, caller).pipe(
        Effect.catchTag("Answered", (answered) => Effect.succeed(answered.result)),
        Effect.catchTag("Reply", () => Effect.succeed(UNREACHABLE)),
      );
    },
  };
};
