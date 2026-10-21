// A toolkit's approval rules on its page (#209, #201, ADR 0038, GLOSSARY "Approval rule", "Approver"): the "write tools
// require approval" switch, marks on single tools and each rule's approver: the caller (the default), a team, or a list
// of members. Org admins edit them on any org toolkit, a member on their own private toolkit only, and a member can
// name only the caller as approver, as the panel has no member or team list for them. A call under a rule waits on the
// Approvals page. The rules are written whole, with the toolkit's revision in `If-Match`.
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { Plus, X } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import type { ToolkitView } from "@commissary/contract/tools";
import { TOOLKITS, toolkitToolsAtom, updateToolkitAtom } from "../api/client.ts";
import { kit, Problem, Section } from "../components/Kit.tsx";
import {
  APPROVER_LABELS,
  type ApproverDirectory,
  type ApproverDraft,
  approverKindsFor,
  type ApproverKind,
  draftOfRules,
  ELSEWHERE_LABELS,
  hasRulesErrors,
  knownRules,
  markableTools,
  markRows,
  type RulesDraft,
  rulesBody,
  sameRules,
  validateRules,
  withMark,
  withMarkApprover,
  withoutMark,
  writeToolCount,
} from "../lib/approval-rules.ts";
import { approvalRulesWarnings } from "../lib/approvals.ts";
import { problemOf } from "../lib/toolkits.ts";
import { useAction } from "../lib/use-action.ts";
import { directoryOf, WithApproverDirectory } from "./ApproverDirectory.tsx";
import { Flags } from "./ToolkitFlags.tsx";
import styles from "./Tools.module.css";

const isKind = (value: string): value is ApproverKind =>
  value === "caller" || value === "team" || value === "members";

/** Who approves a rule's calls: a kind, then the team or the members it takes. */
const ApproverField = ({
  label,
  value,
  admin,
  directory,
  problem,
  onChange,
}: {
  readonly label: string;
  readonly value: ApproverDraft;
  readonly admin: boolean;
  /** The members and teams to choose from: only an org admin has them. */
  readonly directory: ApproverDirectory | undefined;
  readonly problem: string | undefined;
  readonly onChange: (value: ApproverDraft) => void;
}) => {
  const id = useId();
  const kinds = approverKindsFor(admin);
  // A rule an API call gave a team or members, read by someone who may name only the caller: shown, not choosable.
  const elsewhere = kinds.includes(value.kind) ? undefined : value.kind;

  return (
    <div className={styles["approver"]}>
      <div className={styles["field"]}>
        <label className={kit["fieldLabel"]} htmlFor={`${id}-kind`}>
          {label}
        </label>
        <select
          id={`${id}-kind`}
          className={kit["input"]}
          value={value.kind}
          disabled={kinds.length === 1 && elsewhere === undefined}
          onChange={(event) => {
            if (isKind(event.target.value))
              onChange({ kind: event.target.value, teamId: "", memberIds: [] });
          }}
        >
          {kinds.map((kind) => (
            <option key={kind} value={kind}>
              {APPROVER_LABELS[kind]}
            </option>
          ))}
          {elsewhere === undefined ? null : (
            <option value={elsewhere} disabled>
              {ELSEWHERE_LABELS[elsewhere]}
            </option>
          )}
        </select>
      </div>
      {directory !== undefined && value.kind === "team" ? (
        <div className={styles["field"]}>
          <label className={kit["fieldLabel"]} htmlFor={`${id}-team`}>
            Team
          </label>
          <select
            id={`${id}-team`}
            className={kit["input"]}
            value={value.teamId}
            aria-invalid={problem !== undefined}
            aria-describedby={`${id}-note`}
            onChange={(event) => onChange({ ...value, teamId: event.target.value })}
          >
            <option value="">Choose…</option>
            {directory.teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {directory !== undefined && value.kind === "members" ? (
        <fieldset className={styles["memberPicks"]} aria-describedby={`${id}-note`}>
          <legend className={kit["fieldLabel"]}>Members</legend>
          {directory.members.map((member) => (
            <label key={member.id} className={styles["check"]}>
              <input
                type="checkbox"
                checked={value.memberIds.includes(member.id)}
                onChange={(event) =>
                  onChange({
                    ...value,
                    memberIds: event.target.checked
                      ? [...value.memberIds, member.id]
                      : value.memberIds.filter((each) => each !== member.id),
                  })
                }
              />
              {member.email}
            </label>
          ))}
        </fieldset>
      ) : null}
      <span
        id={`${id}-note`}
        className={problem === undefined ? styles["hint"] : kit["fieldError"]}
      >
        {problem ?? ""}
      </span>
    </div>
  );
};

const Marks = ({
  toolkit,
  draft,
  admin,
  directory,
  errors,
  onChange,
}: {
  readonly toolkit: ToolkitView;
  readonly draft: RulesDraft;
  readonly admin: boolean;
  readonly directory: ApproverDirectory | undefined;
  readonly errors: Readonly<Record<string, string>>;
  readonly onChange: (draft: RulesDraft) => void;
}) => {
  const id = useId();
  const [query, setQuery] = useState("");
  const result = useAtomValue(toolkitToolsAtom(toolkit.id));
  const tools = AsyncResult.isSuccess(result) ? result.value.tools : undefined;
  const rows = markRows(draft, tools);
  const options = markableTools(tools ?? [], draft);

  const add = () => {
    const typed = query.trim().toLowerCase();
    const tool = options.find((each) => each.name.toLowerCase() === typed);

    if (tool === undefined) return;

    onChange(withMark(draft, tool.id));
    setQuery("");
  };

  return (
    <div className={styles["marks"]}>
      <h3 className={styles["slotTitle"]}>Marked tools</h3>
      <p className={styles["hint"]}>
        A call of a marked tool waits for approval whatever its class, and has its own approver.
      </p>
      {rows.length === 0 ? null : (
        <ul className={styles["markList"]} aria-label="Marked tools">
          {rows.map((row) => (
            <li key={row.id} className={styles["mark"]}>
              <div className={styles["markName"]}>
                <code className={styles["toolName"]}>{row.name}</code>
                <span className={styles["hint"]}>
                  {row.missing
                    ? "its source no longer lists it"
                    : row.toolClass === "write"
                      ? "write"
                      : row.toolClass === "read"
                        ? "read"
                        : ""}
                </span>
                <button
                  type="button"
                  className={styles["linkButton"]}
                  aria-label={`Remove the mark on ${row.name}`}
                  onClick={() => onChange(withoutMark(draft, row.id))}
                >
                  <X aria-hidden="true" size={16} strokeWidth={2.25} />
                </button>
              </div>
              <ApproverField
                label={`Approver of ${row.name}`}
                value={row.approver}
                admin={admin}
                directory={directory}
                problem={errors[row.id]}
                onChange={(approver) => onChange(withMarkApprover(draft, row.id, approver))}
              />
            </li>
          ))}
        </ul>
      )}
      <div className={styles["markAdd"]}>
        <div className={styles["field"]}>
          <label className={kit["fieldLabel"]} htmlFor={`${id}-tool`}>
            Mark a tool
          </label>
          <input
            id={`${id}-tool`}
            className={kit["input"]}
            list={`${id}-tools`}
            autoComplete="off"
            spellCheck={false}
            placeholder={tools === undefined ? "Loading its tools…" : "Type a tool's name"}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                add();
              }
            }}
          />
          <datalist id={`${id}-tools`}>
            {options.map((tool) => (
              <option key={tool.id} value={tool.name} />
            ))}
          </datalist>
        </div>
        <button type="button" className={kit["secondary"]} onClick={add}>
          <Plus aria-hidden="true" size={16} strokeWidth={2.25} />
          Mark
        </button>
      </div>
    </div>
  );
};

const Editor = ({
  toolkit,
  admin,
  directory,
}: {
  readonly toolkit: ToolkitView;
  readonly admin: boolean;
  /** The members and teams to choose approvers from: only an org admin has them. */
  readonly directory: ApproverDirectory | undefined;
}) => {
  const update = useAction(updateToolkitAtom);
  const start = draftOfRules(toolkit.approval_rules);

  // An approver the org no longer has (a deleted team, members who left) starts unchosen, so a save cannot send it.
  const [draft, setDraft] = useState<RulesDraft>(
    directory === undefined ? start : knownRules(start, directory),
  );

  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [saved, setSaved] = useState(false);
  const [tried, setTried] = useState(false);
  const result = useAtomValue(toolkitToolsAtom(toolkit.id));
  const errors = validateRules(draft);
  const shown = tried ? errors : { marks: {} };
  const changed = !sameRules(draft, start);
  const writes = AsyncResult.isSuccess(result) ? writeToolCount(result.value.tools) : undefined;

  const change = (next: RulesDraft) => {
    setDraft(next);
    setSaved(false);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(undefined);
    setSaved(false);
    setTried(true);

    if (hasRulesErrors(errors) || !changed) return;

    const outcome = await update.run({
      params: { id: toolkit.id },
      headers: { "if-match": String(toolkit.revision) },
      payload: { approval_rules: rulesBody(draft) },
      reactivityKeys: TOOLKITS,
    });

    if (outcome.ok) {
      setSaved(true);
      setTried(false);
    } else setProblem(problemOf(outcome) ?? outcome.message);
  };

  return (
    <form className={styles["form"]} onSubmit={(event) => void submit(event)} noValidate>
      <label className={styles["check"]}>
        <input
          type="checkbox"
          checked={draft.writes}
          onChange={(event) => change({ ...draft, writes: event.target.checked })}
        />
        Write tools require approval
      </label>
      <p className={styles["hint"]}>
        {draft.writes
          ? writes === undefined
            ? "A call of any tool that changes something waits for approval."
            : `A call of any of its ${writes} write ${writes === 1 ? "tool" : "tools"} waits for approval, and a tool you reclassify follows its new class at once.`
          : "Off: its write tools run as soon as they are called."}
      </p>
      {draft.writes ? (
        <ApproverField
          label="Approver of write tools"
          value={draft.writesApprover}
          admin={admin}
          directory={directory}
          problem={shown.writes}
          onChange={(writesApprover) => change({ ...draft, writesApprover })}
        />
      ) : null}
      <Marks
        toolkit={toolkit}
        draft={draft}
        admin={admin}
        directory={directory}
        errors={shown.marks}
        onChange={change}
      />
      {problem === undefined ? null : <Problem>{problem}</Problem>}
      <div className={styles["actions"]}>
        <button
          type="submit"
          className={kit["primary"]}
          disabled={update.busy || !changed}
          aria-busy={update.busy}
        >
          {update.busy ? "Saving…" : "Save rules"}
        </button>
        {saved ? (
          <span className={styles["note"]} role="status">
            Saved.
          </span>
        ) : null}
      </div>
    </form>
  );
};

export const ToolkitApprovals = ({
  toolkit,
  admin,
}: {
  readonly toolkit: ToolkitView;
  readonly admin: boolean;
}) => {
  const warnings =
    toolkit.approval_rules === undefined ? [] : approvalRulesWarnings(toolkit.approval_rules);

  return (
    <Section
      title="Approvals"
      id="approvals"
      className={styles["section"]}
      aside={
        <Link to="/approvals" className={styles["linkButton"]}>
          Pending approvals
        </Link>
      }
    >
      <p className={styles["lead"]}>
        {admin
          ? "A call under a rule waits for an approver, who answers on the Approvals page or when the client asks. The approver is the caller unless you choose a team or members, who cannot approve a call they made themselves."
          : "A call of your own toolkit under a rule waits for you to approve it, on the Approvals page or when your client asks."}
      </p>
      <Flags
        flags={warnings.map((text) => ({ text, severity: "failing" as const }))}
        label="Rules nobody can approve under"
      />
      <WithApproverDirectory admin={admin}>
        {(state) => {
          if (state.state === "loading")
            return (
              <p className={kit["muted"]} aria-busy="true">
                Loading the members and teams…
              </p>
            );

          if (state.state === "failed")
            return (
              <Problem>Could not load the members and teams to choose approvers from.</Problem>
            );

          return (
            <Editor
              key={toolkit.revision}
              toolkit={toolkit}
              admin={admin}
              directory={directoryOf(state)}
            />
          );
        }}
      </WithApproverDirectory>
    </Section>
  );
};
