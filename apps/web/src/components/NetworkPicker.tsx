// A sandbox's network picker (ADR 0041): no network, a list of hosts with the package registries preset, or the
// internet. The agent editor's sandbox asks for one within the sandbox toolkit's ceiling (a kind beyond it is not
// offered), and the toolkit's own settings set that ceiling. The fields and what is wrong with them are
// `lib/sandbox-network.ts`.
import { Fragment, useId } from "react";
import {
  NETWORK_KINDS,
  type NetworkFields,
  type NetworkKind,
  PACKAGE_REGISTRIES_LABEL,
} from "../lib/sandbox-network.ts";
import { kit } from "./Kit.tsx";
import styles from "./NetworkPicker.module.css";

export const NetworkPicker = ({
  fields,
  onChange,
  allowed = () => true,
  beyond = "",
  label = "Network",
  problem,
}: {
  readonly fields: NetworkFields;
  readonly onChange: (fields: NetworkFields) => void;
  /** Whether a kind of network may be picked (the others show `beyond`, and stay unless already picked). */
  readonly allowed?: (kind: NetworkKind) => boolean;
  /** What a kind that may not be picked says in place of its hint. */
  readonly beyond?: string;
  readonly label?: string;
  /** What is wrong with the hosts, shown under them. */
  readonly problem?: string | undefined;
}) => {
  const id = useId();

  return (
    <fieldset className={styles["network"]}>
      <legend className={kit["fieldLabel"]}>{label}</legend>
      {NETWORK_KINDS.map((kind) => {
        const may = allowed(kind.id);

        return (
          <Fragment key={kind.id}>
            <label className={styles["choice"]} data-allowed={may}>
              <input
                type="radio"
                name={`${id}-network`}
                checked={fields.network === kind.id}
                disabled={!may && fields.network !== kind.id}
                onChange={() => onChange({ ...fields, network: kind.id })}
              />
              <span className={styles["choiceText"]}>
                {kind.label}
                <span className={kit["muted"]}>{may ? kind.hint : beyond}</span>
              </span>
            </label>
            {kind.id === "hosts" && fields.network === "hosts" ? (
              <div className={styles["hosts"]}>
                <label className={kit["fieldLabel"]} htmlFor={`${id}-hosts`}>
                  Hosts it may reach
                </label>
                <textarea
                  id={`${id}-hosts`}
                  className={styles["textarea"]}
                  rows={3}
                  spellCheck={false}
                  autoComplete="off"
                  value={fields.hosts}
                  aria-invalid={problem !== undefined}
                  aria-describedby={problem === undefined ? undefined : `${id}-problem`}
                  onChange={(event) => onChange({ ...fields, hosts: event.target.value })}
                />
                <label className={styles["check"]}>
                  <input
                    type="checkbox"
                    checked={fields.registries}
                    onChange={(event) => onChange({ ...fields, registries: event.target.checked })}
                  />
                  {PACKAGE_REGISTRIES_LABEL}
                </label>
                {problem === undefined ? null : (
                  <p id={`${id}-problem`} className={kit["fieldError"]} role="alert">
                    {problem}
                  </p>
                )}
              </div>
            ) : null}
          </Fragment>
        );
      })}
    </fieldset>
  );
};
