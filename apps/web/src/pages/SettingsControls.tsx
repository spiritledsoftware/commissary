// One setting on the Settings page: the control its kind calls for (checkbox, radio list, number, duration, text,
// one-per-line list, or a radio list with a text field), its hint, its error, and beside it "Reset to default" when it
// differs from the default (nothing when it does not). A setting that applies only while another is on sits indented
// under it and says so (`requires`). The control's id is `fieldId(path)`, so a server problem about the field can
// focus it.
import type { ReactNode } from "react";
import { kit } from "../components/Kit.tsx";
import {
  type Choice,
  durationReading,
  type FieldSpec,
  fieldId,
  type Input,
} from "../lib/settings.ts";
import { copyOf, type FieldCopy } from "./SettingsCopy.ts";
import styles from "./Settings.module.css";

export interface FieldProps {
  readonly spec: FieldSpec;
  readonly input: Input;
  readonly error: string | undefined;
  readonly isDefault: boolean;
  readonly disabled?: boolean;
  /** More text after the hint (a link, a count). */
  readonly extra?: ReactNode;
  /** The setting this one depends on, said as when it applies ("Only while sessions are kept."). */
  readonly requires?: string;
  readonly onChange: (input: Input) => void;
  readonly onReset: () => void;
}

const describedBy = (...ids: ReadonlyArray<string | false | undefined>): string | undefined => {
  const present = ids.filter((id): id is string => typeof id === "string");

  return present.length === 0 ? undefined : present.join(" ");
};

const textOf = (input: Input): string => (typeof input === "string" ? input : "");

const choiceOf = (input: Input): Choice =>
  typeof input === "object" ? input : { choice: "", text: "" };

const Reset = ({
  label,
  disabled,
  onReset,
}: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onReset: () => void;
}) => (
  <div className={styles["meta"]}>
    <button
      type="button"
      className={styles["reset"]}
      disabled={disabled}
      aria-label={`Reset “${label}” to default`}
      onClick={onReset}
    >
      Reset to default
    </button>
  </div>
);

/** The ids that describe a control: its reading, hint, dependency and error, as present. */
const notesIds = (
  id: string,
  copy: FieldCopy,
  props: {
    readonly error: string | undefined;
    readonly extra?: ReactNode;
    readonly requires?: string | undefined;
  },
  reading?: string,
): string | undefined =>
  describedBy(
    reading !== undefined && `${id}-reading`,
    (copy.hint !== undefined || props.extra !== undefined) && `${id}-hint`,
    props.requires !== undefined && `${id}-requires`,
    props.error !== undefined && `${id}-error`,
  );

/** The live reading, hint, dependency and error under a control (ids `<id>-reading`, `-hint`, `-requires`, `-error`). */
const Notes = ({
  id,
  copy,
  reading,
  error,
  extra,
  requires,
}: {
  readonly id: string;
  readonly copy: FieldCopy;
  readonly reading?: string | undefined;
  readonly error: string | undefined;
  readonly extra?: ReactNode;
  readonly requires?: string | undefined;
}) => (
  <>
    {reading === undefined ? null : (
      <span id={`${id}-reading`} className={styles["reading"]}>
        {reading}
      </span>
    )}
    {copy.hint === undefined && extra === undefined ? null : (
      <span id={`${id}-hint`} className={styles["hint"]}>
        {copy.hint} {extra}
      </span>
    )}
    {requires === undefined ? null : (
      <span id={`${id}-requires`} className={styles["requires"]}>
        {requires}
      </span>
    )}
    {error === undefined ? null : (
      <span id={`${id}-error`} className={kit["fieldError"]}>
        {error}
      </span>
    )}
  </>
);

const Flag = ({ spec, input, error, disabled, extra, requires, onChange }: FieldProps) => {
  const id = fieldId(spec.path);
  const copy = copyOf(spec.path, spec.label);

  return (
    <>
      <label className={styles["check"]}>
        <input
          id={id}
          type="checkbox"
          checked={input === true}
          disabled={disabled}
          aria-invalid={error !== undefined}
          aria-describedby={notesIds(id, copy, { error, extra, requires })}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{copy.check ?? copy.label}</span>
      </label>
      <Notes id={id} copy={copy} error={error} extra={extra} requires={requires} />
    </>
  );
};

const Text = ({ spec, input, error, disabled, extra, requires, onChange }: FieldProps) => {
  const id = fieldId(spec.path);
  const copy = copyOf(spec.path, spec.label);
  const numeric = spec.kind === "int";
  const timed = spec.kind === "duration" || spec.kind === "bootstrap";
  const reading = timed ? durationReading(spec, input) : undefined;

  return (
    <>
      <label className={kit["fieldLabel"]} htmlFor={id}>
        {copy.label}
      </label>
      <input
        id={id}
        className={`${kit["input"]} ${styles[copy.size ?? "medium"]}`}
        inputMode={numeric ? "numeric" : undefined}
        spellCheck={false}
        autoComplete="off"
        placeholder={copy.placeholder}
        value={textOf(input)}
        disabled={disabled}
        aria-invalid={error !== undefined}
        aria-describedby={notesIds(id, copy, { error, extra, requires }, reading)}
        onChange={(event) => onChange(event.target.value)}
      />
      <Notes
        id={id}
        copy={copy}
        reading={reading}
        error={error}
        extra={extra}
        requires={requires}
      />
    </>
  );
};

const Lines = ({ spec, input, error, disabled, extra, onChange }: FieldProps) => {
  const id = fieldId(spec.path);
  const copy = copyOf(spec.path, spec.label);

  return (
    <>
      <label className={kit["fieldLabel"]} htmlFor={id}>
        {copy.label}
      </label>
      <textarea
        id={id}
        className={`${kit["input"]} ${styles["lines"]}`}
        rows={Math.min(8, Math.max(3, textOf(input).split("\n").length + 1))}
        spellCheck={false}
        autoComplete="off"
        value={textOf(input)}
        disabled={disabled}
        aria-invalid={error !== undefined}
        aria-describedby={notesIds(id, copy, { error, extra })}
        onChange={(event) => onChange(event.target.value)}
      />
      <Notes id={id} copy={copy} error={error} extra={extra} />
    </>
  );
};

/** A radio list; `catalog` and `cooldown` add a text field to their `custom` choice. */
const Radios = ({ spec, input, error, disabled, extra, onChange }: FieldProps) => {
  const id = fieldId(spec.path);
  const copy = copyOf(spec.path, spec.label);
  const withText = spec.kind === "catalog" || spec.kind === "cooldown";
  const chosen = withText ? choiceOf(input).choice : textOf(input);
  const text = choiceOf(input).text;
  const errorId = error === undefined ? undefined : `${id}-error`;
  const inline = copy.inline === true;
  const typing = withText && chosen === "custom";

  const pick = (value: string) => {
    onChange(withText ? { choice: value, text: value === "custom" ? text : "" } : value);

    // The custom choice's text field appears with it: take the focus there.
    if (withText && value === "custom")
      requestAnimationFrame(() => document.getElementById(id)?.focus());
  };

  return (
    <fieldset className={styles["choices"]} disabled={disabled}>
      <legend className={kit["fieldLabel"]}>{copy.label}</legend>
      <div className={inline ? styles["choiceRow"] : styles["choiceList"]}>
        {(copy.options ?? []).map((option, index) => (
          <label key={option.value} className={styles["choiceLabel"]}>
            <input
              id={index === 0 && !typing ? id : undefined}
              type="radio"
              name={id}
              value={option.value}
              checked={chosen === option.value}
              aria-describedby={inline ? undefined : `${id}-${option.value}-hint`}
              onChange={() => pick(option.value)}
            />
            <span className={styles["choiceName"]}>{option.name}</span>
            {inline ? null : (
              <span id={`${id}-${option.value}-hint`} className={styles["choiceHint"]}>
                {option.hint}
              </span>
            )}
          </label>
        ))}
      </div>
      {typing ? (
        <span className={styles[inline ? "choiceTextFlush" : "choiceText"]}>
          <input
            id={id}
            className={`${kit["input"]} ${styles[spec.kind === "catalog" ? "long" : "short"]}`}
            inputMode={spec.kind === "cooldown" ? "numeric" : "url"}
            spellCheck={false}
            autoComplete="off"
            aria-label={spec.kind === "catalog" ? `${copy.label} catalog address` : "Seconds"}
            placeholder={spec.kind === "catalog" ? "https://" : "60"}
            value={text}
            aria-invalid={error !== undefined}
            aria-describedby={errorId}
            onChange={(event) => onChange({ choice: "custom", text: event.target.value })}
          />
          {spec.kind === "cooldown" ? <span className={styles["unit"]}>seconds</span> : null}
        </span>
      ) : null}
      <Notes id={id} copy={copy} error={error} extra={extra} />
    </fieldset>
  );
};

const control = (props: FieldProps): ReactNode => {
  switch (props.spec.kind) {
    case "bool":
    case "tristate":
      return <Flag {...props} />;
    case "words":
      return <Lines {...props} />;
    case "choice":
    case "images":
    case "catalog":
    case "cooldown":
      return <Radios {...props} />;
    default:
      return <Text {...props} />;
  }
};

/** One setting: its control, and its reset while it differs from the default. */
export const SettingField = (props: FieldProps) => (
  <div
    className={`${styles["field"]} ${props.requires === undefined ? "" : styles["dependent"]}`}
    data-kind={props.spec.kind}
  >
    <div className={styles["control"]}>{control(props)}</div>
    {props.isDefault ? null : (
      <Reset
        label={copyOf(props.spec.path, props.spec.label).label}
        disabled={props.disabled === true}
        onReset={props.onReset}
      />
    )}
  </div>
);
