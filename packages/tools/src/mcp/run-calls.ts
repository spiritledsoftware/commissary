/**
 * An agent run's gated sandbox calls (#230), as the API Worker's run gateway serves them: each operation of a gated
 * call on the run's session ({@link runSandboxOperation}), and the call's settling ({@link settleRunToolCall}), which
 * writes its one usage record, as the MCP endpoint writes any call's (`endpoint.ts`): who called, the toolkit and the
 * tool, the outcome, the latency from the gate to the settling, the sizes of the arguments and of the answer, the cost
 * (the price the gate charged) and how an approval rule decided it. The computer time its operations used (#224) is
 * charged as each answers, and recorded by the run's session, once per stretch of its computer
 * (`sandbox/cloudflare/session.ts`), as a sandbox session's own record holds the computer time of its calls.
 * The gate itself is the endpoint's `tools/call` (`RUN_EXECUTES_META`); the ticket it answers is the Tools part's
 * (`sandbox/run-calls.ts`).
 */
import { Clock, Effect } from "effect";
import type {
  RunToolReport,
  RunToolSettled,
  SandboxEnvReply,
  SandboxEnvRequest,
} from "@commissary/contract/sandbox-env";
import { CurrentOrg, type Reply, replyError } from "@commissary/core";
import type { BillingEnv } from "@commissary/billing/api";
import { toolsControlPlane, ToolsEnv } from "../env.ts";
import { insertToolCallRecord, type ToolCallRecord } from "../usage/record.ts";
import { planLimitedText, refusedText } from "./endpoint.ts";

/** Runs `request` of the gated call `ticket` of the run `run` of the current org on its session. */
export const runSandboxOperation = (
  run: string,
  ticket: string,
  request: SandboxEnvRequest,
): Effect.Effect<SandboxEnvReply, Reply, ToolsEnv | CurrentOrg> =>
  toolsControlPlane("runSandboxOperation", (stub) =>
    stub.tools().runSandboxOperation(run, ticket, request),
  );

/**
 * Settles the gated call `ticket` of the run `run` of the current org with how it ended (`report`), and writes its
 * usage record under the ticket's id, before it answers: it fails when the record could not be written, and the run
 * settles it again, which answers the same and writes the record once (`INSERT OR IGNORE`). A ticket unknown, past its
 * settling's grace or another run's writes none. A call one of whose commands a Spend limit refused after all, as it
 * needed the computer (#224), or the org's plan (#241), is recorded as refused, and answers the refusal's words, which
 * end the run's turn.
 */
export const settleRunToolCall = (
  run: string,
  ticket: string,
  report: RunToolReport,
): Effect.Effect<RunToolSettled, Reply, ToolsEnv | BillingEnv | CurrentOrg> =>
  Effect.gen(function* () {
    const settled = yield* toolsControlPlane("settleRunSandboxCall", (stub) =>
      stub.tools().settleRunSandboxCall(run, ticket),
    );

    if (settled === undefined) return { recorded: false };
    const { refusal } = settled;
    const planRefused = settled.planRefused === true && settled.planRefusal !== undefined;
    const org = yield* CurrentOrg;
    const env = yield* ToolsEnv;
    const settledAt = settled.settledAt ?? (yield* Clock.currentTimeMillis);

    const record: ToolCallRecord = {
      requestId: settled.id,
      orgId: org,
      principalId: settled.principal,
      memberId: settled.member,
      run: settled.run,
      toolkitId: settled.toolkitId,
      toolId: `${settled.toolkitId}:${settled.tool}`,
      credential: settled.credential,
      private: settled.private,
      outcome: refusal === undefined && !planRefused ? report.outcome : "refused",
      requestedAt: settled.requestedAt,
      latencyMs: Math.max(0, settledAt - settled.requestedAt),
      requestBytes: settled.requestBytes,
      responseBytes: report.responseBytes,
      costMicros: settled.costMicros,
      approval: settled.approval,
    };

    // Written before the answer: a write that fails fails the settling, which the run tries again.
    yield* Effect.tryPromise({
      try: async () => await insertToolCallRecord(env.USAGE, record),
      catch: (cause) => (cause instanceof Error ? cause.message : "unknown error"),
    }).pipe(
      Effect.catch((message) =>
        Effect.logError(`run tool call record not written: ${message}`).pipe(
          Effect.andThen(Effect.fail(replyError(503, "usage record not written"))),
        ),
      ),
    );

    // A command the plan kept from the computer after all (#241): the plan's words end the turn.
    if (refusal === undefined) {
      if (!planRefused || settled.planRefusal === undefined) return { recorded: true };

      return {
        recorded: true,
        refusal: yield* planLimitedText(settled.tool, {
          refusal: settled.planRefusal,
          computer: "needed",
          ...(settled.computerStopped === true ? { computerStopped: true as const } : {}),
        }),
      };
    }

    const needed = { refusal, computer: "needed" as const };

    return {
      recorded: true,
      refusal: refusedText(
        settled.tool,
        settled.computerStopped === true ? { ...needed, computerStopped: true } : needed,
      ),
    };
  });
