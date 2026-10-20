// Approvals (/approvals, #201): the pending approvals of tool calls the signed-in member may decide, grouped by approver
// set, and their own calls that wait for someone else. Every member opens it; the server decides what each sees
// (only an eligible approver sees a call's arguments and may decide it). Each row links to the approval's page.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import type { ApprovalView } from "@commissary/contract/approvals";
import { approvalsAtom, nowAtom } from "../api/client.ts";
import { kit, Problem, Section } from "../components/Kit.tsx";
import { callerText, groupByApprover, timeLeftText } from "../lib/approvals.ts";
import { failureMessage } from "../lib/failure.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import styles from "./Approvals.module.css";

const ApprovalTable = ({
  label,
  approvals,
  now,
}: {
  readonly label: string;
  readonly approvals: ReadonlyArray<ApprovalView>;
  readonly now: number;
}) => (
  <table className={styles["table"]}>
    <caption className={kit["visuallyHidden"]}>{label}</caption>
    <thead>
      <tr>
        <th scope="col">Tool</th>
        <th scope="col">Caller</th>
        <th scope="col" className={styles["wide"]}>
          Time left
        </th>
        <th scope="col">
          <span className={kit["visuallyHidden"]}>Open</span>
        </th>
      </tr>
    </thead>
    <tbody>
      {approvals.map((approval) => (
        <tr key={approval.id}>
          <th scope="row" className={styles["name"]}>
            <code>{approval.tool.name}</code>
            <span className={styles["secondary"]}>{approval.toolkit.name}</span>
          </th>
          <td>{callerText(approval)}</td>
          <td className={styles["wide"]}>{timeLeftText(approval, now)}</td>
          <td>
            <Link
              to="/approvals/$approvalId"
              params={{ approvalId: approval.id }}
              aria-label={`${approval.can_decide ? "Decide" : "View"} the call of ${approval.tool.name}`}
            >
              {approval.can_decide ? "Decide" : "View"}
            </Link>
          </td>
        </tr>
      ))}
    </tbody>
  </table>
);

const Pending = ({ approvals }: { readonly approvals: ReadonlyArray<ApprovalView> }) => {
  const now = useAtomValue(nowAtom);
  const yours = approvals.filter((approval) => approval.can_decide);
  const waiting = approvals.filter((approval) => !approval.can_decide);

  if (approvals.length === 0)
    return (
      <p className={styles["empty"]}>
        Nothing waits for approval. A tool call that an approval rule holds shows here for its
        approvers until it is decided or its hour is over.
      </p>
    );

  return (
    <>
      {groupByApprover(yours).map((group) => (
        <Section key={group.key} title={`To decide: ${group.label}`}>
          <ApprovalTable label={group.label} approvals={group.approvals} now={now} />
        </Section>
      ))}
      {waiting.length === 0 ? null : (
        <Section title="Your calls waiting for another approver">
          <ApprovalTable label="Your calls" approvals={waiting} now={now} />
        </Section>
      )}
    </>
  );
};

export const ApprovalsPage = () => {
  usePageTitle("Approvals");
  const result = useAtomValue(approvalsAtom);
  const retry = useAtomRefresh(approvalsAtom);

  return (
    <div className={styles["page"]}>
      <header className={styles["head"]}>
        <h1 className={styles["title"]}>Approvals</h1>
        <p className={styles["intro"]}>
          Tool calls that wait for approval under a toolkit&rsquo;s approval rules. Approving one
          lets the same call, with the same arguments, through once when it is made again, until an
          hour after it was first made. A caller never approves their own call when a team or a list
          of members decides it.
        </p>
      </header>
      {AsyncResult.match(result, {
        onInitial: () => (
          <p className={kit["muted"]} aria-busy="true">
            Loading the approvals…
          </p>
        ),
        onFailure: (failure) => (
          <Problem onRetry={retry}>Could not load the approvals. {failureMessage(failure)}</Problem>
        ),
        onSuccess: ({ value }) => <Pending approvals={value.approvals} />,
      })}
    </div>
  );
};
