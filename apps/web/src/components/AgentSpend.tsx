// A shared agent's Spend limits (#233, #228, ADR 0040): what its runs may spend in a day, week or month, models and
// priced tools together. They are `agent` limits of `/spend`, listed with every other limit on the Limits page; this is
// the agent's own view of them. Org admins only.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { type FormEvent, useId, useState } from "react";
import type { SpendLimitView, SpendPeriod } from "@commissary/contract/spend";
import {
  createSpendLimitAtom,
  removeSpendLimitAtom,
  SPEND,
  spendAtom,
  updateSpendLimitAtom,
} from "../api/client.ts";
import { ifMatch } from "../lib/agents.ts";
import { failureMessage } from "../lib/failure.ts";
import { formatCost } from "../lib/format.ts";
import {
  amountProblem,
  dollarsInput,
  limitProblem,
  parseDollars,
  PERIODS,
  perPeriod,
  remainingText,
  resetsText,
  spentText,
} from "../lib/spend.ts";
import { useAction } from "../lib/use-action.ts";
import { ConfirmDialog, type ConfirmRequest } from "./Confirm.tsx";
import { kit, Problem, Section } from "./Kit.tsx";
import parts from "./AgentParts.module.css";
import styles from "./AgentSections.module.css";

/** One limit's row: its figures, and the amount edited in place. */
const LimitRow = ({
  limit,
  zone,
  onProblem,
}: {
  readonly limit: SpendLimitView;
  readonly zone: string;
  readonly onProblem: (problem: string | undefined) => void;
}) => {
  const id = useId();
  const update = useAction(updateSpendLimitAtom);
  const remove = useAction(removeSpendLimitAtom);
  const [editing, setEditing] = useState(false);
  const [request, setRequest] = useState<ConfirmRequest | undefined>(undefined);
  const [amount, setAmount] = useState(dollarsInput(limit.amount_micros));
  const issue = amountProblem(amount);
  const busy = update.busy || remove.busy;

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onProblem(undefined);
    const micros = parseDollars(amount);

    if (micros === undefined) return;

    const outcome = await update.run({
      params: { id: limit.id },
      headers: ifMatch(limit),
      payload: { amount_micros: micros },
      reactivityKeys: SPEND,
    });

    if (outcome.ok) setEditing(false);
    else onProblem(limitProblem(outcome.error, outcome.message, outcome.detail));
  };

  return (
    <li className={parts["row"]}>
      <span>
        {formatCost(limit.amount_micros)} {perPeriod(limit.period)}
        <span className={parts["secondary"]}>
          {spentText(limit)} · {remainingText(limit)} · resets {resetsText(limit.resets_at, zone)}
        </span>
      </span>
      {editing ? (
        <form className={styles["inline"]} onSubmit={(event) => void save(event)} noValidate>
          <label className={kit["visuallyHidden"]} htmlFor={`${id}-amount`}>
            New amount in US dollars
          </label>
          <input
            id={`${id}-amount`}
            className={kit["input"]}
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={issue !== undefined}
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
          <button type="submit" className={kit["secondary"]} disabled={busy || issue !== undefined}>
            Save
          </button>
          <button
            type="button"
            className={parts["linkButton"]}
            onClick={() => {
              setEditing(false);
              setAmount(dollarsInput(limit.amount_micros));
            }}
          >
            Cancel
          </button>
        </form>
      ) : (
        <span className={styles["rowActions"]}>
          <button
            type="button"
            className={parts["linkButton"]}
            disabled={busy}
            onClick={() => setEditing(true)}
          >
            Change<span className={kit["visuallyHidden"]}> the {limit.period} limit</span>
          </button>
          <button
            type="button"
            className={parts["linkButton"]}
            disabled={busy}
            onClick={() => {
              onProblem(undefined);

              setRequest({
                title: `Remove the ${limit.label} limit?`,
                body: (
                  <p>
                    {limit.label} is no longer held to {formatCost(limit.amount_micros)}{" "}
                    {perPeriod(limit.period)}. What it spent so far this period stops counting
                    toward it.
                  </p>
                ),
                action: "Remove limit",
                busyAction: "Removing…",
                run: async () => {
                  const outcome = await remove.run({
                    params: { id: limit.id },
                    headers: ifMatch(limit),
                    reactivityKeys: SPEND,
                  });

                  if (!outcome.ok)
                    onProblem(limitProblem(outcome.error, outcome.message, outcome.detail));
                },
              });
            }}
          >
            Remove<span className={kit["visuallyHidden"]}> the {limit.period} limit</span>
          </button>
        </span>
      )}
      <ConfirmDialog request={request} busy={remove.busy} onClose={() => setRequest(undefined)} />
    </li>
  );
};

export const AgentSpend = ({ agent }: { readonly agent: string }) => {
  const id = useId();
  const result = useAtomValue(spendAtom);
  const retry = useAtomRefresh(spendAtom);
  const create = useAction(createSpendLimitAtom);
  const [period, setPeriod] = useState<SpendPeriod>("day");
  const [amount, setAmount] = useState("");
  const [tried, setTried] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  return (
    <Section title="Spend limit" className={styles["section"]}>
      <p className={styles["lead"]}>
        What this agent&rsquo;s runs may spend in a period, models and priced tools together. The
        org&rsquo;s own limits and the credentials&rsquo; still apply on top.
      </p>
      {AsyncResult.match(result, {
        onInitial: () => (
          <p className={kit["muted"]} aria-busy="true">
            Loading the limits…
          </p>
        ),
        onFailure: (failure) => (
          <Problem onRetry={retry}>Could not load the limits. {failureMessage(failure)}</Problem>
        ),
        onSuccess: ({ value }) => {
          const limits = value.limits
            .filter((limit) => limit.kind === "agent" && limit.subject === agent)
            .toSorted(
              (a, b) =>
                PERIODS.findIndex((each) => each.id === a.period) -
                PERIODS.findIndex((each) => each.id === b.period),
            );

          const free = PERIODS.filter((each) => !limits.some((limit) => limit.period === each.id));
          const chosen = free.some((each) => each.id === period) ? period : free[0]?.id;

          const add = async (event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            setTried(true);
            setProblem(undefined);
            const micros = parseDollars(amount);

            if (micros === undefined || chosen === undefined) return;

            const outcome = await create.run({
              payload: { kind: "agent", subject: agent, period: chosen, amount_micros: micros },
              reactivityKeys: SPEND,
            });

            if (outcome.ok) {
              setAmount("");
              setTried(false);
            } else setProblem(limitProblem(outcome.error, outcome.message, outcome.detail));
          };

          return (
            <>
              {limits.length === 0 ? (
                <p className={styles["note"]}>
                  No limit of its own: only the org&rsquo;s and the credentials&rsquo; limits hold
                  it.
                </p>
              ) : (
                <ul className={parts["list"]}>
                  {limits.map((limit) => (
                    <LimitRow
                      key={limit.id}
                      limit={limit}
                      zone={value.time_zone}
                      onProblem={setProblem}
                    />
                  ))}
                </ul>
              )}
              {problem === undefined ? null : <Problem>{problem}</Problem>}
              {chosen === undefined ? null : (
                <form
                  className={styles["add"]}
                  aria-label="Add a spend limit"
                  noValidate
                  onSubmit={(event) => void add(event)}
                >
                  <div className={styles["inline"]}>
                    <div className={kit["field"]}>
                      <label className={kit["fieldLabel"]} htmlFor={`${id}-amount`}>
                        Amount in US dollars
                      </label>
                      <input
                        id={`${id}-amount`}
                        className={kit["input"]}
                        inputMode="decimal"
                        placeholder="25"
                        autoComplete="off"
                        spellCheck={false}
                        aria-invalid={tried && amountProblem(amount) !== undefined}
                        value={amount}
                        onChange={(event) => setAmount(event.target.value)}
                      />
                    </div>
                    <div className={kit["field"]}>
                      <label className={kit["fieldLabel"]} htmlFor={`${id}-period`}>
                        Period
                      </label>
                      <select
                        id={`${id}-period`}
                        className={kit["input"]}
                        value={chosen}
                        onChange={(event) =>
                          setPeriod(
                            PERIODS.find((each) => each.id === event.target.value)?.id ?? period,
                          )
                        }
                      >
                        {free.map((each) => (
                          <option key={each.id} value={each.id}>
                            Per {each.id}
                          </option>
                        ))}
                      </select>
                    </div>
                    <button
                      type="submit"
                      className={kit["secondary"]}
                      disabled={create.busy}
                      aria-busy={create.busy}
                    >
                      {create.busy ? "Adding…" : "Add limit"}
                    </button>
                  </div>
                  {tried && amountProblem(amount) !== undefined ? (
                    <p className={kit["fieldError"]} role="alert">
                      {amountProblem(amount)}
                    </p>
                  ) : null}
                </form>
              )}
            </>
          );
        },
      })}
    </Section>
  );
};
