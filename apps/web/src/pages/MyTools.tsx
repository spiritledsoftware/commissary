// My tools (/my-tools, #209): the tools the signed-in member may use, by toolkit, and why: their own private
// credential, or which grants give them (their own, their teams', everyone's), or the agents toolkit. My models'
// counterpart; every member reads it. The server sends the reasons (`via` of `GET /tools`).
import { Link } from "@tanstack/react-router";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useDeferredValue, useId, useState } from "react";
import type { UsableToolkit } from "@commissary/contract/tools";
import { usableToolsAtom } from "../api/client.ts";
import { kit, Problem } from "../components/Kit.tsx";
import { failureMessage } from "../lib/failure.ts";
import { formatCount } from "../lib/format.ts";
import {
  filterMyTools,
  NO_TOOLS_NOTE,
  reachText,
  reasonsForTool,
  reasonsOf,
} from "../lib/my-tools.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import styles from "./MyTools.module.css";

const ToolkitReach = ({
  toolkit,
  open,
}: {
  readonly toolkit: UsableToolkit;
  readonly open: boolean;
}) => {
  const reasons = reasonsOf(toolkit.via);

  return (
    <details className={styles["toolkit"]} open={open}>
      <summary>
        <span className={styles["toolkitName"]}>{toolkit.name}</span>
        <span className={styles["count"]}>
          {formatCount(toolkit.tools.length)} {toolkit.tools.length === 1 ? "tool" : "tools"}
        </span>
      </summary>
      {reasons.length === 0 ? null : (
        <ul className={styles["reasons"]} aria-label={`Why ${toolkit.name} reaches you`}>
          {reasons.map((reason) => (
            <li key={`${reason.kind}-${reason.label}-${reason.gives}`}>
              <strong>{reason.label}</strong>: {reason.gives}
              {reason.kind === "private_available" ? (
                <>
                  {" "}
                  <Link to="/tools/$toolkitId" params={{ toolkitId: toolkit.id }}>
                    Open {toolkit.name}
                  </Link>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <table className={styles["table"]}>
        <caption className={kit["visuallyHidden"]}>Tools of {toolkit.name} you may use</caption>
        <thead>
          <tr>
            <th scope="col">Tool</th>
            <th scope="col">Class</th>
            <th scope="col" className={styles["wide"]}>
              Through
            </th>
          </tr>
        </thead>
        <tbody>
          {toolkit.tools.map((tool) => (
            <tr key={tool.id}>
              <th scope="row" className={styles["name"]}>
                <code>{tool.name}</code>
              </th>
              <td>{tool.tool_class === "write" ? "Write" : "Read"}</td>
              <td className={styles["wide"]}>
                {reasonsForTool(toolkit.via, tool).join(", ") || "\u2014"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
};

const Reach = ({ toolkits }: { readonly toolkits: ReadonlyArray<UsableToolkit> }) => {
  const id = useId();
  const [query, setQuery] = useState("");
  const needle = useDeferredValue(query);
  const shown = filterMyTools(toolkits, needle);

  if (toolkits.length === 0) return <p className={styles["empty"]}>{NO_TOOLS_NOTE}</p>;

  return (
    <>
      <div className={kit["field"]}>
        <label className={kit["fieldLabel"]} htmlFor={id}>
          Find a tool
        </label>
        <input
          id={id}
          className={kit["input"]}
          type="search"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <p className={styles["count"]} role="status">
        {reachText(shown)}
      </p>
      {shown.length === 0 ? (
        <p className={styles["empty"]}>No tool matches &ldquo;{query.trim()}&rdquo;.</p>
      ) : (
        <div className={styles["toolkits"]}>
          {shown.map((toolkit) => (
            <ToolkitReach
              key={toolkit.id}
              toolkit={toolkit}
              open={needle.trim() !== "" || toolkits.length === 1}
            />
          ))}
        </div>
      )}
    </>
  );
};

export const MyToolsPage = () => {
  usePageTitle("My tools");
  const result = useAtomValue(usableToolsAtom);
  const retry = useAtomRefresh(usableToolsAtom);

  return (
    <div className={styles["page"]}>
      <header className={styles["head"]}>
        <h1 className={styles["title"]}>My tools</h1>
        <p className={styles["intro"]}>
          The tools you may use, by toolkit, and what gives you each: a grant to you, to a team you
          are on or to everyone, or your own private credential. A tool that is not listed here is
          not offered to you. Org admins hide tools and set what needs approval on the Tools page.
        </p>
      </header>
      {AsyncResult.match(result, {
        onInitial: () => (
          <p className={kit["muted"]} aria-busy="true">
            Loading your tools…
          </p>
        ),
        onFailure: (failure) => (
          <Problem onRetry={retry}>Could not load your tools. {failureMessage(failure)}</Problem>
        ),
        onSuccess: ({ value }) => <Reach toolkits={value.toolkits} />,
      })}
    </div>
  );
};
