// The triggers on an agent's page (#233, ADR 0040, #231): chat and MCP shown as always on; the schedules and webhooks the
// agent's manager configured, one row each with when it runs (a schedule in words, its zone and its next run) or its URL,
// and add, edit, enable, disable, remove, and for a webhook rotate its secret, which is shown once when it is created or
// rotated and never again. The model is `lib/agent-triggers.ts`.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Plus } from "lucide-react";
import { Fragment, useState } from "react";
import type { TriggerView } from "@commissary/contract/agent-triggers";
import {
  AGENT_TRIGGERS,
  agentTriggersAtom,
  createTriggerAtom,
  removeTriggerAtom,
  rotateTriggerSecretAtom,
  updateTriggerAtom,
} from "../api/client.ts";
import {
  ALWAYS_ON,
  createTriggerBody,
  emptyTrigger,
  hasTriggerChanges,
  hasTriggerErrors,
  localZone,
  nextText,
  scheduleText,
  sortTriggers,
  TRIGGER_KINDS,
  type TriggerDraft,
  type TriggerErrors,
  type TriggerKindChoice,
  revealOf,
  type Reveal,
  triggerProblemOf,
  updateTriggerPatch,
  validateTrigger,
  WEBHOOK_PROOFS,
  draftOfTrigger,
} from "../lib/agent-triggers.ts";
import { ifMatch } from "../lib/agents.ts";
import { failureMessage } from "../lib/failure.ts";
import { useAction } from "../lib/use-action.ts";
import { AgentTriggerForm } from "./AgentTriggerForm.tsx";
import { type ConfirmRequest, ConfirmDialog } from "./Confirm.tsx";
import { CopyValue } from "./CopyValue.tsx";
import { kit, Problem, Section } from "./Kit.tsx";
import parts from "./AgentParts.module.css";
import styles from "./AgentTriggers.module.css";

const SecretNotice = ({
  reveal,
  onDone,
}: {
  readonly reveal: Reveal;
  readonly onDone: () => void;
}) => (
  <div className={styles["secret"]} role="status">
    <h3 className={styles["secretTitle"]}>
      {reveal.rotated ? "New secret for" : "Secret for"} {reveal.name}
    </h3>
    <p>
      Copy it now: it is shown this once and cannot be read again.
      {reveal.rotated ? " The old secret has stopped working." : ""}
    </p>
    <CopyValue label="Webhook URL" value={reveal.url} />
    <CopyValue label="Secret" value={reveal.secret} />
    <dl className={styles["proofs"]}>
      {WEBHOOK_PROOFS.map((proof) => (
        <Fragment key={proof.name}>
          <dt>{proof.name}</dt>
          <dd>
            <code>{proof.text}</code>
          </dd>
        </Fragment>
      ))}
    </dl>
    <p className={kit["muted"]}>
      POST the body to the URL. Naming a delivery in <code>X-Commissary-Delivery</code> makes a
      resent request start no second run.
    </p>
    <button type="button" className={kit["secondary"]} onClick={onDone}>
      I have copied it
    </button>
  </div>
);

/** The form of a new trigger, opened by the add buttons. */
const AddTrigger = ({
  agent,
  kind,
  onDone,
  onSecret,
}: {
  readonly agent: string;
  readonly kind: TriggerKindChoice;
  readonly onDone: () => void;
  readonly onSecret: (reveal: Reveal) => void;
}) => {
  const create = useAction(createTriggerAtom);
  const [draft, setDraft] = useState<TriggerDraft>(() => emptyTrigger(kind, localZone()));
  const [errors, setErrors] = useState<TriggerErrors>({});
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const submit = async () => {
    setProblem(undefined);
    const found = validateTrigger(draft);

    setErrors(found);

    if (hasTriggerErrors(found)) return;

    const outcome = await create.run({ agent, payload: createTriggerBody(draft) });

    if (!outcome.ok) {
      setProblem(triggerProblemOf(outcome));

      return;
    }

    const revealed = revealOf(outcome.value, false);

    if (revealed !== undefined) onSecret(revealed);

    onDone();
  };

  return (
    <form
      className={styles["add"]}
      aria-label={kind === "schedule" ? "Add a schedule" : "Add a webhook"}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h3 className={styles["formTitle"]}>
        {kind === "schedule" ? "New schedule" : "New webhook"}
      </h3>
      <AgentTriggerForm
        draft={draft}
        onChange={setDraft}
        errors={errors}
        editing={false}
        disabled={create.busy}
      />
      {problem === undefined ? null : <Problem>{problem}</Problem>}
      <div className={styles["actions"]}>
        <button
          type="submit"
          className={kit["primary"]}
          disabled={create.busy}
          aria-busy={create.busy}
        >
          <Plus aria-hidden="true" size={18} strokeWidth={2.25} />
          {create.busy ? "Adding…" : kind === "schedule" ? "Add schedule" : "Add webhook"}
        </button>
        <button type="button" className={kit["secondary"]} onClick={onDone} disabled={create.busy}>
          Cancel
        </button>
      </div>
    </form>
  );
};

/** The form of one trigger's edit, in the row under it. */
const EditTrigger = ({
  agent,
  trigger,
  onDone,
}: {
  readonly agent: string;
  readonly trigger: TriggerView;
  readonly onDone: () => void;
}) => {
  const update = useAction(updateTriggerAtom);
  const [draft, setDraft] = useState<TriggerDraft>(() => draftOfTrigger(trigger));
  const [errors, setErrors] = useState<TriggerErrors>({});
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const patch = updateTriggerPatch(trigger, draft);

  const submit = async () => {
    setProblem(undefined);
    const found = validateTrigger(draft);

    setErrors(found);

    if (hasTriggerErrors(found) || !hasTriggerChanges(patch)) return;

    const outcome = await update.run({
      params: { id: agent, trigger: trigger.id },
      headers: ifMatch(trigger),
      payload: patch,
      reactivityKeys: AGENT_TRIGGERS,
    });

    if (outcome.ok) onDone();
    else setProblem(triggerProblemOf(outcome));
  };

  return (
    <form
      className={styles["edit"]}
      aria-label={`Edit ${trigger.name}`}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <AgentTriggerForm
        draft={draft}
        onChange={setDraft}
        errors={errors}
        editing
        disabled={update.busy}
      />
      {problem === undefined ? null : <Problem>{problem}</Problem>}
      <div className={styles["actions"]}>
        <button
          type="submit"
          className={kit["primary"]}
          disabled={update.busy || !hasTriggerChanges(patch)}
          aria-busy={update.busy}
        >
          {update.busy ? "Saving…" : "Save"}
        </button>
        <button type="button" className={kit["secondary"]} onClick={onDone} disabled={update.busy}>
          Cancel
        </button>
      </div>
    </form>
  );
};

const Row = ({
  agent,
  agentEnabled,
  trigger,
  open,
  busy,
  onEdit,
  onToggle,
  onRotate,
  onRemove,
}: {
  readonly agent: string;
  readonly agentEnabled: boolean;
  readonly trigger: TriggerView;
  readonly open: boolean;
  readonly busy: boolean;
  readonly onEdit: () => void;
  readonly onToggle: () => void;
  readonly onRotate: () => void;
  readonly onRemove: () => void;
}) => (
  <>
    <tr data-open={open}>
      <td>
        <div className={styles["name"]}>
          <span>{trigger.name}</span>
          <span className={parts["secondary"]}>
            {trigger.kind === "schedule" ? "Schedule" : "Webhook"}
          </span>
        </div>
      </td>
      <td>
        {trigger.kind === "schedule" && trigger.schedule !== undefined ? (
          <div className={styles["lines"]}>
            <span>{scheduleText(trigger.schedule)}</span>
            <span className={parts["secondary"]}>{nextText(trigger, agentEnabled)}</span>
          </div>
        ) : (
          <div className={styles["lines"]}>
            <span className={styles["url"]}>{trigger.webhook?.url}</span>
            <span className={parts["secondary"]}>
              {trigger.input === undefined
                ? "The body alone is the input"
                : "With an input template"}
            </span>
          </div>
        )}
      </td>
      <td className={styles["state"]}>{trigger.enabled ? "On" : "Off"}</td>
      <td>
        <div className={styles["rowActions"]}>
          <button type="button" className={parts["linkButton"]} disabled={busy} onClick={onEdit}>
            {open ? "Close" : "Edit"}
            <span className={kit["visuallyHidden"]}> {trigger.name}</span>
          </button>
          <button type="button" className={parts["linkButton"]} disabled={busy} onClick={onToggle}>
            {trigger.enabled ? "Disable" : "Enable"}
            <span className={kit["visuallyHidden"]}> {trigger.name}</span>
          </button>
          {trigger.kind === "webhook" ? (
            <button
              type="button"
              className={parts["linkButton"]}
              disabled={busy}
              onClick={onRotate}
            >
              Rotate secret
              <span className={kit["visuallyHidden"]}> of {trigger.name}</span>
            </button>
          ) : null}
          <button type="button" className={parts["linkButton"]} disabled={busy} onClick={onRemove}>
            Remove<span className={kit["visuallyHidden"]}> {trigger.name}</span>
          </button>
        </div>
      </td>
    </tr>
    {open ? (
      <tr className={styles["editRow"]}>
        <td colSpan={4}>
          <EditTrigger agent={agent} trigger={trigger} onDone={onEdit} />
        </td>
      </tr>
    ) : null}
  </>
);

export const AgentTriggers = ({
  agent,
  agentEnabled,
}: {
  readonly agent: string;
  readonly agentEnabled: boolean;
}) => {
  const result = useAtomValue(agentTriggersAtom(agent));
  const retry = useAtomRefresh(agentTriggersAtom(agent));
  const update = useAction(updateTriggerAtom);
  const remove = useAction(removeTriggerAtom);
  const rotate = useAction(rotateTriggerSecretAtom);
  const [adding, setAdding] = useState<TriggerKindChoice | undefined>(undefined);
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [reveal, setReveal] = useState<Reveal | undefined>(undefined);
  const [request, setRequest] = useState<ConfirmRequest | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const busy = update.busy || remove.busy || rotate.busy;

  const toggle = async (trigger: TriggerView) => {
    setProblem(undefined);

    const outcome = await update.run({
      params: { id: agent, trigger: trigger.id },
      headers: ifMatch(trigger),
      payload: { enabled: !trigger.enabled },
      reactivityKeys: AGENT_TRIGGERS,
    });

    if (!outcome.ok) setProblem(triggerProblemOf(outcome));
  };

  const ask = (trigger: TriggerView, what: "remove" | "rotate") =>
    setRequest(
      what === "remove"
        ? {
            title: `Remove ${trigger.name}?`,
            body: (
              <p>
                {trigger.kind === "webhook"
                  ? "Its URL stops working at once, and a service still calling it is answered as if it never existed."
                  : "It starts no more runs."}{" "}
                Runs it already started are kept.
              </p>
            ),
            action: "Remove",
            busyAction: "Removing…",
            run: async () => {
              setProblem(undefined);

              const outcome = await remove.run({
                params: { id: agent, trigger: trigger.id },
                headers: ifMatch(trigger),
                reactivityKeys: AGENT_TRIGGERS,
              });

              if (!outcome.ok) setProblem(triggerProblemOf(outcome));
            },
          }
        : {
            title: `Rotate the secret of ${trigger.name}?`,
            body: (
              <p>
                It gets a new secret, shown once. The old one stops working at once, so whatever
                calls this webhook needs the new one.
              </p>
            ),
            action: "Rotate secret",
            busyAction: "Rotating…",
            tone: "primary",
            keep: "Keep it",
            run: async () => {
              setProblem(undefined);

              const outcome = await rotate.run({
                params: { id: agent, trigger: trigger.id },
                headers: ifMatch(trigger),
                reactivityKeys: AGENT_TRIGGERS,
              });

              if (!outcome.ok) {
                setProblem(triggerProblemOf(outcome));

                return;
              }

              setReveal(revealOf(outcome.value, true));
            },
          },
    );

  return (
    <Section
      title="Triggers"
      className={styles["section"]}
      aside={
        <span className={styles["adds"]}>
          {TRIGGER_KINDS.map((kind) => (
            <button
              key={kind.id}
              type="button"
              className={kit["secondary"]}
              disabled={adding === kind.id}
              onClick={() => setAdding(kind.id)}
            >
              <Plus aria-hidden="true" size={16} strokeWidth={2.25} />
              {kind.label}
            </button>
          ))}
        </span>
      }
    >
      <p className={styles["lead"]}>
        A trigger starts a run of this agent, and every trigger starts a new one. Chat and MCP are
        always on for whoever may use it; schedules and webhooks start runs no one is there for.
      </p>
      {reveal === undefined ? null : (
        <SecretNotice reveal={reveal} onDone={() => setReveal(undefined)} />
      )}
      {problem === undefined ? null : <Problem>{problem}</Problem>}
      {AsyncResult.match(result, {
        onInitial: () => (
          <p className={kit["muted"]} aria-busy="true">
            Loading the triggers…
          </p>
        ),
        onFailure: (failure) => (
          <Problem onRetry={retry}>Could not load the triggers. {failureMessage(failure)}</Problem>
        ),
        onSuccess: ({ value }) => (
          <div className={styles["scroll"]}>
            <table className={styles["table"]}>
              <thead>
                <tr>
                  <th scope="col">Trigger</th>
                  <th scope="col">Starts a run</th>
                  <th scope="col">State</th>
                  <th scope="col">
                    <span className={kit["visuallyHidden"]}>Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {ALWAYS_ON.map((always) => (
                  <tr key={always.id}>
                    <td>
                      <div className={styles["name"]}>
                        <span>{always.name}</span>
                        <span className={parts["secondary"]}>Always on</span>
                      </div>
                    </td>
                    <td>{always.text}</td>
                    <td className={styles["state"]}>On</td>
                    <td />
                  </tr>
                ))}
                {sortTriggers(value.triggers).map((trigger) => (
                  <Row
                    key={trigger.id}
                    agent={agent}
                    agentEnabled={agentEnabled}
                    trigger={trigger}
                    open={editing === trigger.id}
                    busy={busy}
                    onEdit={() => setEditing(editing === trigger.id ? undefined : trigger.id)}
                    onToggle={() => void toggle(trigger)}
                    onRotate={() => ask(trigger, "rotate")}
                    onRemove={() => ask(trigger, "remove")}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ),
      })}
      {adding === undefined ? null : (
        <AddTrigger
          key={adding}
          agent={agent}
          kind={adding}
          onDone={() => setAdding(undefined)}
          onSecret={setReveal}
        />
      )}
      <ConfirmDialog request={request} busy={busy} onClose={() => setRequest(undefined)} />
    </Section>
  );
};
