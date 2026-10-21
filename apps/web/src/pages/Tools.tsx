// Tools (/tools, #208): the toolkits the caller reaches and their own private toolkits, one row each with its kind and
// source, its sign-ins, its tool count and what needs attention, what is closed or failing first. Every member reads
// every org toolkit (and its tool list), and uses the tools their tool grants give; an org admin also sees the other
// members' private toolkits, existence only (ADR 0023), and can remove one. The head adds a toolkit and opens the
// endpoint URL builder and the Approvals page, where calls that wait for an approver are answered (#201, #209).
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { Plus, ShieldCheck, Waypoints } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import type { LimitedToolkitView } from "@commissary/contract/tools";
import { meAtom, removeToolkitAtom, TOOLKITS, toolkitsAtom } from "../api/client.ts";
import { kit, Problem } from "../components/Kit.tsx";
import { PrivateRows } from "../components/PrivateRows.tsx";
import { failureMessage } from "../lib/failure.ts";
import {
  canAdd,
  otherRows,
  problemOf,
  type SignInState,
  sortRows,
  type ToolkitRow,
  type ToolsCaller,
  toolkitRow,
  toolsCallerOf,
} from "../lib/toolkits.ts";
import { useAction } from "../lib/use-action.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import { Flags } from "./ToolkitFlags.tsx";
import styles from "./Tools.module.css";

/** A URL or path that may break after each `/` (and nowhere inside a file name) on a narrow screen. */
export const Breakable = ({ text }: { readonly text: string }): ReactNode =>
  text.split("/").map((part, index, parts) => (
    <Fragment key={parts.slice(0, index + 1).join("/")}>
      {part}
      {index < parts.length - 1 ? (
        <>
          /<wbr />
        </>
      ) : null}
    </Fragment>
  ));

const SignIns = ({ signIns }: { readonly signIns: ReadonlyArray<SignInState> }) =>
  signIns.length === 0 ? (
    <span className={styles["secondary"]}>Nothing to sign in to</span>
  ) : (
    <span className={styles["lines"]}>
      {signIns.map((signIn) => (
        <span key={signIn.slot}>{signIn.text}</span>
      ))}
    </span>
  );

const Row = ({ row }: { readonly row: ToolkitRow }) => (
  <tr>
    <td>
      <div className={styles["name"]}>
        <Link to="/tools/$toolkitId" params={{ toolkitId: row.toolkit.id }}>
          {row.toolkit.name}
        </Link>
        <span className={styles["secondary"]}>
          {row.toolkit.private ? "Your private toolkit · " : ""}
          {row.kind} · <Breakable text={row.source} />
        </span>
      </div>
      {/* On a narrow screen the sign-in column folds in here. */}
      <div className={styles["narrowOnly"]}>
        <SignIns signIns={row.signIns} />
      </div>
      <Flags flags={row.flags} />
    </td>
    <td className={styles["wide"]}>
      <SignIns signIns={row.signIns} />
    </td>
    <td className={styles["number"]}>{row.tools}</td>
  </tr>
);

const OtherToolkits = ({ others }: { readonly others: ReadonlyArray<LimitedToolkitView> }) => {
  const remove = useAction(removeToolkitAtom);
  const rows = otherRows(others);

  return (
    <PrivateRows
      title="Members' private toolkits"
      noun="private toolkit"
      rows={rows.map((row) => ({ key: row.id, label: row.added, owner: row.owner }))}
      onRemove={async ({ key }) => {
        const outcome = await remove.run({
          params: { id: key },
          headers: { "if-match": String(rows.find((row) => row.id === key)?.revision ?? 0) },
          reactivityKeys: TOOLKITS,
        });

        return outcome.ok
          ? { ok: true }
          : { ok: false, message: problemOf(outcome) ?? outcome.message };
      }}
    />
  );
};

const emptyText = (caller: ToolsCaller): string => {
  if (caller.admin)
    return "No toolkits yet. Add one from the catalog, by a service's domain or URL, or from an OpenAPI, GraphQL or Discovery document; members then use its tools under their tool grants.";

  return caller.privateToolkits
    ? "No toolkit reaches you yet. Add your own private toolkit, or ask an org admin for one."
    : "No toolkit reaches you yet. An org admin adds toolkits and grants their tools.";
};

const Toolkits = ({ caller }: { readonly caller: ToolsCaller }) => {
  const result = useAtomValue(toolkitsAtom);
  const retry = useAtomRefresh(toolkitsAtom);

  return AsyncResult.match(result, {
    onInitial: () => (
      <p className={kit["muted"]} aria-busy="true">
        Loading the toolkits…
      </p>
    ),
    onFailure: (failure) => (
      <Problem onRetry={retry}>Could not load the toolkits. {failureMessage(failure)}</Problem>
    ),
    onSuccess: ({ value }) => {
      const rows = sortRows(value.toolkits.map(toolkitRow));

      return (
        <>
          {rows.length === 0 ? (
            <p className={styles["empty"]}>{emptyText(caller)}</p>
          ) : (
            <div className={`${styles["section"]} ${styles["scroll"]}`}>
              <table className={styles["table"]}>
                <thead>
                  <tr>
                    <th scope="col">Toolkit</th>
                    <th scope="col" className={styles["wide"]}>
                      Sign-in
                    </th>
                    <th scope="col" className={styles["number"]}>
                      Tools
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <Row key={row.toolkit.id} row={row} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {value.others === undefined ? null : (
            <div className={styles["section"]}>
              <OtherToolkits others={value.others} />
            </div>
          )}
        </>
      );
    },
  });
};

export const ToolsPage = () => {
  const me = useAtomValue(meAtom);
  const caller = AsyncResult.isSuccess(me) ? toolsCallerOf(me.value) : undefined;

  usePageTitle("Tools");

  return (
    <div className={kit["page"]}>
      <header className={styles["head"]}>
        <div className={styles["titleRow"]}>
          <h1 className={styles["title"]}>Tools</h1>
          <div className={styles["actions"]}>
            <Link to="/approvals" className={kit["secondary"]}>
              <ShieldCheck aria-hidden="true" size={18} strokeWidth={2.25} />
              Approvals
            </Link>
            <Link to="/tools/endpoint" className={kit["secondary"]}>
              <Waypoints aria-hidden="true" size={18} strokeWidth={2.25} />
              Endpoint URL
            </Link>
            {caller !== undefined && canAdd(caller) ? (
              <Link to="/tools/add" className={kit["primary"]}>
                <Plus aria-hidden="true" size={18} strokeWidth={2.25} />
                Add toolkit
              </Link>
            ) : null}
          </div>
        </div>
        <p className={styles["intro"]}>
          Each toolkit gives clients and agents its tools on Commissary&rsquo;s MCP endpoint, signed
          in with the org&rsquo;s shared credential or a member&rsquo;s private one. Members use a
          toolkit&rsquo;s tools under their tool grants, set on the Grants page, and see the ones
          that reach them on My tools. A toolkit&rsquo;s prices and approval rules are on its page;
          a call that waits for approval is answered on the Approvals page.
        </p>
      </header>
      {caller === undefined ? null : <Toolkits caller={caller} />}
    </div>
  );
};
