// The fields of the Tools pages' forms, drawn from their specs (`FormField`, src/lib/toolkit-credentials.ts): a label
// above, an input (a password field for a secret, a text area, or a select), its hint or problem beneath. A secret text
// area (a private key) is obscured like a password field until Show.
import { useId, useState } from "react";
import { kit } from "../components/Kit.tsx";
import type { FieldValues, FormField } from "../lib/toolkit-credentials.ts";
import styles from "./Tools.module.css";

export const SpecField = ({
  spec,
  value,
  problem,
  onChange,
}: {
  readonly spec: FormField;
  readonly value: string;
  readonly problem: string | undefined;
  readonly onChange: (value: string) => void;
}) => {
  const id = useId();
  const [shown, setShown] = useState(false);
  const obscured = spec.secret && !shown;
  const note = problem ?? spec.hint;
  const described = note === undefined ? undefined : `${id}-note`;
  const label = spec.optional ? `${spec.label} (optional)` : spec.label;

  const common = {
    id,
    value,
    "aria-invalid": problem !== undefined,
    "aria-describedby": described,
  };

  return (
    <div className={styles["field"]}>
      <label className={kit["fieldLabel"]} htmlFor={id}>
        {label}
      </label>
      {spec.options === undefined ? (
        spec.multiline === true ? (
          <>
            <textarea
              {...common}
              className={`${styles["textarea"]}${obscured ? ` ${styles["obscured"]}` : ""}`}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => onChange(event.target.value)}
            />
            {spec.secret ? (
              <button
                type="button"
                className={styles["linkButton"]}
                aria-controls={id}
                aria-pressed={shown}
                onClick={() => setShown(!shown)}
              >
                {shown ? `Hide ${spec.label.toLowerCase()}` : `Show ${spec.label.toLowerCase()}`}
              </button>
            ) : null}
          </>
        ) : (
          <input
            {...common}
            className={kit["input"]}
            type={spec.secret ? "password" : "text"}
            spellCheck={false}
            autoComplete={spec.secret ? "new-password" : "off"}
            onChange={(event) => onChange(event.target.value)}
          />
        )
      ) : (
        <select
          {...common}
          className={kit["input"]}
          onChange={(event) => onChange(event.target.value)}
        >
          {spec.optional || value === "" ? <option value="">Not set</option> : null}
          {spec.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      )}
      {note === undefined ? null : (
        <span id={described} className={problem === undefined ? styles["hint"] : kit["fieldError"]}>
          {note}
        </span>
      )}
    </div>
  );
};

/** Every field of a spec list, with their values and problems. */
export const SpecFields = ({
  specs,
  values,
  problems,
  onChange,
}: {
  readonly specs: ReadonlyArray<FormField>;
  readonly values: FieldValues;
  readonly problems: Readonly<Record<string, string>>;
  readonly onChange: (key: string, value: string) => void;
}) =>
  specs.map((spec) => (
    <SpecField
      key={spec.key}
      spec={spec}
      value={values[spec.key] ?? ""}
      problem={problems[spec.key]}
      onChange={(value) => onChange(spec.key, value)}
    />
  ));
