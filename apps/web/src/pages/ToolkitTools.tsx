// A toolkit's tool list (#208, ADR 0037, ADR 0038): every tool its source lists, by the full name clients call it by,
// with its class, its price and what its flags say (renamed, hidden, shortened, a name clash, gone upstream,
// deprecated). The toolkit's managers edit a tool's override in place (hide it, rename it, describe it, set its class,
// and for an org toolkit its own price per call, #209) or reset it, and list its tools again now. A tool's row says
// whether its calls wait for approval; the rules are set on the toolkit's Approvals section.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { RefreshCw } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import type { ToolClass, ToolkitView, ToolView } from "@commissary/contract/tools";
import { overrideToolAtom, refreshToolkitAtom, TOOLKITS, toolkitToolsAtom } from "../api/client.ts";
import { kit, Problem, Section } from "../components/Kit.tsx";
import { failureMessage } from "../lib/failure.ts";
import { type ApproverDirectory, approvalOfTool, approverText } from "../lib/approval-rules.ts";
import { formatDate } from "../lib/format.ts";
import {
  draftOfTool,
  type OverrideDraft,
  overrideBody,
  overrideRevision,
  resetBody,
  toolNameProblem,
  toolNotes,
} from "../lib/tool-list.ts";
import { priceProblem, toolPriceText, toolsTakePrices } from "../lib/tool-prices.ts";
import { toolCountText } from "../lib/tool-scope.ts";
import { problemOf } from "../lib/toolkits.ts";
import { useAction } from "../lib/use-action.ts";
import { FlagText } from "./ToolkitFlags.tsx";
import { SpecField } from "./ToolkitFields.tsx";
import styles from "./Tools.module.css";

const CLASS_LABELS: Readonly<Record<ToolClass, string>> = { read: "Read", write: "Write" };

const isClass = (value: string): value is ToolClass => value === "read" || value === "write";

/** The override editor of one tool, in a row under it. */
const ToolEditor = ({
  toolkit,
  tool,
  onClose,
}: {
  readonly toolkit: ToolkitView;
  readonly tool: ToolView;
  readonly onClose: () => void;
}) => {
  const ids = useId();
  const override = useAction(overrideToolAtom);
  const [draft, setDraft] = useState<OverrideDraft>(() => draftOfTool(tool));
  const [nameProblem, setNameProblem] = useState<string | undefined>(undefined);
  const [priceIssue, setPriceIssue] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const send = async (body: ReturnType<typeof overrideBody>) => {
    setProblem(undefined);

    const outcome = await override.run({
      params: { id: toolkit.id },
      headers: { "if-match": String(overrideRevision(tool)) },
      payload: body,
      reactivityKeys: TOOLKITS,
    });

    if (outcome.ok) {
      onClose();

      return;
    }

    const said = problemOf(outcome);

    if (outcome.error === "name_taken") setNameProblem(said);
    else setProblem(said);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const badName = toolNameProblem(draft.name, toolkit.name);

    const badPrice = toolsTakePrices(toolkit) ? priceProblem(draft.price) : undefined;

    setNameProblem(badName);
    setPriceIssue(badPrice);

    if (badName === undefined && badPrice === undefined) void send(overrideBody(tool, draft));
  };

  return (
    <form className={styles["edit"]} onSubmit={submit} noValidate aria-label={`Edit ${tool.name}`}>
      <label className={styles["check"]}>
        <input
          type="checkbox"
          checked={draft.hidden}
          onChange={(event) => setDraft({ ...draft, hidden: event.target.checked })}
        />
        Hidden: clients do not see it, whatever the tool grants say
      </label>
      <div className={styles["editFields"]}>
        <SpecField
          spec={{
            key: "name",
            label: "Name",
            secret: false,
            optional: true,
            hint: `After ${toolkit.name}_. Empty: ${tool.upstream_name}, as its source names it.`,
          }}
          value={draft.name}
          problem={nameProblem}
          onChange={(name) => setDraft({ ...draft, name })}
        />
        <div className={styles["field"]}>
          <label className={kit["fieldLabel"]} htmlFor={`${ids}-class`}>
            Class
          </label>
          <select
            id={`${ids}-class`}
            className={kit["input"]}
            value={draft.class}
            onChange={(event) =>
              setDraft({ ...draft, class: isClass(event.target.value) ? event.target.value : "" })
            }
          >
            <option value="">As its source says</option>
            <option value="read">Read: it only reads</option>
            <option value="write">Write: it changes something</option>
          </select>
        </div>
        {toolsTakePrices(toolkit) ? (
          <SpecField
            spec={{
              key: "price",
              label: "Price per call (USD)",
              secret: false,
              optional: true,
              hint: "Wins over the toolkit's price for this tool; 0 makes it free. Empty: the toolkit's.",
            }}
            value={draft.price}
            problem={priceIssue}
            onChange={(price) => setDraft({ ...draft, price })}
          />
        ) : null}
        <SpecField
          spec={{
            key: "description",
            label: "Description",
            secret: false,
            optional: true,
            multiline: true,
            hint: "What the model reads to choose the tool. Empty: its source's.",
          }}
          value={draft.description}
          problem={undefined}
          onChange={(description) => setDraft({ ...draft, description })}
        />
      </div>
      {problem === undefined ? null : <Problem>{problem}</Problem>}
      <div className={styles["actions"]}>
        <button
          type="submit"
          className={kit["primary"]}
          disabled={override.busy}
          aria-busy={override.busy}
        >
          {override.busy ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className={kit["secondary"]}
          disabled={override.busy}
          onClick={onClose}
        >
          Cancel
        </button>
        {tool.override === undefined ? null : (
          <button
            type="button"
            className={styles["linkButton"]}
            disabled={override.busy}
            onClick={() => void send(resetBody(tool))}
          >
            Reset to its source
          </button>
        )}
      </div>
    </form>
  );
};

const ToolRow = ({
  toolkit,
  tool,
  manage,
  editing,
  directory,
  onEdit,
}: {
  readonly toolkit: ToolkitView;
  readonly tool: ToolView;
  readonly directory: ApproverDirectory | undefined;
  readonly manage: boolean;
  readonly editing: boolean;
  readonly onEdit: (editing: boolean) => void;
}) => {
  const notes = toolNotes(tool);
  const shown = !tool.flags.hidden && !tool.flags.clash && !tool.flags.missing;
  const approval = approvalOfTool(toolkit.approval_rules, tool);
  const price = toolPriceText(tool);

  return (
    <>
      <tr>
        <td>
          <div className={styles["lines"]}>
            <code className={`${styles["toolName"]} ${shown ? "" : styles["hidden"]}`}>
              {tool.name}
            </code>
            {tool.flags.renamed ? (
              <span className={styles["secondary"]}>Renamed from {tool.upstream_name}</span>
            ) : null}
            {tool.description === undefined ? null : (
              <span className={styles["serviceAbout"]}>{tool.description}</span>
            )}
            {notes.map((note) => (
              <FlagText key={note.text} flag={note} />
            ))}
            {approval === undefined ? null : (
              <span className={styles["secondary"]}>
                Calls wait for approval from {approverText(approval.approver, directory)}
                {approval.because === "writes" ? ", as a write tool" : ", marked"}
              </span>
            )}
          </div>
        </td>
        <td>{CLASS_LABELS[tool.class]}</td>
        <td className={`${styles["number"]} ${styles["wide"]}`}>
          {price.text}
          {price.own ? <span className={styles["secondary"]}>its own</span> : null}
        </td>
        {manage ? (
          <td className={styles["number"]}>
            <button
              type="button"
              className={styles["linkButton"]}
              aria-expanded={editing}
              onClick={() => onEdit(!editing)}
            >
              {editing ? "Close" : "Edit"}
              <span className={kit["visuallyHidden"]}> {tool.name}</span>
            </button>
          </td>
        ) : null}
      </tr>
      {editing ? (
        <tr className={styles["editRow"]}>
          <td colSpan={manage ? 4 : 3}>
            <ToolEditor toolkit={toolkit} tool={tool} onClose={() => onEdit(false)} />
          </td>
        </tr>
      ) : null}
    </>
  );
};

/** When the list was built, how many tools it holds, and why the last build failed. */
const listText = (toolkit: ToolkitView, count: number): string => {
  const built = toolkit.tool_list.built_at;

  if (built === undefined) return "Not listed yet.";

  return `${toolCountText(count)}, listed ${formatDate(Date.parse(built))}.`;
};

/** The section with the list, listing it again, and an editor for each tool. */
export const ToolList = ({
  toolkit,
  manage,
  refresh,
  directory,
}: {
  readonly toolkit: ToolkitView;
  /** The members and teams, to name approvers: org admins have them. */
  readonly directory?: ApproverDirectory | undefined;
  /** Edit the tools' overrides. */
  readonly manage: boolean;
  /** Build the list now. */
  readonly refresh: boolean;
}) => {
  const result = useAtomValue(toolkitToolsAtom(toolkit.id));
  const retry = useAtomRefresh(toolkitToolsAtom(toolkit.id));
  const build = useAction(refreshToolkitAtom);
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const rebuild = async () => {
    setProblem(undefined);
    const outcome = await build.run({ params: { id: toolkit.id }, reactivityKeys: TOOLKITS });

    setProblem(problemOf(outcome));
  };

  return (
    <Section
      title="Tools"
      className={styles["section"]}
      aside={
        refresh ? (
          <button
            type="button"
            className={kit["secondary"]}
            disabled={build.busy}
            aria-busy={build.busy}
            onClick={() => void rebuild()}
          >
            <RefreshCw
              aria-hidden="true"
              size={16}
              strokeWidth={2.25}
              className={build.busy ? kit["spinning"] : undefined}
            />
            {build.busy ? "Listing…" : "List again"}
          </button>
        ) : undefined
      }
    >
      {problem === undefined ? null : <Problem>Listing failed. {problem}</Problem>}
      {AsyncResult.match(result, {
        onInitial: () => (
          <p className={kit["muted"]} aria-busy="true">
            Loading its tools…
          </p>
        ),
        onFailure: (failure) => (
          <Problem onRetry={retry}>Could not load its tools. {failureMessage(failure)}</Problem>
        ),
        onSuccess: ({ value }) => (
          <>
            <p className={styles["lead"]}>
              {listText(toolkit, value.tools.length)} Commissary lists them again on a schedule.
              {manage
                ? " An edit stays across those listings, keyed to the tool's name at its source."
                : ""}
            </p>
            {value.tool_list.error === undefined ? null : (
              <FlagText
                flag={{ text: `Listing failed: ${value.tool_list.error}`, severity: "failing" }}
              />
            )}
            {value.tools.length === 0 ? null : (
              <div className={styles["scroll"]}>
                <table className={styles["table"]}>
                  <thead>
                    <tr>
                      <th scope="col">Tool</th>
                      <th scope="col">Class</th>
                      <th scope="col" className={`${styles["number"]} ${styles["wide"]}`}>
                        Per call
                      </th>
                      {manage ? (
                        <th scope="col" className={styles["number"]}>
                          <span className={kit["visuallyHidden"]}>Edit</span>
                        </th>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody>
                    {value.tools.map((tool) => (
                      <ToolRow
                        key={tool.id}
                        toolkit={toolkit}
                        tool={tool}
                        manage={manage}
                        editing={editing === tool.id}
                        directory={directory}
                        onEdit={(open) => setEditing(open ? tool.id : undefined)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ),
      })}
    </Section>
  );
};
