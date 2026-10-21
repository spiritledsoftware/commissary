// Who may use a shared agent (#233, ADR 0040): its grants, which name a member, a team or everyone. There is no default
// grant, so a shared agent no one is granted is used by no one; adding and removing a grant is one write each, and
// the agent's page shows them as they stand. Org admins only (`/grants/agents`).
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import type { GrantSubject } from "@commissary/contract/grants";
import {
  AGENT_GRANTS,
  AGENTS,
  agentGrantsAtom,
  createAgentGrantAtom,
  removeAgentGrantAtom,
} from "../api/client.ts";
import { subjectOfPick } from "../lib/agent-form.ts";
import { agentProblem, ifMatch } from "../lib/agents.ts";
import { failureMessage } from "../lib/failure.ts";
import { subjectLabel } from "../lib/grants.ts";
import { useAction } from "../lib/use-action.ts";
import { SubjectPicker, useDirectory } from "./AgentShared.tsx";
import { kit, Problem, Section } from "./Kit.tsx";
import parts from "./AgentParts.module.css";
import styles from "./AgentSections.module.css";

const SUBJECT_WORDS: Readonly<Record<GrantSubject["kind"], string>> = {
  team: "Team",
  member: "Member",
  everyone: "Everyone in the org",
};

export const AgentGrants = ({ agent }: { readonly agent: string }) => {
  const result = useAtomValue(agentGrantsAtom);
  const retry = useAtomRefresh(agentGrantsAtom);
  const directory = useDirectory();
  const create = useAction(createAgentGrantAtom);
  const remove = useAction(removeAgentGrantAtom);
  const [kind, setKind] = useState<GrantSubject["kind"] | "">("");
  const [subjectId, setSubjectId] = useState("");
  const [tried, setTried] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const subject = subjectOfPick(kind, subjectId);
  const busy = create.busy || remove.busy;

  const add = async () => {
    setTried(true);
    setProblem(undefined);

    if (subject === undefined) return;

    const outcome = await create.run({
      payload: { subject, agent },
      // A grant decides which shared agents members may use.
      reactivityKeys: [...AGENT_GRANTS, ...AGENTS],
    });

    if (outcome.ok) {
      setKind("");
      setSubjectId("");
      setTried(false);
    } else if (outcome.error === "conflict")
      setProblem("That grant exists already: it is in the list above.");
    else setProblem(agentProblem(outcome.error, outcome.message, outcome.detail));
  };

  return (
    <Section title="Who may use it" className={styles["section"]}>
      <p className={styles["lead"]}>
        A grant lets a member, a team or everyone chat with this agent and start it. What it does is
        its own reach, set above, not the reach of whoever started it. There is no default grant.
      </p>
      {AsyncResult.match(result, {
        onInitial: () => (
          <p className={kit["muted"]} aria-busy="true">
            Loading the grants…
          </p>
        ),
        onFailure: (failure) => (
          <Problem onRetry={retry}>Could not load the grants. {failureMessage(failure)}</Problem>
        ),
        onSuccess: ({ value }) => {
          const grants = value.grants.filter((grant) => grant.agent === agent);

          return grants.length === 0 ? (
            <p className={styles["note"]}>No one may use this agent yet. Add a grant below.</p>
          ) : (
            <ul className={parts["list"]}>
              {grants.map((grant) => {
                const label =
                  directory === undefined
                    ? grant.subject.kind === "everyone"
                      ? "Everyone"
                      : grant.subject.id
                    : subjectLabel(grant.subject, directory);

                return (
                  <li key={grant.id} className={parts["row"]}>
                    <span>
                      {label}
                      <span className={parts["secondary"]}>
                        {SUBJECT_WORDS[grant.subject.kind]}
                      </span>
                    </span>
                    <button
                      type="button"
                      className={parts["linkButton"]}
                      disabled={busy}
                      onClick={async () => {
                        setProblem(undefined);

                        const outcome = await remove.run({
                          params: { id: grant.id },
                          headers: ifMatch(grant),
                          reactivityKeys: [...AGENT_GRANTS, ...AGENTS],
                        });

                        if (!outcome.ok)
                          setProblem(agentProblem(outcome.error, outcome.message, outcome.detail));
                      }}
                    >
                      Remove<span className={kit["visuallyHidden"]}> the grant of {label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          );
        },
      })}
      <form
        className={styles["add"]}
        aria-label="Add a grant"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <SubjectPicker
          directory={directory}
          kind={kind}
          subjectId={subjectId}
          onChange={(nextKind, nextId) => {
            setKind(nextKind);
            setSubjectId(nextId);
          }}
          problem={tried && subject === undefined ? "Choose who may use it." : undefined}
          label="Add a grant"
          hint="Members of a team gain the agent through the team."
        />
        {problem === undefined ? null : <Problem>{problem}</Problem>}
        <button type="submit" className={kit["secondary"]} disabled={busy} aria-busy={create.busy}>
          {create.busy ? "Adding…" : "Add grant"}
        </button>
      </form>
    </Section>
  );
};
