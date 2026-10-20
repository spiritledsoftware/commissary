// Opens Polar's customer portal (invoices, receipts, payment method, tax ID) for an org owner of Commissary Cloud: the
// server answers a link for this one visit (`POST /billing/portal`, org owners only). The Billing page and the plan
// notices' failed-payment line both offer it.
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { billingPortalAtom } from "../api/client.ts";
import { ownerBillingProblem } from "../lib/billing.ts";
import { useAction } from "../lib/use-action.ts";
import { kit, Problem } from "./Kit.tsx";
import styles from "./PortalButton.module.css";

export const PortalButton = ({ label = "Open billing portal" }: { readonly label?: string }) => {
  const portal = useAction(billingPortalAtom);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const open = async () => {
    setProblem(undefined);
    const outcome = await portal.run({});

    if (outcome.ok) window.location.assign(outcome.value.url);
    else setProblem(ownerBillingProblem(outcome.error, outcome.message, outcome.detail));
  };

  return (
    <div className={styles["portal"]}>
      <button
        type="button"
        className={kit["secondary"]}
        disabled={portal.busy}
        aria-busy={portal.busy}
        onClick={open}
      >
        <ExternalLink aria-hidden="true" size={16} strokeWidth={2.25} />
        {portal.busy ? "Opening…" : label}
      </button>
      {problem === undefined ? null : <Problem>{problem}</Problem>}
    </div>
  );
};
