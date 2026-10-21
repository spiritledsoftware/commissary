// The notice on an unattended agent (#233, ADR 0044): a hosted agent with a schedule or webhook trigger that can call
// write tools no approval rule covers. No one is watching when such a run starts, and what it reads (a webhook's body, a
// tool's result) can steer it. One set-apart block on the sunk ground with an ink sentence per fact: no colour, since the
// agent works and nothing has failed (the One Meaning Rule); the toolkit links lead to where approval rules are set.
import { Link } from "@tanstack/react-router";
import { ShieldAlert } from "lucide-react";
import { kindsText, type UnattendedNotice as Notice, writeToolsText } from "../lib/agent-notice.ts";
import styles from "./UnattendedNotice.module.css";

export const UnattendedNotice = ({ notice }: { readonly notice: Notice }) => (
  <aside className={styles["notice"]} aria-label="Runs start unattended">
    <ShieldAlert className={styles["icon"]} aria-hidden="true" size={20} strokeWidth={2.25} />
    <div className={styles["body"]}>
      <h2 className={styles["title"]}>No one is watching when this agent starts</h2>
      <p>
        It has {kindsText(notice.kinds)} trigger and can call write tools that ask no one&rsquo;s
        approval. Content a run reads can steer it, so a steered run could use them with no one
        there to stop it.
      </p>
      <ul className={styles["list"]}>
        {notice.toolkits.map((toolkit) => (
          <li key={toolkit.toolkit}>
            <Link to="/tools/$toolkitId" params={{ toolkitId: toolkit.toolkit }}>
              {toolkit.name}
            </Link>
            : {writeToolsText(toolkit.tools.length)}
          </li>
        ))}
      </ul>
      <p className={styles["fix"]}>
        Put those tools under an approval rule on their toolkit, take them out of the tool scope, or
        remove the trigger, and this notice goes away.
      </p>
    </div>
  </aside>
);
