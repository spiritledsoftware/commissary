// The fields of a hosted agent (#233, ADR 0040): name, description and instructions; the model, picked from the models in
// the caller's reach, with a thinking level; the tool scope; the sandbox; for a shared agent, who may use it (when it is
// created), its watchers and an optional Spend limit; and whether it is enabled. Shared by the page that creates an
// agent and the editor on its page. The model of it all is `lib/agent-form.ts`.
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useId, type ReactNode } from "react";
import { meAtom, myModelsAtom, toolkitsAtom, usableAgentsAtom } from "../api/client.ts";
import {
  type AgentDraft,
  type DraftErrors,
  MAX_DESCRIPTION,
  sandboxScopeNote,
  sandboxToolkits,
} from "../lib/agent-form.ts";
import { THINKING_LEVELS, thinkingOf } from "../lib/agents.ts";
import { failureMessage } from "../lib/failure.ts";
import { AgentSandboxEditor } from "./AgentSandboxEditor.tsx";
import { AgentScopeEditor } from "./AgentScopeEditor.tsx";
import { SpendFields, SubjectPicker, useDirectory, WatcherPicker } from "./AgentShared.tsx";
import { kit, Problem } from "./Kit.tsx";
import styles from "./AgentFields.module.css";

/** A labelled input or text area with its hint or problem beneath. */
const Field = ({
  label,
  hint,
  problem,
  children,
}: {
  readonly label: string;
  readonly hint?: string | undefined;
  readonly problem: string | undefined;
  readonly children: (props: {
    readonly id: string;
    readonly "aria-invalid": boolean;
    readonly "aria-describedby": string | undefined;
  }) => ReactNode;
}) => {
  const id = useId();
  const note = problem ?? hint;

  return (
    <div className={kit["field"]}>
      <label className={kit["fieldLabel"]} htmlFor={id}>
        {label}
      </label>
      {children({
        id,
        "aria-invalid": problem !== undefined,
        "aria-describedby": note === undefined ? undefined : `${id}-note`,
      })}
      {note === undefined ? null : (
        <span
          id={`${id}-note`}
          className={problem === undefined ? kit["muted"] : kit["fieldError"]}
          role={problem === undefined ? undefined : "alert"}
        >
          {note}
        </span>
      )}
    </div>
  );
};

export const AgentFields = ({
  draft,
  onChange,
  errors,
  shared,
  creating,
  selfId,
  uncovered,
  disabled,
}: {
  readonly draft: AgentDraft;
  readonly onChange: (draft: AgentDraft) => void;
  readonly errors: DraftErrors;
  /** A shared agent: grants, watchers and a Spend limit besides. */
  readonly shared: boolean;
  /** Creating the agent, not editing it. */
  readonly creating: boolean;
  /** The agent's own id when editing, so it is not offered to itself. */
  readonly selfId?: string | undefined;
  /** Write tools with no approval rule, by toolkit id, while the notice on an unattended agent shows. */
  readonly uncovered?: ReadonlyMap<string, number> | undefined;
  readonly disabled: boolean;
}) => {
  const toolkits = useAtomValue(toolkitsAtom);
  const models = useAtomValue(myModelsAtom);
  const usable = useAtomValue(usableAgentsAtom);
  const me = useAtomValue(meAtom);
  const directory = useDirectory();
  const modelList = useId();
  const patch = (change: Partial<AgentDraft>) => onChange({ ...draft, ...change });

  const named = AsyncResult.isSuccess(toolkits)
    ? toolkits.value.toolkits.filter(
        (toolkit) => toolkit.shadowed !== true && (!shared || !toolkit.private),
      )
    : undefined;

  const agents = AsyncResult.isSuccess(usable)
    ? usable.value.agents.filter((agent) => agent.id !== selfId && (!shared || !agent.private))
    : [];

  const sandboxes = named === undefined ? [] : sandboxToolkits(named);

  return (
    <div className={styles["fields"]}>
      <Field
        label="Name"
        hint="Lowercase letters, digits and underscores. Other agents and clients call it by this name."
        problem={errors.name}
      >
        {(props) => (
          <input
            {...props}
            className={kit["input"]}
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            value={draft.name}
            onChange={(event) => patch({ name: event.target.value })}
          />
        )}
      </Field>
      <Field
        label="Description"
        hint={`What it is for: the agents toolkit lists it for whoever may use it. At most ${MAX_DESCRIPTION.toLocaleString("en")} characters.`}
        problem={errors.description}
      >
        {(props) => (
          <textarea
            {...props}
            className={styles["textarea"]}
            rows={2}
            disabled={disabled}
            value={draft.description}
            onChange={(event) => patch({ description: event.target.value })}
          />
        )}
      </Field>
      <Field
        label="Instructions"
        hint="What the agent is told at the start of every turn."
        problem={errors.instructions}
      >
        {(props) => (
          <textarea
            {...props}
            className={`${styles["textarea"]} ${styles["tall"]}`}
            rows={10}
            disabled={disabled}
            value={draft.instructions}
            onChange={(event) => patch({ instructions: event.target.value })}
          />
        )}
      </Field>
      <div className={styles["pair"]}>
        <Field
          label="Model"
          hint={
            AsyncResult.isSuccess(models)
              ? shared
                ? "As clients send it. The org's shared credentials must serve it."
                : "As clients send it, from the models you may use."
              : undefined
          }
          problem={errors.model}
        >
          {(props) => (
            <>
              <input
                {...props}
                className={kit["input"]}
                list={modelList}
                autoComplete="off"
                spellCheck={false}
                disabled={disabled}
                value={draft.model}
                onChange={(event) => patch({ model: event.target.value })}
              />
              <datalist id={modelList}>
                {AsyncResult.isSuccess(models)
                  ? models.value.models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.display_name ?? model.owned_by}
                      </option>
                    ))
                  : null}
              </datalist>
            </>
          )}
        </Field>
        <Field label="Thinking" problem={undefined}>
          {(props) => (
            <select
              {...props}
              className={kit["input"]}
              disabled={disabled}
              value={draft.thinking}
              onChange={(event) => patch({ thinking: thinkingOf(event.target.value) ?? "" })}
            >
              <option value="">Model's default</option>
              {THINKING_LEVELS.map((level) => (
                <option key={level.id} value={level.id}>
                  {level.label}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      {AsyncResult.isFailure(models) ? (
        <p className={kit["muted"]}>
          Could not list the models in reach, so type the model&rsquo;s name.{" "}
          {failureMessage(models)}
        </p>
      ) : null}
      {named === undefined ? (
        AsyncResult.isFailure(toolkits) ? (
          <Problem>Could not load the toolkits. {failureMessage(toolkits)}</Problem>
        ) : (
          <p className={kit["muted"]} aria-busy="true">
            Loading the toolkits…
          </p>
        )
      ) : (
        <>
          <div className={styles["wide"]}>
            <AgentScopeEditor
              toolkits={named}
              draft={draft.scope}
              onChange={(scope) => patch({ scope })}
              agents={draft.agents}
              onAgentsChange={(next) => patch({ agents: next })}
              usableAgents={agents}
              uncovered={uncovered}
              disabled={disabled}
              invalid={errors.scope !== undefined}
            />
            <p
              className={errors.scope === undefined ? kit["muted"] : kit["fieldError"]}
              role={errors.scope === undefined ? undefined : "alert"}
            >
              {errors.scope ??
                (shared
                  ? "A shared agent reaches exactly what is named here, through the org's shared credentials: it is not the reach of whoever starts it."
                  : "A private agent works within your own reach: the tools you may use, narrowed to what is named here.")}
            </p>
          </div>
          <AgentSandboxEditor
            toolkits={sandboxes}
            draft={draft.sandbox}
            onChange={(sandbox) => patch({ sandbox })}
            problem={errors.sandbox}
            scopeNote={sandboxScopeNote(draft)}
            computerAvailable={AsyncResult.isSuccess(me) && me.value.deployment.computer}
            disabled={disabled}
          />
        </>
      )}
      {shared ? (
        <>
          {creating ? (
            <SubjectPicker
              directory={directory}
              kind={draft.subjectKind}
              subjectId={draft.subjectId}
              onChange={(subjectKind, subjectId) => patch({ subjectKind, subjectId })}
              problem={errors.subject}
            />
          ) : null}
          <WatcherPicker
            directory={directory}
            watchers={draft.watchers}
            creatorWatches={creating && AsyncResult.isSuccess(me) && me.value.role !== null}
            onChange={(watchers) => patch({ watchers })}
          />
          {creating ? (
            <SpendFields
              amount={draft.limitAmount}
              period={draft.limitPeriod}
              onChange={(limitAmount, limitPeriod) => patch({ limitAmount, limitPeriod })}
              problem={errors.limit}
            />
          ) : null}
        </>
      ) : null}
      {creating ? null : (
        <label className={styles["check"]}>
          <input
            type="checkbox"
            checked={draft.enabled}
            disabled={disabled}
            onChange={(event) => patch({ enabled: event.target.checked })}
          />
          <span className={styles["checkText"]}>
            Enabled
            <span className={kit["muted"]}>
              Disabled, it starts no new runs, and its open runs end at their next turn.
            </span>
          </span>
        </label>
      )}
    </div>
  );
};
