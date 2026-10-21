// A toolkit's prices on its page, for org admins (#209, ADR 0038): the price per call of an org toolkit, or per browser
// or computer hour of the two toolkits Commissary provides. A tool's own price is set on its row in the tool list and
// wins over the toolkit's. An empty price is free and is not flagged, unlike a model without one. The spend limit of its
// shared credential is on the Limits page.
import { Link } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";
import type { ToolkitView, UpdateToolkit } from "@commissary/contract/tools";
import { TOOLKITS, updateToolkitAtom } from "../api/client.ts";
import { kit, Problem, Section } from "../components/Kit.tsx";
import {
  currentPrice,
  priceBody,
  priceChanged,
  type PriceField,
  priceFieldsOf,
  priceProblem,
  priceText,
} from "../lib/tool-prices.ts";
import { problemOf } from "../lib/toolkits.ts";
import { useAction } from "../lib/use-action.ts";
import styles from "./Tools.module.css";

const PriceInput = ({
  field,
  value,
  onChange,
}: {
  readonly field: PriceField;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) => {
  const id = useId();
  const problem = priceProblem(value);

  return (
    <div className={styles["field"]}>
      <label className={kit["fieldLabel"]} htmlFor={id}>
        {field.label}
      </label>
      <input
        id={id}
        className={kit["input"]}
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        placeholder="0.00"
        value={value}
        aria-invalid={problem !== undefined}
        aria-describedby={`${id}-note`}
        onChange={(event) => onChange(event.target.value)}
      />
      <span
        id={`${id}-note`}
        className={problem === undefined ? styles["hint"] : kit["fieldError"]}
      >
        {problem ?? field.hint}
      </span>
    </div>
  );
};

export const ToolkitPrices = ({ toolkit }: { readonly toolkit: ToolkitView }) => {
  const fields = priceFieldsOf(toolkit);
  const update = useAction(updateToolkitAtom);

  const [values, setValues] = useState<Readonly<Record<string, string>>>(() =>
    Object.fromEntries(
      fields.map((field) => [field.field, priceText(currentPrice(toolkit, field.field))]),
    ),
  );

  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [saved, setSaved] = useState(false);
  const valueOf = (field: PriceField): string => values[field.field] ?? "";
  const changed = fields.some((field) => priceChanged(toolkit, field, valueOf(field)));
  const invalid = fields.some((field) => priceProblem(valueOf(field)) !== undefined);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(undefined);
    setSaved(false);

    if (invalid || !changed) return;

    const payload = fields.reduce<UpdateToolkit>(
      (body, field) => Object.assign(body, priceBody(field, valueOf(field))),
      {},
    );

    const outcome = await update.run({
      params: { id: toolkit.id },
      headers: { "if-match": String(toolkit.revision) },
      payload,
      reactivityKeys: TOOLKITS,
    });

    if (outcome.ok) setSaved(true);
    else setProblem(problemOf(outcome) ?? outcome.message);
  };

  return (
    <Section title="Prices" className={styles["section"]}>
      {fields.length === 0 ? (
        <p className={styles["note"]}>
          This toolkit has no price of its own; its tools may be priced one by one in the list
          above.
        </p>
      ) : (
        <form className={styles["form"]} onSubmit={(event) => void submit(event)} noValidate>
          {fields.map((field) => (
            <PriceInput
              key={field.field}
              field={field}
              value={valueOf(field)}
              onChange={(value) => {
                setValues({ ...values, [field.field]: value });
                setSaved(false);
              }}
            />
          ))}
          {problem === undefined ? null : <Problem>{problem}</Problem>}
          <div className={styles["actions"]}>
            <button
              type="submit"
              className={kit["primary"]}
              disabled={update.busy || !changed || invalid}
              aria-busy={update.busy}
            >
              {update.busy ? "Saving…" : "Save prices"}
            </button>
            {saved ? (
              <span className={styles["note"]} role="status">
                Saved.
              </span>
            ) : null}
          </div>
        </form>
      )}
      {toolkit.built_in === true ? null : (
        <p className={styles["note"]}>
          Cap what its shared credential spends on the <Link to="/limits">Limits page</Link>.
        </p>
      )}
    </Section>
  );
};
