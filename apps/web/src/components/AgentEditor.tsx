// The editor on an agent's page (#233, ADR 0040): its fields as a form, saved as a patch of what changed, with the
// revision the edit was based on (`409 conflict` if another edit landed first). The tools the form's scope gives with no
// approval rule are counted beside each toolkit when a trigger starts runs unattended (ADR 0044; the notice at the head
// of the page is over the saved agent). Runs read the definition when each turn starts, so an edit reaches an open run at
// its next turn.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { type FormEvent, useState } from "react";
import type { AgentView } from "@commissary/contract/agents";
import { AGENTS, agentsAtom, toolkitsAtom, updateAgentAtom } from "../api/client.ts";
import {
  type AgentDraft,
  type DraftErrors,
  draftOfAgent,
  hasChanges,
  hasErrors,
  sandboxCeiling,
  scopeOfAgentDraft,
  updatePatch,
  validateDraft,
} from "../lib/agent-form.ts";
import { agentProblem, ifMatch, problemField } from "../lib/agents.ts";
import { useAction } from "../lib/use-action.ts";
import { AgentFields } from "./AgentFields.tsx";
import { kit, Problem, Section } from "./Kit.tsx";
import { useUnattended } from "./use-unattended.ts";
import styles from "./AgentEditor.module.css";

export const AgentEditor = ({ agent }: { readonly agent: AgentView }) => {
  const update = useAction(updateAgentAtom);
  const reload = useAtomRefresh(agentsAtom);
  const toolkits = useAtomValue(toolkitsAtom);
  const [draft, setDraft] = useState<AgentDraft>(() => draftOfAgent(agent));
  const [seen, setSeen] = useState(agent.revision);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [problem, setProblem] = useState<{ readonly text: string; readonly stale: boolean }>();
  const [saved, setSaved] = useState(false);
  const [dropped, setDropped] = useState(false);
  const shared = !agent.private;
  const patch = updatePatch(agent, draft);
  const { notice } = useUnattended(agent.id, scopeOfAgentDraft(draft));
  const known = AsyncResult.isSuccess(toolkits) ? toolkits.value.toolkits : [];

  // A saved edit (or another's) is a new revision: read it into the form, and keep the note that it was saved. The form
  // is disabled while it saves, so edits that differ from the new version were made before another's edit landed.
  if (seen !== agent.revision) {
    setSeen(agent.revision);
    setDropped(hasChanges(updatePatch(agent, draft)));
    setDraft(draftOfAgent(agent));
    setErrors({});
    setProblem(undefined);
  }

  const open =
    notice === undefined
      ? undefined
      : new Map(notice.toolkits.map((toolkit) => [toolkit.toolkit, toolkit.tools.length]));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(undefined);
    setSaved(false);
    setDropped(false);

    const found = validateDraft(draft, {
      shared,
      creating: false,
      ceiling: sandboxCeiling(known, draft.sandbox),
    });

    setErrors(found);

    if (hasErrors(found) || !hasChanges(patch)) return;

    const outcome = await update.run({
      params: { id: agent.id },
      headers: ifMatch(agent),
      payload: patch,
      reactivityKeys: AGENTS,
    });

    if (outcome.ok) {
      setSaved(true);

      return;
    }

    const said = agentProblem(outcome.error, outcome.message, outcome.detail);
    const field = problemField(outcome.error, outcome.path);

    if (field === undefined) setProblem({ text: said, stale: outcome.error === "conflict" });
    else setErrors({ [field]: said });
  };

  return (
    <>
      <Section title="Definition" className={styles["section"]}>
        <p className={styles["lead"]}>
          Each turn of a run reads this when it starts, and an edit keeps no history: a run in
          progress picks a change up at its next turn. Disabling the agent stops new runs, and open
          runs end at their next turn.
        </p>
        <form className={styles["form"]} onSubmit={(event) => void submit(event)} noValidate>
          <AgentFields
            draft={draft}
            onChange={(next) => {
              setDraft(next);
              setSaved(false);
              setDropped(false);
            }}
            errors={errors}
            shared={shared}
            creating={false}
            selfId={agent.id}
            uncovered={open}
            disabled={update.busy}
          />
          {problem === undefined ? null : (
            <Problem
              {...(problem.stale
                ? {
                    onRetry: () => {
                      setProblem(undefined);
                      reload();
                    },
                    retryLabel: "Reload the agent",
                  }
                : {})}
            >
              {problem.text}
            </Problem>
          )}
          {dropped ? (
            <p className={kit["muted"]} role="status">
              This agent was changed elsewhere; the form now shows the new version and your unsaved
              edits were dropped.
            </p>
          ) : null}
          <div className={styles["actions"]}>
            <button
              type="submit"
              className={kit["primary"]}
              disabled={update.busy || !hasChanges(patch)}
              aria-busy={update.busy}
            >
              {update.busy ? "Saving…" : "Save"}
            </button>
            {saved ? (
              <span className={styles["note"]} role="status">
                Saved. Open runs pick it up at their next turn.
              </span>
            ) : null}
          </div>
        </form>
      </Section>
    </>
  );
};
