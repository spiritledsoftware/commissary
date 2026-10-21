// What the notice on an unattended agent (#233, ADR 0044) needs, read for one agent and one tool scope: the agent's
// enabled schedule and webhook triggers, the toolkits as the caller sees them and the tool lists of the scope's toolkits
// (read only while a trigger starts runs unattended, as that is when the notice needs them). The page-level notice reads it
// for the saved scope; the editor, for the scope its form says, to count the tools beside each toolkit.
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import type { ToolScope } from "@commissary/contract/api-keys";
import { agentTriggersAtom, toolkitsAtom, toolListsAtom } from "../api/client.ts";
import {
  startsUnattended,
  uncoveredWrites,
  unattendedNotice,
  type UnattendedNotice,
} from "../lib/agent-notice.ts";

export interface Unattended {
  readonly notice: UnattendedNotice | undefined;
  /** The names of the scope's toolkits whose tool lists could not be read, so their write tools are unchecked. */
  readonly unchecked: ReadonlyArray<string>;
}

export const useUnattended = (agent: string, scope: ToolScope): Unattended => {
  const toolkits = useAtomValue(toolkitsAtom);
  const triggers = useAtomValue(agentTriggersAtom(agent));
  const triggerList = AsyncResult.isSuccess(triggers) ? triggers.value.triggers : [];
  const unattended = triggerList.some(startsUnattended);

  const { lists, failed } = useAtomValue(
    toolListsAtom(
      unattended ? [...new Set(scope.map((entry) => entry.toolkit))].toSorted().join(",") : "",
    ),
  );

  const known = AsyncResult.isSuccess(toolkits) ? toolkits.value.toolkits : [];

  return {
    notice: unattendedNotice(
      triggerList,
      uncoveredWrites(scope, known, (id) => lists[id]),
    ),
    unchecked: failed.map((id) => known.find((toolkit) => toolkit.id === id)?.name ?? id),
  };
};
