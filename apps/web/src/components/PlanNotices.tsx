// The plan notices of Commissary Cloud (ADR 0042: Commissary sends no billing email): 80% and 100% of free usage or of
// the billing cap, and a failed payment, over the org's pages for its owners and admins, linking to the Billing page
// (which shows the same state in place, so they leave it out). The shell mounts them only where `seesBilling`.
import { useAtomValue } from "@effect/atom-react";
import { Link, useMatchRoute } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { billingAtom } from "../api/client.ts";
import { noticeLines } from "../lib/billing.ts";
import { BILLING_PAGE } from "../lib/role.ts";
import { PortalButton } from "./PortalButton.tsx";
import { LimitMark } from "./Signs.tsx";
import styles from "./PlanNotices.module.css";

/** The org's plan notices, most urgent first; nothing while there are none or they cannot be read. */
export const PlanNotices = ({ owner }: { readonly owner: boolean }) => {
  const result = useAtomValue(billingAtom);
  const matchRoute = useMatchRoute();

  if (matchRoute({ to: BILLING_PAGE }) !== false || !AsyncResult.isSuccess(result)) return null;
  const lines = noticeLines(result.value, owner);

  if (lines.length === 0) return null;

  return (
    <section className={styles["notices"]} aria-label="Plan notices">
      <ul className={styles["list"]}>
        {lines.map((line) => (
          <li key={line.key} className={styles["line"]}>
            <LimitMark level={line.level} />
            <p className={styles["text"]}>{line.text}</p>
            {line.action === "portal" ? <PortalButton label="Update payment method" /> : null}
          </li>
        ))}
      </ul>
      <Link to={BILLING_PAGE} className={styles["link"]}>
        Plan and usage
      </Link>
    </section>
  );
};
