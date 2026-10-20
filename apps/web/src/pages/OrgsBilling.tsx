// An org's billing on the org chooser, for a platform admin of Commissary Cloud (ADR 0042, #240): its plan, whether it
// is unbilled (Pay as you go with no card and no invoice) and the ceilings raised above its plan's, each changeable
// here. Read from `/orgs/<slug>/billing` when the admin opens it, whichever org the panel shows.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { type FormEvent, useId, useState } from "react";
import type { BillingCeilings, BillingView } from "@commissary/contract/billing";
import {
  orgBillingAtom,
  orgBillingKeys,
  raiseOrgCeilingsAtom,
  setOrgUnbilledAtom,
} from "../api/client.ts";
import { ConfirmDialog, type ConfirmRequest } from "../components/Confirm.tsx";
import { kit, Problem } from "../components/Kit.tsx";
import {
  billingProblem,
  ceilingHint,
  ceilingText,
  parseCeiling,
  planLabel,
} from "../lib/hosted.ts";
import { useAction } from "../lib/use-action.ts";
import styles from "./Orgs.module.css";

/** The ceilings as the form edits them: the typed text of each, empty for the plan's. */
type CeilingDrafts = Readonly<Record<keyof BillingCeilings, string>>;

const CEILING_LABELS: ReadonlyArray<readonly [keyof BillingCeilings, string]> = [
  ["browser_sessions", "Concurrent browser sessions"],
  ["computers", "Concurrent computers"],
  ["request_rate", "Requests a minute"],
];

const draftsOf = (ceilings: BillingCeilings | undefined): CeilingDrafts => {
  const text = (name: keyof BillingCeilings) => {
    const raised = ceilings?.[name].raised ?? null;

    return raised === null ? "" : String(raised);
  };

  return {
    browser_sessions: text("browser_sessions"),
    computers: text("computers"),
    request_rate: text("request_rate"),
  };
};

/** An org's billing as a platform admin of Commissary Cloud changes it: unbilled, and its raised ceilings. */
const OrgBillingForm = ({
  slug,
  name,
  billing,
}: {
  readonly slug: string;
  readonly name: string;
  readonly billing: BillingView;
}) => {
  const { ceilings } = billing;
  const setUnbilled = useAction(setOrgUnbilledAtom);
  const raise = useAction(raiseOrgCeilingsAtom);
  const ids = useId();
  const [drafts, setDrafts] = useState(() => draftsOf(ceilings));
  const [confirm, setConfirm] = useState<ConfirmRequest | undefined>(undefined);
  const [note, setNote] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const parsed = {
    browser_sessions: parseCeiling(drafts.browser_sessions),
    computers: parseCeiling(drafts.computers),
    request_rate: parseCeiling(drafts.request_rate),
  };

  const invalid = Object.values(parsed).some((input) => input.kind === "invalid");

  const askUnbilled = () => {
    const unbilled = !billing.unbilled;

    setNote(undefined);
    setProblem(undefined);

    setConfirm({
      title: unbilled ? `Mark ${name} unbilled?` : `Bill ${name} again?`,
      body: unbilled ? (
        <p>
          {name} goes on Pay as you go with no card and no invoice: nothing it uses is sent to the
          billing provider from now on, and its owners cannot start a checkout. What it owed until
          now on a subscription is still billed.
        </p>
      ) : (
        <p>
          {name} goes back to Free, or to Pay as you go if it still has a subscription. Nothing it
          used while unbilled is billed.
        </p>
      ),
      action: unbilled ? "Mark unbilled" : "Bill again",
      busyAction: unbilled ? "Marking…" : "Saving…",
      run: async () => {
        const outcome = await setUnbilled.run({
          params: { slug },
          payload: { unbilled },
          reactivityKeys: orgBillingKeys(slug),
        });

        if (outcome.ok) setNote(unbilled ? `${name} is unbilled.` : `${name} is billed again.`);
        else setProblem(billingProblem(outcome.error, outcome.message, outcome.detail));
      },
    });
  };

  const saveCeilings = async (event: FormEvent) => {
    event.preventDefault();
    setNote(undefined);
    setProblem(undefined);

    if (invalid) return;

    const value = (input: (typeof parsed)[keyof BillingCeilings]) =>
      input.kind === "raised" ? input.value : null;

    const outcome = await raise.run({
      params: { slug },
      payload: {
        browser_sessions: value(parsed.browser_sessions),
        computers: value(parsed.computers),
        request_rate: value(parsed.request_rate),
      },
      reactivityKeys: orgBillingKeys(slug),
    });

    if (outcome.ok) {
      setDrafts(draftsOf(outcome.value.ceilings));
      setNote("Saved the ceilings.");
    } else setProblem(billingProblem(outcome.error, outcome.message, outcome.detail));
  };

  return (
    <section className={styles["billing"]} aria-label={`Billing of ${name}`}>
      <dl className={styles["facts"]}>
        <div>
          <dt>Plan</dt>
          <dd>{planLabel(billing)}</dd>
        </div>
        {ceilings === undefined
          ? null
          : CEILING_LABELS.map(([field, label]) => (
              <div key={field}>
                <dt>{label}</dt>
                <dd>{ceilingText(ceilings[field])}</dd>
              </div>
            ))}
      </dl>
      <div>
        <button
          type="button"
          className={kit["secondary"]}
          disabled={setUnbilled.busy}
          onClick={askUnbilled}
        >
          {billing.unbilled ? "Bill again" : "Mark unbilled"}
        </button>
      </div>
      <form className={styles["ceilings"]} onSubmit={saveCeilings} aria-label="Raised ceilings">
        {CEILING_LABELS.map(([field, label]) => (
          <div key={field} className={kit["field"]}>
            <label className={kit["fieldLabel"]} htmlFor={`${ids}-${field}`}>
              {label}
            </label>
            <input
              id={`${ids}-${field}`}
              className={kit["input"]}
              value={drafts[field]}
              inputMode="numeric"
              autoComplete="off"
              placeholder="Plan’s"
              aria-invalid={parsed[field].kind === "invalid"}
              aria-describedby={`${ids}-hint`}
              onChange={(event) => setDrafts({ ...drafts, [field]: event.target.value })}
            />
          </div>
        ))}
        <button type="submit" className={kit["secondary"]} disabled={raise.busy || invalid}>
          Save ceilings
        </button>
        <p id={`${ids}-hint`} className={invalid ? kit["fieldError"] : kit["muted"]}>
          {ceilingHint()}
        </p>
      </form>
      {problem === undefined ? null : <Problem>{problem}</Problem>}
      <p className={kit["muted"]} role="status">
        {note}
      </p>
      <ConfirmDialog
        request={confirm}
        busy={setUnbilled.busy}
        onClose={() => setConfirm(undefined)}
      />
    </section>
  );
};

/** An org's billing, read when a platform admin opens it. */
export const OrgBilling = ({ slug, name }: { readonly slug: string; readonly name: string }) => {
  const result = useAtomValue(orgBillingAtom(slug));
  const retry = useAtomRefresh(orgBillingAtom(slug));

  return AsyncResult.match(result, {
    onInitial: () => (
      <p className={kit["muted"]} aria-busy="true">
        Loading billing…
      </p>
    ),
    onFailure: () => <Problem onRetry={retry}>Could not load the org&rsquo;s billing.</Problem>,
    onSuccess: ({ value }) => <OrgBillingForm slug={slug} name={name} billing={value} />,
  });
};
