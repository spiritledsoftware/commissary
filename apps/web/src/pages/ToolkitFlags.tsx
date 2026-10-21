// What needs attention about a toolkit or a tool, one sentence a line (the One Meaning Rule): the red trail mark beside
// what is closed or failing, an ink note with no mark for what to tidy or know, which works meanwhile.
import { TrailMark } from "../components/Signs.tsx";
import styles from "./Tools.module.css";

export interface FlagLine {
  readonly text: string;
  readonly severity: "failing" | "note";
}

export const FlagText = ({ flag }: { readonly flag: FlagLine }) =>
  flag.severity === "failing" ? (
    <span className={styles["flag"]}>
      <TrailMark />
      {flag.text}
    </span>
  ) : (
    <span className={styles["note"]}>{flag.text}</span>
  );

export const Flags = ({
  flags,
  label,
}: {
  readonly flags: ReadonlyArray<FlagLine>;
  readonly label?: string;
}) =>
  flags.length === 0 ? null : (
    <ul className={styles["flags"]} aria-label={label}>
      {flags.map((flag) => (
        <li key={flag.text}>
          <FlagText flag={flag} />
        </li>
      ))}
    </ul>
  );
