// A trigger's form (#233, ADR 0040, #231): a schedule's name, cron expression (with a readable preview and its next runs
// in the schedule's own time zone), time zone and fixed input; or a webhook's name and input template. Adding a trigger and
// editing one share it. The model is `lib/agent-triggers.ts`.
import { useId, useMemo } from "react";
import {
  CRON_PRESETS,
  describeCron,
  nextRuns,
  readSchedule,
  runText,
  type TriggerDraft,
  type TriggerErrors,
  WEBHOOK_BODY_PLACEHOLDER,
} from "../lib/agent-triggers.ts";
import { knownZones } from "../lib/spend.ts";
import { kit } from "./Kit.tsx";
import styles from "./AgentTriggerForm.module.css";

const PREVIEW_RUNS = 3;

/** The readable preview of a schedule: what the expression says, and when it runs next in its zone. */
const Preview = ({ cron, timeZone }: { readonly cron: string; readonly timeZone: string }) => {
  const read = useMemo(() => readSchedule(cron, timeZone), [cron, timeZone]);

  if (!read.ok) return null;

  const runs = nextRuns(read.cron, Date.now(), PREVIEW_RUNS);

  return (
    <div className={styles["preview"]} role="status">
      <p className={styles["said"]}>{describeCron(cron) ?? "A custom schedule"}</p>
      <p className={kit["muted"]}>
        {runs.length === 0
          ? "No run is left."
          : `Next: ${runs.map((run) => runText(run, timeZone.trim())).join(" · ")} (${timeZone.trim()})`}
      </p>
    </div>
  );
};

export const AgentTriggerForm = ({
  draft,
  onChange,
  errors,
  editing,
  disabled,
}: {
  readonly draft: TriggerDraft;
  readonly onChange: (draft: TriggerDraft) => void;
  readonly errors: TriggerErrors;
  /** Editing a trigger, not adding one: it can be enabled or disabled here. */
  readonly editing: boolean;
  readonly disabled: boolean;
}) => {
  const id = useId();
  const zones = useMemo(() => knownZones(), []);
  const patch = (change: Partial<TriggerDraft>) => onChange({ ...draft, ...change });
  const preset = CRON_PRESETS.find((each) => each.cron === draft.cron.trim());

  return (
    <div className={styles["form"]}>
      <div className={kit["field"]}>
        <label className={kit["fieldLabel"]} htmlFor={`${id}-name`}>
          Name
        </label>
        <input
          id={`${id}-name`}
          className={kit["input"]}
          autoComplete="off"
          disabled={disabled}
          aria-invalid={errors.name !== undefined}
          aria-describedby={errors.name === undefined ? undefined : `${id}-name-problem`}
          value={draft.name}
          onChange={(event) => patch({ name: event.target.value })}
        />
        {errors.name === undefined ? null : (
          <span id={`${id}-name-problem`} className={kit["fieldError"]} role="alert">
            {errors.name}
          </span>
        )}
      </div>
      {draft.kind === "schedule" ? (
        <>
          <div className={kit["field"]}>
            <label className={kit["fieldLabel"]} htmlFor={`${id}-preset`}>
              Runs
            </label>
            <select
              id={`${id}-preset`}
              className={kit["input"]}
              disabled={disabled}
              value={preset?.cron ?? ""}
              onChange={(event) => {
                if (event.target.value !== "") patch({ cron: event.target.value });
              }}
            >
              <option value="">Custom expression</option>
              {CRON_PRESETS.map((each) => (
                <option key={each.cron} value={each.cron}>
                  {each.label}
                </option>
              ))}
            </select>
          </div>
          <div className={styles["pair"]}>
            <div className={kit["field"]}>
              <label className={kit["fieldLabel"]} htmlFor={`${id}-cron`}>
                Cron expression
              </label>
              <input
                id={`${id}-cron`}
                className={`${kit["input"]} ${styles["mono"]}`}
                autoComplete="off"
                spellCheck={false}
                disabled={disabled}
                aria-invalid={errors.cron !== undefined}
                aria-describedby={`${id}-cron-note`}
                value={draft.cron}
                onChange={(event) => patch({ cron: event.target.value })}
              />
              <span
                id={`${id}-cron-note`}
                className={errors.cron === undefined ? kit["muted"] : kit["fieldError"]}
                role={errors.cron === undefined ? undefined : "alert"}
              >
                {errors.cron ?? "Minute, hour, day of month, month, day of week."}
              </span>
            </div>
            <div className={kit["field"]}>
              <label className={kit["fieldLabel"]} htmlFor={`${id}-zone`}>
                Time zone
              </label>
              <input
                id={`${id}-zone`}
                className={kit["input"]}
                list={`${id}-zones`}
                autoComplete="off"
                spellCheck={false}
                disabled={disabled}
                aria-invalid={errors.timeZone !== undefined}
                aria-describedby={errors.timeZone === undefined ? undefined : `${id}-zone-problem`}
                value={draft.timeZone}
                onChange={(event) => patch({ timeZone: event.target.value })}
              />
              <datalist id={`${id}-zones`}>
                {zones.map((zone) => (
                  <option key={zone} value={zone} />
                ))}
              </datalist>
              {errors.timeZone === undefined ? null : (
                <span id={`${id}-zone-problem`} className={kit["fieldError"]} role="alert">
                  {errors.timeZone}
                </span>
              )}
            </div>
          </div>
          <Preview cron={draft.cron} timeZone={draft.timeZone} />
        </>
      ) : null}
      <div className={kit["field"]}>
        <label className={kit["fieldLabel"]} htmlFor={`${id}-input`}>
          {draft.kind === "schedule" ? "Input" : "Input template (optional)"}
        </label>
        <textarea
          id={`${id}-input`}
          className={styles["textarea"]}
          rows={draft.kind === "schedule" ? 3 : 4}
          spellCheck={false}
          disabled={disabled}
          aria-invalid={errors.input !== undefined}
          aria-describedby={`${id}-input-note`}
          value={draft.input}
          onChange={(event) => patch({ input: event.target.value })}
        />
        <span
          id={`${id}-input-note`}
          className={errors.input === undefined ? kit["muted"] : kit["fieldError"]}
          role={errors.input === undefined ? undefined : "alert"}
        >
          {errors.input ??
            (draft.kind === "schedule"
              ? "What each run starts with. The same every time."
              : `${WEBHOOK_BODY_PLACEHOLDER} is replaced by the request's body. Empty: the body alone is the input.`)}
        </span>
      </div>
      {editing ? (
        <label className={styles["check"]}>
          <input
            type="checkbox"
            checked={draft.enabled}
            disabled={disabled}
            onChange={(event) => patch({ enabled: event.target.checked })}
          />
          Enabled
        </label>
      ) : null}
    </div>
  );
};
