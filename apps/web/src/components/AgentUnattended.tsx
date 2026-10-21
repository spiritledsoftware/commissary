// The unattended notice at the head of an agent's page (#233, ADR 0044), over its saved definition: it says what the
// agent can do now, so it does not move while the form is edited (the form's own count beside each toolkit does). A
// toolkit whose tool list could not be read is said, as its write tools are then unchecked.
import type { AgentView } from "@commissary/contract/agents";
import { kit } from "./Kit.tsx";
import { UnattendedNotice } from "./UnattendedNotice.tsx";
import { useUnattended } from "./use-unattended.ts";

export const AgentUnattended = ({ agent }: { readonly agent: AgentView }) => {
  const { notice, unchecked } = useUnattended(agent.id, agent.tool_scope);

  return (
    <>
      {notice === undefined ? null : <UnattendedNotice notice={notice} />}
      {unchecked.map((name) => (
        <p key={name} className={kit["muted"]}>
          Could not check {name}&rsquo;s tools for approval rules.
        </p>
      ))}
    </>
  );
};
