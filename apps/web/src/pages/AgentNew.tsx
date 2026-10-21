// A new agent (/agents/new, #233, ADR 0040): a member creates a private agent (where the org allows them); an org admin
// creates a shared one, which must say who may use it (there is no default grant, so the form will not send one
// without), may name watchers and may set a Spend limit, or a private one of their own. The agent opens on its own page
// afterwards, where its triggers are added.
import { useAtomValue } from "@effect/atom-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { ArrowLeft, Plus } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import {
  AGENT_GRANTS,
  AGENTS,
  createAgentAtom,
  createSpendLimitAtom,
  meAtom,
  SPEND,
  toolkitsAtom,
} from "../api/client.ts";
import { AgentFields } from "../components/AgentFields.tsx";
import { kit, Problem } from "../components/Kit.tsx";
import {
  type AgentDraft,
  createBody,
  type DraftErrors,
  EMPTY_DRAFT,
  hasErrors,
  sandboxCeiling,
  validateDraft,
} from "../lib/agent-form.ts";
import {
  agentProblem,
  agentsCallerOf,
  canCreatePrivate,
  canCreateShared,
  problemField,
} from "../lib/agents.ts";
import { limitProblem, parseDollars } from "../lib/spend.ts";
import { useAction } from "../lib/use-action.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import own from "./Agents.module.css";
import styles from "./Tools.module.css";
import { NotFound } from "./NotFound.tsx";

/** Shared or private, for an org admin who may create either. */
const Whose = ({
  shared,
  onChange,
}: {
  readonly shared: boolean;
  readonly onChange: (shared: boolean) => void;
}) => {
  const id = useId();

  return (
    <fieldset className={styles["choices"]}>
      <legend>Whose agent</legend>
      <label className={styles["choice"]}>
        <input type="radio" name={`${id}-whose`} checked={shared} onChange={() => onChange(true)} />
        <span className={styles["choiceText"]}>
          Shared
          <span className={kit["muted"]}>
            The org&rsquo;s. It reaches what you name here, and those you grant may use it.
          </span>
        </span>
      </label>
      <label className={styles["choice"]}>
        <input
          type="radio"
          name={`${id}-whose`}
          checked={!shared}
          onChange={() => onChange(false)}
        />
        <span className={styles["choiceText"]}>
          Private
          <span className={kit["muted"]}>Yours alone, working within your own reach.</span>
        </span>
      </label>
    </fieldset>
  );
};

const NewAgent = ({
  canShared,
  canPrivate,
}: {
  readonly canShared: boolean;
  readonly canPrivate: boolean;
}) => {
  const create = useAction(createAgentAtom);
  const limit = useAction(createSpendLimitAtom);
  const navigate = useNavigate();
  const toolkits = useAtomValue(toolkitsAtom);
  const [shared, setShared] = useState(canShared);
  const [draft, setDraft] = useState<AgentDraft>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [half, setHalf] = useState<{ readonly id: string; readonly text: string } | undefined>();
  const busy = create.busy || limit.busy;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(undefined);
    setHalf(undefined);

    const found = validateDraft(draft, {
      shared,
      creating: true,
      ceiling: sandboxCeiling(
        AsyncResult.isSuccess(toolkits) ? toolkits.value.toolkits : [],
        draft.sandbox,
      ),
    });

    setErrors(found);

    if (hasErrors(found)) return;

    const outcome = await create.run({
      payload: createBody(draft, shared),
      // A shared agent also writes its grant.
      reactivityKeys: shared ? [...AGENTS, ...AGENT_GRANTS] : AGENTS,
    });

    if (!outcome.ok) {
      const said = agentProblem(outcome.error, outcome.message, outcome.detail);
      const field = problemField(outcome.error, outcome.path);

      if (field === undefined) setProblem(said);
      else setErrors({ [field]: said });

      return;
    }

    const created = outcome.value;
    const micros = shared ? parseDollars(draft.limitAmount) : undefined;

    if (micros !== undefined) {
      const limited = await limit.run({
        payload: {
          kind: "agent",
          subject: created.id,
          period: draft.limitPeriod,
          amount_micros: micros,
        },
        reactivityKeys: SPEND,
      });

      if (!limited.ok) {
        setHalf({
          id: created.id,
          text: `${created.name} was created, but its Spend limit was not set: ${limitProblem(limited.error, limited.message, limited.detail)}`,
        });

        return;
      }
    }

    void navigate({ to: "/agents/$agentId", params: { agentId: created.id } });
  };

  return (
    <form className={own["form"]} onSubmit={(event) => void submit(event)} noValidate>
      {canShared && canPrivate ? <Whose shared={shared} onChange={setShared} /> : null}
      <AgentFields
        draft={draft}
        onChange={setDraft}
        errors={errors}
        shared={shared}
        creating
        disabled={busy}
      />
      {problem === undefined ? null : <Problem>{problem}</Problem>}
      {half === undefined ? null : (
        <Problem>
          {half.text}{" "}
          <Link to="/agents/$agentId" params={{ agentId: half.id }}>
            Open it to set the limit
          </Link>
          .
        </Problem>
      )}
      <div className={styles["actions"]}>
        <button
          type="submit"
          className={kit["primary"]}
          disabled={busy || half !== undefined}
          aria-busy={busy}
        >
          <Plus aria-hidden="true" size={18} strokeWidth={2.25} />
          {busy ? "Creating…" : "Create agent"}
        </button>
        <Link to="/agents" className={kit["secondary"]}>
          Cancel
        </Link>
      </div>
    </form>
  );
};

export const AgentNewPage = () => {
  const me = useAtomValue(meAtom);
  const caller = AsyncResult.isSuccess(me) ? agentsCallerOf(me.value) : undefined;
  const present = AsyncResult.isSuccess(me) ? me.value.deployment.agents : undefined;
  const canShared = caller !== undefined && canCreateShared(caller);
  const canPrivate = caller !== undefined && canCreatePrivate(caller);

  usePageTitle("New agent");

  if (present === false) return <NotFound />;

  return (
    <div className={kit["page"]}>
      <header className={styles["head"]}>
        <Link to="/agents" className={styles["back"]}>
          <ArrowLeft aria-hidden="true" size={16} strokeWidth={2.25} />
          Agents
        </Link>
        <h1 className={styles["title"]}>New agent</h1>
        <p className={styles["intro"]}>
          A model, instructions and the tools it may use. Schedules and webhooks are added on its
          page once it exists.
        </p>
      </header>
      {caller === undefined ? null : canShared || canPrivate ? (
        <NewAgent canShared={canShared} canPrivate={canPrivate} />
      ) : (
        <p className={styles["empty"]}>
          Your org does not let members create private agents. An org admin creates shared agents
          and turns private agents on from the Members page.
        </p>
      )}
    </div>
  );
};
