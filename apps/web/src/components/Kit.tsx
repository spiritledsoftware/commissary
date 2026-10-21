// Page pieces shared by every page: a section with its heading, and the load-problem line with its retry.
import type { ReactNode } from "react";
import { TrailMark } from "./Signs.tsx";
import kit from "./Kit.module.css";

export { kit };

export const Section = ({
  title,
  aside,
  children,
  className,
  id,
}: {
  readonly title: string;
  readonly id?: string | undefined;
  readonly aside?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string | undefined;
}) => (
  <section id={id} className={className} aria-label={title}>
    <header className={kit["sectionHead"]}>
      <h2 className={kit["sectionTitle"]}>{title}</h2>
      {aside}
    </header>
    {children}
  </section>
);

/** Something failed: the red trail mark, what happened, and how to recover. */
export const Problem = ({
  children,
  onRetry,
  retryLabel = "Try again",
}: {
  readonly children: ReactNode;
  readonly onRetry?: () => void;
  readonly retryLabel?: string;
}) => (
  <div className={kit["problem"]} role="alert">
    <TrailMark />
    <p>{children}</p>
    {onRetry === undefined ? null : (
      <button type="button" className={kit["secondary"]} onClick={onRetry}>
        {retryLabel}
      </button>
    )}
  </div>
);

/** Numbered steps like stages on a route (DESIGN.md "Steps"): each a `Step` with its title and content under it. */
export const Steps = ({ children }: { readonly children: ReactNode }) => (
  <ol className={kit["steps"]}>{children}</ol>
);

export const Step = ({
  title,
  children,
}: {
  readonly title: string;
  readonly children?: ReactNode;
}) => (
  <li className={kit["step"]}>
    <h3 className={kit["stepTitle"]}>{title}</h3>
    {children}
  </li>
);
