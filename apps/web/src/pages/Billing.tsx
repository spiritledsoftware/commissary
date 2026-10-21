// Billing (/billing, Commissary Cloud only; ADR 0042): the org's plan with its free usage and rates, this month's usage
// against free usage, on Pay as you go the bill so far against the billing cap, and for org owners the upgrade (Polar's
// checkout), the switch back to Free, the billing cap and Polar's customer portal. Other org admins read it all; plain
// members have no such page (the shell's gate), and neither has a self-hosted Commissary.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { ArrowUpRight } from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
import { AsyncResult } from "effect/reactivity";
import type { BillingView } from "@commissary/contract/billing";
import {
  BILLING,
  billingAtom,
  meAtom,
  panelOrgSlug,
  setBillingCapAtom,
  startCheckoutAtom,
  switchToFreeAtom,
} from "../api/client.ts";
import { type ConfirmRequest, ConfirmDialog } from "../components/Confirm.tsx";
import { kit, Problem, Section } from "../components/Kit.tsx";
import { Meter } from "../components/Meter.tsx";
import { PortalButton } from "../components/PortalButton.tsx";
import { LimitMark } from "../components/Signs.tsx";
import {
  ASK_OWNER_TO_PAY,
  awaitingUpgrade,
  billReading,
  changesBilling,
  formatDollars,
  ownerBillingProblem,
  parseBillingCap,
  PAYMENT_FAILED,
  resetDay,
  seesBilling,
  unitReadings,
  upgradeWaitEnds,
} from "../lib/billing.ts";
import { failureMessage } from "../lib/failure.ts";
import { planLabel } from "../lib/hosted.ts";
import type { QuotaLevel } from "../lib/quota.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import { type Outcome, useAction } from "../lib/use-action.ts";
import { useRole } from "../lib/use-role.ts";
import { NotFound } from "./NotFound.tsx";
import styles from "./Billing.module.css";

/** Where the page keeps when an owner left for Polar's checkout, so it can wait for the upgrade on the way back. */
const checkoutKey = `commissary:checkout:${panelOrgSlug ?? ""}`;

const checkoutStartedAt = (): number | undefined => {
  const stored = Number(window.sessionStorage.getItem(checkoutKey));

  return Number.isFinite(stored) && stored > 0 ? stored : undefined;
};

/** How often the page reads the billing again while it waits for Polar's webhook, and for how many reads. */
const UPGRADE_POLL_MS = 5000;

const UPGRADE_POLLS = 12;

/**
 * Back from checkout, the org may still read Free until Polar's webhook arrives: the page says so and reads the billing
 * again a few times, then leaves a button. The clock it waits by moves with each read and at the end of the wait.
 */
const useUpgradeWait = (view: BillingView) => {
  const refresh = useAtomRefresh(billingAtom);
  const [startedAt] = useState(checkoutStartedAt);
  const [now, setNow] = useState(() => Date.now());
  const waiting = awaitingUpgrade(startedAt, now, view);

  // Once the org reads Pay as you go (or the wait is over), the checkout is behind it.
  useEffect(() => {
    if (!waiting) window.sessionStorage.removeItem(checkoutKey);
  }, [waiting]);

  // The wait ends an hour after the checkout started, whether or not the page reads the billing then.
  useEffect(() => {
    const timer =
      startedAt === undefined
        ? undefined
        : window.setTimeout(
            () => setNow(Date.now()),
            Math.max(0, upgradeWaitEnds(startedAt) - Date.now()),
          );

    return () => window.clearTimeout(timer);
  }, [startedAt]);

  useEffect(() => {
    let polls = 0;

    const timer = waiting
      ? window.setInterval(() => {
          polls += 1;
          setNow(Date.now());
          refresh();

          if (polls >= UPGRADE_POLLS) window.clearInterval(timer);
        }, UPGRADE_POLL_MS)
      : undefined;

    return () => window.clearInterval(timer);
  }, [waiting, refresh]);

  return { waiting, check: refresh };
};

type Note =
  | { readonly tone: "done"; readonly text: string }
  | { readonly tone: "problem"; readonly text: string };

/** One section's last result: `settle` reports an owner's call, and says whether it succeeded. */
const useNote = () => {
  const [note, setNote] = useState<Note | undefined>(undefined);

  const settle = <A,>(outcome: Outcome<A>, done: (value: A) => string): boolean => {
    setNote(
      outcome.ok
        ? { tone: "done", text: done(outcome.value) }
        : {
            tone: "problem",
            text: ownerBillingProblem(outcome.error, outcome.message, outcome.detail),
          },
    );

    return outcome.ok;
  };

  return { note, settle, clear: () => setNote(undefined) } as const;
};

/** A live region: it stays mounted so a result is announced, taking no room while it is empty. */
const NoteLine = ({ note }: { readonly note: Note | undefined }) => (
  <>
    {note?.tone === "problem" ? <Problem>{note.text}</Problem> : null}
    <p className={styles["note"]} role="status">
      {note?.tone === "done" ? note.text : null}
    </p>
  </>
);

/** How near a limit a row is, said in ink beside its mark (the Near-Limit Rule); nothing while it is not. */
const LevelNote = ({
  level,
  text,
}: {
  readonly level: QuotaLevel;
  readonly text: string | undefined;
}) =>
  level === "ok" || text === undefined ? null : (
    <span className={styles["levelNote"]}>
      <LimitMark level={level} />
      {text}
    </span>
  );

/** The plan, what it means this month, and what an org owner can change about it. */
const PlanSection = ({ view, owner }: { readonly view: BillingView; readonly owner: boolean }) => {
  const checkout = useAction(startCheckoutAtom);
  const toFree = useAction(switchToFreeAtom);
  const upgrade = useUpgradeWait(view);
  const { note, settle, clear } = useNote();
  const [confirm, setConfirm] = useState<ConfirmRequest | undefined>(undefined);
  const payg = view.plan === "payg";
  const pastDue = payg && view.payment === "past_due";
  // The portal needs the org's billing account: Pay as you go has one, and so has an org that paid before.
  const portal = !view.unbilled && (payg || view.card_on_file === true);

  const startCheckout = async () => {
    clear();
    const outcome = await checkout.run({});

    settle(outcome, () => "Opening the checkout…");

    if (!outcome.ok) return;

    window.sessionStorage.setItem(checkoutKey, String(Date.now()));
    window.location.assign(outcome.value.url);
  };

  const askFree = () => {
    clear();

    setConfirm({
      title: "Switch to Free?",
      body: (
        <p>
          {`The org goes on Free at once: requests above free usage are refused until ${resetDay(view)}. What it used this month until now is still invoiced.`}
        </p>
      ),
      action: "Switch to Free",
      busyAction: "Switching…",
      tone: "primary",
      keep: "Stay on Pay as you go",
      run: async () => {
        settle(
          await toFree.run({ payload: { plan: "free" }, reactivityKeys: BILLING }),
          () => "The org is on Free.",
        );
      },
    });
  };

  return (
    <Section title="Plan" className={styles["section"]}>
      <div className={styles["plan"]}>
        <p className={styles["planName"]}>This org is on {planLabel(view)}.</p>
        {view.unbilled ? (
          <p className={styles["lead"]}>
            A platform admin made this org unbilled: nothing it uses is billed, and no billing cap
            applies.
          </p>
        ) : payg ? (
          <p className={styles["lead"]}>
            What the org uses above free usage is billed monthly at the rates below, with no monthly
            fee, up to the billing cap.
          </p>
        ) : (
          <p className={styles["lead"]}>
            Requests stop at free usage until the month starts over on {resetDay(view)}. Pay as you
            go has no monthly fee: it bills only what is used above free usage, up to a billing cap.
          </p>
        )}
        {pastDue ? (
          <p className={styles["levelNote"]}>
            <LimitMark level="out" />
            {owner ? PAYMENT_FAILED : `${PAYMENT_FAILED} ${ASK_OWNER_TO_PAY}`}
          </p>
        ) : null}
        {upgrade.waiting ? (
          <div className={styles["waiting"]} role="status">
            <p>
              Back from checkout? Pay as you go shows here once the payment provider confirms the
              payment, usually within a minute.
            </p>
            <button type="button" className={kit["secondary"]} onClick={upgrade.check}>
              Check again
            </button>
          </div>
        ) : null}
        {owner && !view.unbilled ? (
          <div className={styles["actions"]}>
            {payg ? null : (
              <button
                type="button"
                className={kit["primary"]}
                disabled={checkout.busy}
                aria-busy={checkout.busy}
                onClick={startCheckout}
              >
                <ArrowUpRight aria-hidden="true" size={18} strokeWidth={2.25} />
                {checkout.busy ? "Opening checkout…" : "Upgrade to Pay as you go"}
              </button>
            )}
            {portal ? (
              <PortalButton label={pastDue ? "Update payment method" : "Open billing portal"} />
            ) : null}
            {payg ? (
              <button
                type="button"
                className={kit["secondary"]}
                disabled={toFree.busy}
                onClick={askFree}
              >
                Switch to Free
              </button>
            ) : null}
          </div>
        ) : null}
        {owner && portal ? (
          <p className={kit["muted"]}>
            Invoices, receipts, the payment method and the tax ID are in the billing portal, at
            Polar.
          </p>
        ) : owner ? null : (
          <p className={kit["muted"]}>
            An org owner changes the plan and opens the billing portal for invoices and the payment
            method.
          </p>
        )}
        <NoteLine note={note} />
      </div>
      <ConfirmDialog request={confirm} busy={toFree.busy} onClose={() => setConfirm(undefined)} />
    </Section>
  );
};

/** Each unit's use this month against its free usage, with Pay as you go's rate above it. */
const MonthSection = ({ view }: { readonly view: BillingView }) => (
  <Section
    title="This month"
    className={styles["section"]}
    aside={<span className={kit["muted"]}>Starts over {resetDay(view)}</span>}
  >
    <div className={styles["scroll"]}>
      <table className={styles["table"]}>
        <thead>
          <tr>
            <th scope="col">What counts</th>
            <th scope="col" className={styles["number"]}>
              Used
            </th>
            <th scope="col">Free usage a month</th>
            <th scope="col">Above it, on Pay as you go</th>
          </tr>
        </thead>
        <tbody>
          {unitReadings(view).map((row) => (
            <tr key={row.unit} data-level={row.level}>
              <th scope="row" className={styles["unit"]}>
                {row.name}
              </th>
              <td className={`${styles["number"]} ${styles["figure"]}`}>{row.used}</td>
              <td className={styles["free"]}>
                {row.free === undefined || row.percent === undefined ? (
                  <span className={styles["none"]}>None</span>
                ) : (
                  <Meter
                    label={row.free}
                    percent={row.percent}
                    level={row.level}
                    spokenLabel={`${row.name}: free usage used`}
                  />
                )}
                <LevelNote level={row.level} text={row.levelNote} />
                {row.billed === undefined ? null : (
                  <span className={styles["secondary"]}>{row.billed}</span>
                )}
              </td>
              <td>{row.rate}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    <p className={styles["footnote"]}>
      A request to a model or a tool call counts once when Commissary starts serving it, whatever
      credential serves it and however it ends; one refused before any work is not counted. Browser
      hours and computer hours count the time a browser session, a Quick Action or a computer used.
    </p>
  </Section>
);

/** An org owner's billing cap: an amount to save, or none. */
const CapForm = ({ cap }: { readonly cap: number | null }) => {
  const save = useAction(setBillingCapAtom);
  const ids = useId();
  const { note, settle, clear } = useNote();
  const [draft, setDraft] = useState(cap === null ? "" : String(cap));
  const parsed = parseBillingCap(draft);
  const invalid = draft.trim() !== "" && parsed.kind === "invalid";

  const send = async (next: number | null) => {
    clear();

    const outcome = await save.run({ payload: { billing_cap: next }, reactivityKeys: BILLING });

    if (outcome.ok)
      setDraft(outcome.value.billing_cap === null ? "" : String(outcome.value.billing_cap));

    settle(outcome, ({ billing_cap: saved }) =>
      saved === null
        ? "Removed the billing cap."
        : `The billing cap is ${formatDollars(saved)} a month.`,
    );
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (parsed.kind === "cap") void send(parsed.value);
  };

  return (
    <>
      <form className={styles["capForm"]} onSubmit={submit} aria-label="Billing cap">
        <div className={kit["field"]}>
          <label className={kit["fieldLabel"]} htmlFor={`${ids}-cap`}>
            Billing cap, dollars a month
          </label>
          <input
            id={`${ids}-cap`}
            className={kit["input"]}
            value={draft}
            inputMode="decimal"
            autoComplete="off"
            placeholder="No billing cap"
            aria-invalid={invalid}
            aria-describedby={`${ids}-hint`}
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>
        <button
          type="submit"
          className={kit["secondary"]}
          disabled={save.busy || parsed.kind !== "cap"}
          aria-busy={save.busy}
        >
          {save.busy ? "Saving…" : "Save billing cap"}
        </button>
        {cap === null ? null : (
          <button
            type="button"
            className={kit["secondary"]}
            disabled={save.busy}
            onClick={() => void send(null)}
          >
            Remove the billing cap
          </button>
        )}
      </form>
      <p id={`${ids}-hint`} className={invalid ? kit["fieldError"] : kit["muted"]}>
        {invalid
          ? "A billing cap is an amount of dollars from 0, in whole cents."
          : "From $0, in whole cents. Without a billing cap, nothing stops what Pay as you go bills."}
      </p>
      <NoteLine note={note} />
    </>
  );
};

/** The month's bill on Pay as you go against the billing cap, and the billing cap itself. */
const CapSection = ({ view, owner }: { readonly view: BillingView; readonly owner: boolean }) => {
  const bill = billReading(view);
  const cap = view.billing_cap;

  return (
    <Section title="Billing cap" className={styles["section"]}>
      <div className={styles["cap"]}>
        {bill === undefined ? (
          <p className={styles["capLine"]}>
            {cap === null ? "No billing cap" : `${formatDollars(cap)} a month`}
            <span className={styles["secondary"]}>Applies on Pay as you go</span>
          </p>
        ) : (
          <div className={styles["bill"]} data-level={bill.level}>
            <p className={styles["billFigure"]}>
              {bill.bill}
              <span className={styles["billOf"]}>
                {bill.cap === undefined
                  ? " billed so far, no billing cap"
                  : ` of ${bill.cap} billed so far`}
              </span>
            </p>
            {bill.cap === undefined || bill.percent === undefined ? null : (
              <Meter
                label="Billing cap"
                percent={bill.percent}
                level={bill.level}
                spokenLabel="Billing cap used"
              />
            )}
            <LevelNote level={bill.level} text={bill.levelNote} />
          </div>
        )}
        <p className={styles["lead"]}>
          The most Commissary Cloud may bill this org in a month. Once the bill reaches it, use that
          would be billed is refused until the month starts over; use within free usage never is.{" "}
          {owner
            ? "Raise it, lower it or remove it at any time: the change applies to the next request."
            : "Only an org owner changes it."}
        </p>
        {owner ? <CapForm key={String(cap)} cap={cap} /> : null}
      </div>
    </Section>
  );
};

const Body = ({ owner }: { readonly owner: boolean }) => {
  const result = useAtomValue(billingAtom);
  const retry = useAtomRefresh(billingAtom);

  return AsyncResult.match(result, {
    onInitial: () => (
      <p className={kit["muted"]} aria-busy="true">
        Loading billing…
      </p>
    ),
    onFailure: (failure) => (
      <Problem onRetry={retry}>Could not load the billing. {failureMessage(failure)}</Problem>
    ),
    onSuccess: ({ value }) => (
      <>
        <PlanSection view={value} owner={owner} />
        <MonthSection view={value} />
        {value.unbilled ? null : <CapSection view={value} owner={owner} />}
      </>
    ),
  });
};

export const BillingPage = () => {
  usePageTitle("Billing");
  const role = useRole();
  const me = useAtomValue(meAtom);

  if (role.kind !== "ready" || !AsyncResult.isSuccess(me)) return null;

  // Plans exist on Commissary Cloud only: a self-hosted Commissary has no billing page (ADR 0042).
  if (!seesBilling(me.value.deployment.hosted, role.caller)) return <NotFound />;
  const owner = changesBilling(role.caller);

  return (
    <div className={kit["page"]}>
      <header className={styles["head"]}>
        <h1 className={styles["title"]}>Billing</h1>
        <p className={styles["intro"]}>
          Commissary Cloud bills for its own platform, never for model access: your providers bill
          you for that directly. Every month starts with the same free usage on either plan, and
          every plan has unlimited members.{" "}
          {owner
            ? "As an org owner you change the plan and the billing cap."
            : "Only an org owner changes the plan or the billing cap; you are an org admin, so you can read them."}
        </p>
      </header>
      <Body owner={owner} />
    </div>
  );
};
