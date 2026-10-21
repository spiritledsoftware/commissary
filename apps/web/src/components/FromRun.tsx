// The link from an approval's or a browser session's page to the hosted agent run whose call it is (#234): the run's
// page decides who sees the run, so the link adds no rule of its own.
import { Link } from "@tanstack/react-router";
import { fromRunLink } from "../lib/agent-runs.ts";
import { kit } from "./Kit.tsx";

export const FromRun = ({ view }: { readonly view: { readonly run?: string | undefined } }) => {
  const link = fromRunLink(view);

  if (link === undefined) return null;

  return (
    <p className={kit["muted"]}>
      <Link to="/agent-runs/$runId" params={{ runId: link.runId }}>
        {link.text} <span aria-hidden="true">→</span>
      </Link>
    </p>
  );
};
