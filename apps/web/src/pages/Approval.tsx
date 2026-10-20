// One approval (/approvals/$approvalId, #201): the page a pending tool call links to. It shows the tool, its toolkit,
// the caller, the arguments (to an eligible approver, while it waits) and the time left, with approve and deny for
// whoever may decide it. The server decides both (`can_decide`, `arguments`); anyone else gets `404`.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { getRouteApi, Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { Check, X } from "lucide-react";
import { useState } from "react";
import type { ApprovalDecision, ApprovalView } from "@commissary/contract/approvals";
import { APPROVALS, approvalAtom, decideApprovalAtom, nowAtom } from "../api/client.ts";
import { kit, Problem, Section } from "../components/Kit.tsx";
import {
  approverLabel,
  argumentsText,
  callerText,
  cannotDecideText,
  nobodyDecidesText,
  statusText,
  timeLeftText,
} from "../lib/approvals.ts";
import { failureMessage } from "../lib/failure.ts";
import { useAction } from "../lib/use-action.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import styles from "./Approvals.module.css";

const route = getRouteApi("/approvals/$approvalId");

const Decide = ({ approval }: { readonly approval: ApprovalView }) => {
  const decide = useAction(decideApprovalAtom);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  // The decision being sent: its button spins and says so, and both wait until it settles.
  const [sending, setSending] = useState<ApprovalDecision["decision"] | undefined>(undefined);

  const run = async (decision: ApprovalDecision["decision"]) => {
    setProblem(undefined);
    setSending(decision);

    const outcome = await decide.run({
      params: { id: approval.id },
      payload: { decision },
      reactivityKeys: APPROVALS,
    });

    setSending(undefined);

    if (!outcome.ok) setProblem(outcome.detail ?? outcome.message);
  };

  const busy = decide.busy || sending !== undefined;

  return (
    <>
      <div className={styles["actions"]}>
        <button
          type="button"
          className={kit["primary"]}
          disabled={busy}
          aria-busy={sending === "approve"}
          onClick={() => void run("approve")}
        >
          <Check
            aria-hidden="true"
            size={16}
            strokeWidth={2.25}
            className={sending === "approve" ? kit["spinning"] : undefined}
          />
          {sending === "approve" ? "Approving…" : "Approve"}
        </button>
        {/* Denying deletes nothing: a secondary button, not the danger one. */}
        <button
          type="button"
          className={kit["secondary"]}
          disabled={busy}
          aria-busy={sending === "deny"}
          onClick={() => void run("deny")}
        >
          <X
            aria-hidden="true"
            size={16}
            strokeWidth={2.25}
            className={sending === "deny" ? kit["spinning"] : undefined}
          />
          {sending === "deny" ? "Denying…" : "Deny"}
        </button>
      </div>
      {problem === undefined ? null : <Problem>Could not decide the call. {problem}</Problem>}
    </>
  );
};

const Details = ({ approval }: { readonly approval: ApprovalView }) => {
  const now = useAtomValue(nowAtom);
  const why = cannotDecideText(approval);
  const nobody = nobodyDecidesText(approval);

  return (
    <>
      <dl className={styles["facts"]}>
        <dt>Status</dt>
        <dd role="status">{statusText(approval)}</dd>
        <dt>Toolkit</dt>
        <dd>{approval.toolkit.name}</dd>
        <dt>Caller</dt>
        <dd>{callerText(approval)}</dd>
        <dt>Approver</dt>
        <dd>{approverLabel(approval.approver)}</dd>
        <dt>Credential</dt>
        <dd>
          {approval.credential === "shared" ? "The toolkit's shared one" : "The caller's own"}
        </dd>
        <dt>Time left</dt>
        <dd>{approval.status === "pending" ? timeLeftText(approval, now) : "None"}</dd>
      </dl>
      {approval.arguments === undefined ? null : (
        <Section title="Arguments">
          <pre className={styles["arguments"]}>
            <code>{argumentsText(approval.arguments)}</code>
          </pre>
        </Section>
      )}
      {nobody === undefined ? null : <Problem>{nobody}</Problem>}
      {approval.can_decide ? <Decide approval={approval} /> : null}
      {why === undefined ? null : <p className={kit["muted"]}>{why}</p>}
    </>
  );
};

export const ApprovalPage = () => {
  const { approvalId } = route.useParams();
  const result = useAtomValue(approvalAtom(approvalId));
  const retry = useAtomRefresh(approvalAtom(approvalId));
  const title = AsyncResult.isSuccess(result) ? result.value.tool.name : "Approval";

  usePageTitle(`Approval of ${title}`);

  return (
    <div className={styles["page"]}>
      <header className={styles["head"]}>
        <p className={kit["muted"]}>
          <Link to="/approvals">Approvals</Link>
        </p>
        <h1 className={styles["title"]}>
          <code>{title}</code>
        </h1>
        <p className={styles["intro"]}>
          Approving does not make the call: the client or agent makes it again, and the same call
          with the same arguments goes through once, until an hour after it was first made.
        </p>
      </header>
      {AsyncResult.match(result, {
        onInitial: () => (
          <p className={kit["muted"]} aria-busy="true">
            Loading the approval…
          </p>
        ),
        onFailure: (failure) => (
          <Problem onRetry={retry}>
            Could not load the approval. Its hour may be over, which deletes it, or it is not yours
            to see. {failureMessage(failure)}
          </Problem>
        ),
        onSuccess: ({ value }) => <Details approval={value} />,
      })}
    </div>
  );
};
