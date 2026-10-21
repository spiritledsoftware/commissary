// The connect page (/tools/$toolkitId/connect, #208, ADR 0038): where a tool call that needs the caller's own
// credential sends them (the MCP endpoint's error names this link). It connects their private credential to the
// toolkit, or signs it in, then says to retry the call in the client. When the toolkit or the org takes no private
// credential, it says why and who can help.
import { getRouteApi, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import type { ToolkitView } from "@commissary/contract/tools";
import { connectPageOf, controlsFor, RETRY_TEXT, type ToolsCaller } from "../lib/toolkits.ts";
import { kit } from "../components/Kit.tsx";
import { usePageTitle } from "../lib/use-page-title.ts";
import { WithToolkit } from "./Toolkit.tsx";
import { CredentialSlotBlock } from "./ToolkitCredential.tsx";
import styles from "./Tools.module.css";

const route = getRouteApi("/tools/$toolkitId/connect");

const Connect = ({
  toolkit,
  caller,
}: {
  readonly toolkit: ToolkitView;
  readonly caller: ToolsCaller;
}) => {
  const page = connectPageOf(toolkit, caller);
  const [connected, setConnected] = useState(false);

  if (page.kind === "refused") return <p className={styles["empty"]}>{page.reason}</p>;

  return (
    <>
      <CredentialSlotBlock
        toolkit={toolkit}
        slot="private"
        manage={controlsFor(toolkit, caller).manage}
        onConnected={() => setConnected(true)}
      />
      {connected ? (
        <p className={styles["note"]} role="status">
          {RETRY_TEXT}
        </p>
      ) : null}
      <p className={styles["hint"]}>
        Manage it later on{" "}
        <Link to="/tools/$toolkitId" params={{ toolkitId: toolkit.id }}>
          {toolkit.name}&rsquo;s page
        </Link>
        .
      </p>
    </>
  );
};

export const ToolkitConnectPage = () => {
  const { toolkitId } = route.useParams();

  usePageTitle("Connect a toolkit");

  return (
    <div className={kit["page"]}>
      <header className={styles["head"]}>
        <Link to="/tools" className={styles["back"]}>
          <ArrowLeft aria-hidden="true" size={16} strokeWidth={2.25} />
          Tools
        </Link>
        <h1 className={styles["title"]}>Connect your private credential</h1>
        <p className={styles["intro"]}>
          A tool call needs your private credential for this toolkit: it calls the service as you.
          Connect it here; Commissary keeps it sealed, and only your calls use it.
        </p>
      </header>
      <WithToolkit id={toolkitId}>
        {(toolkit, caller) => <Connect toolkit={toolkit} caller={caller} />}
      </WithToolkit>
    </div>
  );
};
