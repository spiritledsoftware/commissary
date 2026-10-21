// Limits (/limits): what a member, team, the org, a shared credential or an API key may spend in a day, week or month of
// the org's time zone, with the Spend so far. Org admins set any limit and the calendar; a plain member sees the limits
// that bind them, how much is left, and limits their own API keys.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { type FormEvent, useId, useState } from "react";
import type { SpendLimitView, SpendView } from "@commissary/contract/spend";
import { removeSpendLimitAtom, SPEND, spendAtom, updateSpendLimitAtom } from "../api/client.ts";
import { ConfirmDialog, type ConfirmRequest } from "../components/Confirm.tsx";
import { kit, Problem, Section } from "../components/Kit.tsx";
import { failureMessage } from "../lib/failure.ts";
import { formatCost } from "../lib/format.ts";
import { type Caller, setsAnyLimit } from "../lib/role.ts";
import {
  amountProblem,
  dollarsInput,
  kindLabel,
  limitProblem,
  parseDollars,
  perPeriod,
  reached,
  remainingText,
  resetsText,
  sortLimits,
  spentShare,
  spentText,
} from "../lib/spend.ts";
import { useAction } from "../lib/use-action.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import { useRole } from "../lib/use-role.ts";
import { CalendarForm, type Note, NewLimit, NoteLine } from "./LimitsForms.tsx";
import styles from "./Limits.module.css";

/** A limit's amount, edited in place. */
const EditAmount = ({
  limit,
  onDone,
}: {
  readonly limit: SpendLimitView;
  readonly onDone: (note: Note | undefined) => void;
}) => {
  const id = useId();
  const update = useAction(updateSpendLimitAtom);
  const [amount, setAmount] = useState(dollarsInput(limit.amount_micros));
  const issue = amountProblem(amount);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const micros = parseDollars(amount);

    if (micros === undefined) return;

    const outcome = await update.run({
      params: { id: limit.id },
      headers: { "if-match": String(limit.revision) },
      payload: { amount_micros: micros },
      reactivityKeys: SPEND,
    });

    onDone(
      outcome.ok
        ? {
            tone: "done",
            text: `${limit.label} is now limited to ${formatCost(micros)} ${perPeriod(limit.period)}.`,
          }
        : { tone: "problem", text: limitProblem(outcome.error, outcome.message, outcome.detail) },
    );
  };

  return (
    <form className={styles["edit"]} onSubmit={submit} noValidate>
      <label className={kit["visuallyHidden"]} htmlFor={id}>
        New amount for {limit.label} {perPeriod(limit.period)}, in US dollars
      </label>
      <input
        id={id}
        className={kit["input"]}
        inputMode="decimal"
        autoComplete="off"
        value={amount}
        aria-invalid={issue !== undefined}
        onChange={(event) => setAmount(event.target.value)}
      />
      <button
        type="submit"
        className={kit["primary"]}
        disabled={issue !== undefined || update.busy}
      >
        {update.busy ? "Saving…" : "Save"}
      </button>
      <button type="button" className={kit["secondary"]} onClick={() => onDone(undefined)}>
        Cancel
      </button>
    </form>
  );
};

const LimitRow = ({
  limit,
  zone,
  editing,
  busy,
  onEdit,
  onEdited,
  onRemove,
}: {
  readonly limit: SpendLimitView;
  readonly zone: string;
  readonly editing: boolean;
  readonly busy: boolean;
  readonly onEdit: () => void;
  readonly onEdited: (note: Note | undefined) => void;
  readonly onRemove: () => void;
}) => (
  <tr data-reached={reached(limit)}>
    <th scope="row" className={styles["name"]}>
      {limit.label}
      <span className={styles["secondary"]}>
        {kindLabel(limit.kind)}
        {limit.source === "member" ? ", set by its owner" : ""}
      </span>
    </th>
    <td>{perPeriod(limit.period)}</td>
    <td className={styles["figures"]}>
      {editing ? (
        <EditAmount limit={limit} onDone={onEdited} />
      ) : (
        <>
          {spentText(limit)}
          <span
            className={styles["meter"]}
            role="img"
            aria-label={`${Math.round(spentShare(limit) * 100)}% spent`}
          >
            <span style={{ width: `${spentShare(limit) * 100}%` }} />
          </span>
        </>
      )}
    </td>
    <td className={styles["left"]}>{remainingText(limit)}</td>
    <td>{resetsText(limit.resets_at, zone)}</td>
    <td className={styles["actions"]}>
      {limit.editable && !editing ? (
        <>
          <button
            type="button"
            className={styles["action"]}
            aria-label={`Edit the ${limit.label} limit ${perPeriod(limit.period)}`}
            disabled={busy}
            onClick={onEdit}
          >
            Edit
          </button>
          <button
            type="button"
            className={styles["action"]}
            aria-label={`Remove the ${limit.label} limit ${perPeriod(limit.period)}`}
            disabled={busy}
            onClick={onRemove}
          >
            Remove
          </button>
        </>
      ) : null}
    </td>
  </tr>
);

const LimitTable = ({ spend, admin }: { readonly spend: SpendView; readonly admin: boolean }) => {
  const remove = useAction(removeSpendLimitAtom);
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [confirm, setConfirm] = useState<ConfirmRequest | undefined>(undefined);
  const [note, setNote] = useState<Note | undefined>(undefined);
  const limits = sortLimits(spend.limits);

  const askRemove = (limit: SpendLimitView) => {
    setNote(undefined);

    setConfirm({
      title: `Remove the ${limit.label} limit?`,
      body: (
        <p>
          {limit.label} is no longer held to {formatCost(limit.amount_micros)}{" "}
          {perPeriod(limit.period)}. What it spent so far this period stops counting toward it.
        </p>
      ),
      action: "Remove limit",
      busyAction: "Removing…",
      run: async () => {
        const outcome = await remove.run({
          params: { id: limit.id },
          headers: { "if-match": String(limit.revision) },
          reactivityKeys: SPEND,
        });

        setNote(
          outcome.ok
            ? { tone: "done", text: `Removed the ${limit.label} limit.` }
            : {
                tone: "problem",
                text: limitProblem(outcome.error, outcome.message, outcome.detail),
              },
        );
      },
    });
  };

  if (limits.length === 0) {
    return (
      <p className={styles["empty"]}>
        {admin
          ? "No limits yet: nothing is capped. Add one below."
          : "No limit applies to you. You can limit your own API keys below."}
      </p>
    );
  }

  return (
    <>
      <div className={styles["scroll"]} role="region" aria-label="Limits" tabIndex={0}>
        <table className={styles["table"]}>
          <caption className={kit["visuallyHidden"]}>Spend limits and what is spent so far</caption>
          <thead>
            <tr>
              <th scope="col">Limit on</th>
              <th scope="col">Period</th>
              <th scope="col">Spent</th>
              <th scope="col">Left</th>
              <th scope="col">Starts over</th>
              <th scope="col">
                <span className={kit["visuallyHidden"]}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {limits.map((limit) => (
              <LimitRow
                key={limit.id}
                limit={limit}
                zone={spend.time_zone}
                editing={editing === limit.id}
                busy={remove.busy}
                onEdit={() => {
                  setNote(undefined);
                  setEditing(limit.id);
                }}
                onEdited={(result) => {
                  setEditing(undefined);
                  setNote(result);
                }}
                onRemove={() => askRemove(limit)}
              />
            ))}
          </tbody>
        </table>
      </div>
      <NoteLine note={note} what="change the limit" />
      <ConfirmDialog request={confirm} busy={remove.busy} onClose={() => setConfirm(undefined)} />
    </>
  );
};

const Loaded = ({ caller }: { readonly caller: Caller }) => {
  const result = useAtomValue(spendAtom);
  const retry = useAtomRefresh(spendAtom);
  const admin = setsAnyLimit(caller);

  if (!AsyncResult.isSuccess(result)) {
    return AsyncResult.isFailure(result) ? (
      <Problem onRetry={retry}>Could not load the limits. {failureMessage(result)}</Problem>
    ) : (
      <p className={kit["muted"]} aria-busy="true">
        Loading the limits…
      </p>
    );
  }

  const spend = result.value;

  return (
    <>
      <Section title={admin ? "Limits in this org" : "Limits that apply to you"}>
        <LimitTable spend={spend} admin={admin} />
      </Section>
      <Section title="New limit">
        <NewLimit admin={admin} />
      </Section>
      {admin ? (
        <Section title="Calendar">
          <CalendarForm key={`${spend.time_zone}/${spend.week_start}`} settings={spend} />
        </Section>
      ) : (
        <p className={styles["calendar"]}>
          Periods run by the org&rsquo;s calendar: midnight to midnight in {spend.time_zone}, weeks
          starting on {spend.week_start}.
        </p>
      )}
    </>
  );
};

export const LimitsPage = () => {
  usePageTitle("Limits");
  const role = useRole();

  if (role.kind !== "ready") return null;
  const { caller } = role;
  const admin = setsAnyLimit(caller);

  return (
    <div className={kit["page"]}>
      <header className={styles["head"]}>
        <h1 className={styles["title"]}>Limits</h1>
        <p className={styles["intro"]}>
          A Spend limit caps what a member, a team, the whole org, a shared credential (an account,
          or a toolkit&rsquo;s) or an API key may spend in a day, week or month. When a limit is
          reached Commissary refuses what it covers with a 429 until the period starts over; other
          limits and credentials keep working. Priced tool calls count toward the same limits as
          model requests; a free tool call goes ahead even when a limit is used up.{" "}
          {admin
            ? "You are an org admin, so you set any limit and the calendar."
            : "You see the limits that bind you, and set limits on your own API keys."}
        </p>
      </header>
      <Loaded caller={caller} />
    </div>
  );
};
