// Use against allowance: a flat bar on the shared 0–100% scale (stone is the unused allowance) with its figure. With a
// pace, a tick marks the share of the period that had passed and a caption under the track says how far the share
// used is from it (GLOSSARY.md, Pace).
import type { Pace, QuotaLevel } from "../lib/quota.ts";
import { formatPercent } from "../lib/format.ts";
import styles from "./Meter.module.css";

interface MeterProps {
  readonly label: string;
  /** 0–100. */
  readonly percent: number;
  readonly level: QuotaLevel;
  /** The allowance's pace, when it has one. */
  readonly pace?: Pace | undefined;
  /** What assistive technology calls the meter, when "<label> allowance used" does not say it (free usage). */
  readonly spokenLabel?: string | undefined;
}

const caption = (pace: Pace): string =>
  pace.verdict === "on" ? "On pace" : `${pace.points} pts ${pace.verdict}`;

const spoken = (pace: Pace): string =>
  pace.verdict === "on" ? "on pace" : `${pace.points} points ${pace.verdict} of pace`;

export const Meter = ({ label, percent, level, pace, spokenLabel }: MeterProps) => (
  <div className={styles["meter"]}>
    <span className={styles["label"]}>{label}</span>
    <div className={styles["gauge"]}>
      <div
        className={styles["track"]}
        role="meter"
        aria-label={spokenLabel ?? `${label} allowance used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        aria-valuetext={
          pace === undefined ? formatPercent(percent) : `${formatPercent(percent)}, ${spoken(pace)}`
        }
      >
        <div className={styles["fill"]} data-level={level} style={{ width: `${percent}%` }} />
      </div>
      {pace === undefined ? null : (
        <span
          className={styles["tick"]}
          style={{ left: `${pace.elapsedPercent}%` }}
          aria-hidden="true"
        />
      )}
    </div>
    <span className={styles["value"]} data-level={level}>
      {formatPercent(percent)}
    </span>
    {pace === undefined ? null : (
      <span className={styles["pace"]} aria-hidden="true">
        {caption(pace)}
      </span>
    )}
  </div>
);
