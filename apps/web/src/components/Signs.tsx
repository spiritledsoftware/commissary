// Trail-sign pieces. The reset blade: a yellow trail-sign blade naming the window that resets next and how long
// until it does, set like a destination and its walking time (red when the account is closed; the white-red-white
// mountain-trail band on its tip when the account is near its limit). The trail mark: the red paint band beside
// something closed or failing; the near mark: the white-red-white band beside something near its limit.
import styles from "./Signs.module.css";

interface ResetBladeProps {
  /** The destination: the window that resets ("5-hour"), or "Back in" for a closed account. */
  readonly destination: string;
  /** "1 h 34 min". */
  readonly time: string;
  /** Read in full by assistive technology ("5-hour window resets in 1 h 34 min"). */
  readonly label: string;
  readonly closed: boolean;
  /** Near its limit: the white-red-white band on the tip. */
  readonly demanding: boolean;
  /** The clock time under the blade ("Sat 4:48 PM"). */
  readonly caption: string;
  /** Position in its column: the blades unfold one after another, top first. */
  readonly order?: number;
}

export const ResetBlade = ({
  destination,
  time,
  label,
  closed,
  demanding,
  caption,
  order = 0,
}: ResetBladeProps) => (
  <div className={styles["post"]}>
    <span className={styles["edge"]}>
      <span
        className={styles["blade"]}
        data-closed={closed}
        data-demanding={demanding}
        role="img"
        aria-label={label}
        style={{ animationDelay: `${order * 45}ms` }}
      >
        <span className={styles["destination"]}>{destination}</span>
        <span className={styles["time"]}>{time}</span>
      </span>
      {demanding ? (
        <span
          className={styles["tipFrame"]}
          style={{ animationDelay: `${order * 45 + 420}ms` }}
          aria-hidden="true"
        >
          <span className={styles["tip"]} />
        </span>
      ) : null}
    </span>
    <span className={styles["caption"]}>{caption}</span>
  </div>
);

export const TrailMark = () => <span className={styles["mark"]} aria-hidden="true" />;

/** The white-red-white band beside something near its limit. */
export const NearMark = () => <span className={styles["nearMark"]} aria-hidden="true" />;

/** Which mark stands beside something near its limit, and beside something at it. */
const LIMIT_MARKS = { near: NearMark, out: TrailMark } as const;

/** The mark of how near a limit something is: the near mark at 80%, the trail mark at 100%. */
export const LimitMark = ({ level }: { readonly level: keyof typeof LIMIT_MARKS }) => {
  const Mark = LIMIT_MARKS[level];

  return <Mark />;
};
