// What an org admin sees of other members' private accounts and provider keys (ADR 0023): that each exists, its provider,
// owner and label, nothing of its use. An org admin may disable (accounts) or remove it, never open it.
import { useState } from "react";
import { ConfirmDialog, type ConfirmRequest } from "./Confirm.tsx";
import { kit, Section } from "./Kit.tsx";
import styles from "./PrivateRows.module.css";

export interface PrivateRow {
  readonly key: string;
  /** What it is, where rows differ in that (an account's provider); absent where every row is the same kind. */
  readonly provider?: string;
  readonly label: string;
  /** The owner's email, or their member id when they have no email on record. */
  readonly owner: string;
  /** Present for rows that can be disabled and enabled again. */
  readonly disabled?: boolean;
}

/** Whether the change worked, and what to tell the person when it did not. */
export interface Settled {
  readonly ok: boolean;
  readonly message?: string;
}

export const PrivateRows = ({
  title,
  noun,
  rows,
  onDisable,
  onRemove,
}: {
  readonly title: string;
  /** What a row is, for the confirmation: "account" or "Provider key group". */
  readonly noun: string;
  readonly rows: ReadonlyArray<PrivateRow>;
  /** Disables or enables a row; absent where a row cannot be disabled. */
  readonly onDisable?: (row: PrivateRow, disabled: boolean) => Promise<Settled>;
  readonly onRemove: (row: PrivateRow) => Promise<Settled>;
}) => {
  const [request, setRequest] = useState<ConfirmRequest | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  if (rows.length === 0) return null;

  const run = async (change: () => Promise<Settled>) => {
    setBusy(true);
    setProblem(undefined);
    const settled = await change();
    setBusy(false);

    if (!settled.ok) setProblem(settled.message ?? "The change failed.");
  };

  return (
    <Section title={title} className={styles["section"]}>
      <p className={kit["muted"]}>
        Private to their owners: you see that each exists, who owns it and its label, and nothing of
        how it is used. You can {onDisable === undefined ? "" : "disable or "}remove one.
      </p>
      {problem === undefined ? null : (
        <p role="alert" className={styles["problem"]}>
          {problem}
        </p>
      )}
      <ul className={styles["list"]}>
        {rows.map((row) => (
          <li
            key={row.key}
            className={styles["row"]}
            data-disabled={row.disabled === true}
            data-kindless={row.provider === undefined}
          >
            {row.provider === undefined ? null : (
              <span className={styles["provider"]}>{row.provider}</span>
            )}
            <span className={styles["label"]}>{row.label}</span>
            <span className={styles["owner"]}>{row.owner}</span>
            <span className={styles["actions"]}>
              {onDisable === undefined || row.disabled === undefined ? null : (
                <button
                  type="button"
                  className={kit["secondary"]}
                  disabled={busy}
                  onClick={() => void run(() => onDisable(row, row.disabled !== true))}
                >
                  {row.disabled === true ? "Enable" : "Disable"}
                </button>
              )}
              <button
                type="button"
                className={kit["danger"]}
                disabled={busy}
                onClick={() =>
                  setRequest({
                    title: `Remove this ${noun}?`,
                    body: (
                      <p>
                        {row.provider === undefined
                          ? `The ${noun} of ${row.owner} (${row.label.toLowerCase()}) is deleted.`
                          : `${row.provider} “${row.label}”, owned by ${row.owner}, is deleted.`}{" "}
                        Its owner loses it and cannot get it back.
                      </p>
                    ),
                    action: "Remove",
                    busyAction: "Removing…",
                    run: async () => {
                      await run(() => onRemove(row));
                    },
                  })
                }
              >
                Remove
              </button>
            </span>
          </li>
        ))}
      </ul>
      <ConfirmDialog request={request} busy={busy} onClose={() => setRequest(undefined)} />
    </Section>
  );
};
