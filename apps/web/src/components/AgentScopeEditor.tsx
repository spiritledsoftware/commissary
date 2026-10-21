// The tool scope of a hosted agent (#233, ADR 0040): per toolkit none, all its tools, its read tools or tools picked one by
// one, and for the agents toolkit which agents it may run. It is the API key editor's model (`lib/tool-scope.ts`, #200)
// without its "every tool" mode, as an agent's scope names what it may use and `[]` is nothing; the toolkits are the
// org's (and, for a private agent, its member's own), whose tools are read when a toolkit's tools are picked by hand.
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { type ReactNode, useId, useState } from "react";
import { AGENTS_TOOLKIT } from "@commissary/contract/api-keys";
import type { UsableAgent } from "@commissary/contract/agents";
import type { ToolkitView } from "@commissary/contract/tools";
import { toolkitToolsAtom } from "../api/client.ts";
import type { AgentsDraft } from "../lib/agent-form.ts";
import { writeToolsText } from "../lib/agent-notice.ts";
import {
  pickOf,
  type ScopeDraft,
  setChoice,
  TOOLKIT_CHOICES,
  type ToolkitChoice,
  toggleTool,
} from "../lib/tool-scope.ts";
import { kit } from "./Kit.tsx";
import styles from "./AgentScopeEditor.module.css";

/** The tools of a toolkit, to pick from by hand: checkboxes with each tool's class, and a search past a dozen. */
const ToolPicker = ({
  toolkit,
  chosen,
  onToggle,
}: {
  readonly toolkit: ToolkitView;
  readonly chosen: ReadonlyArray<string>;
  readonly onToggle: (tool: string) => void;
}) => {
  const id = useId();
  const [query, setQuery] = useState("");
  const result = useAtomValue(toolkitToolsAtom(toolkit.id));

  if (AsyncResult.isFailure(result))
    return <p className={kit["muted"]}>Could not read this toolkit&rsquo;s tools.</p>;

  if (!AsyncResult.isSuccess(result))
    return (
      <p className={kit["muted"]} aria-busy="true">
        Loading its tools…
      </p>
    );

  const listed = result.value.tools.filter((tool) => !tool.flags.hidden && !tool.flags.clash);

  const needle = query.trim().toLowerCase();

  const shown =
    needle === "" ? listed : listed.filter((tool) => tool.name.toLowerCase().includes(needle));

  // Tools the scope names that the list no longer has stay in view, so saving can drop them.
  const gone = chosen.filter((tool) => !listed.some((each) => each.id === tool));

  return (
    <div className={styles["picker"]}>
      {listed.length > 12 ? (
        <>
          <label className={kit["visuallyHidden"]} htmlFor={`${id}-search`}>
            Search the tools of {toolkit.name}
          </label>
          <input
            id={`${id}-search`}
            className={kit["input"]}
            type="search"
            placeholder="Search tools"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </>
      ) : null}
      <ul className={styles["tools"]} aria-label={`Tools of ${toolkit.name}`}>
        {gone.map((tool) => (
          <li key={tool}>
            <label className={styles["check"]}>
              <input type="checkbox" checked onChange={() => onToggle(tool)} />
              <span className={styles["toolName"]}>{tool.slice(tool.indexOf(":") + 1)}</span>
              <span className={kit["muted"]}>gone: uncheck to drop it</span>
            </label>
          </li>
        ))}
        {shown.map((tool) => (
          <li key={tool.id}>
            <label className={styles["check"]}>
              <input
                type="checkbox"
                checked={chosen.includes(tool.id)}
                onChange={() => onToggle(tool.id)}
              />
              <span className={styles["toolName"]}>{tool.name}</span>
              <span className={kit["muted"]}>{tool.class}</span>
            </label>
          </li>
        ))}
        {shown.length === 0 && gone.length === 0 ? (
          <li className={kit["muted"]}>
            {listed.length === 0 ? "This toolkit lists no tools yet." : "No tool matches."}
          </li>
        ) : null}
      </ul>
    </div>
  );
};

/** Which agents the agents toolkit's entry may run: any within reach, or only those picked. */
const AgentPicker = ({
  agents,
  usable,
  onChange,
  invalid,
}: {
  readonly agents: AgentsDraft;
  readonly usable: ReadonlyArray<UsableAgent>;
  readonly onChange: (agents: AgentsDraft) => void;
  readonly invalid: boolean;
}) => {
  const id = useId();

  return (
    <fieldset className={styles["agents"]} aria-invalid={invalid}>
      <legend className={kit["fieldLabel"]}>Agents it may run</legend>
      <label className={styles["check"]}>
        <input
          type="radio"
          name={`${id}-mode`}
          checked={!agents.limited}
          onChange={() => onChange({ ...agents, limited: false })}
        />
        Any agent within its reach
      </label>
      <label className={styles["check"]}>
        <input
          type="radio"
          name={`${id}-mode`}
          checked={agents.limited}
          onChange={() => onChange({ ...agents, limited: true })}
        />
        Only the agents picked below
      </label>
      {agents.limited ? (
        <ul className={styles["tools"]} aria-label="Agents it may run">
          {usable.map((agent) => (
            <li key={agent.id}>
              <label className={styles["check"]}>
                <input
                  type="checkbox"
                  checked={agents.ids.includes(agent.id)}
                  onChange={() =>
                    onChange({
                      ...agents,
                      ids: agents.ids.includes(agent.id)
                        ? agents.ids.filter((each) => each !== agent.id)
                        : [...agents.ids, agent.id],
                    })
                  }
                />
                <span className={styles["toolName"]}>{agent.name}</span>
                <span className={kit["muted"]}>{agent.private ? "private" : "shared"}</span>
              </label>
            </li>
          ))}
          {usable.length === 0 ? (
            <li className={kit["muted"]}>No other agent is in its reach yet.</li>
          ) : null}
        </ul>
      ) : null}
    </fieldset>
  );
};

export const AgentScopeEditor = ({
  toolkits,
  draft,
  onChange,
  agents,
  onAgentsChange,
  usableAgents,
  uncovered,
  disabled = false,
  invalid = false,
  describedBy,
}: {
  /** The toolkits the agent may name: the org's (and a private agent's member's own). */
  readonly toolkits: ReadonlyArray<ToolkitView>;
  readonly draft: ScopeDraft;
  readonly onChange: (draft: ScopeDraft) => void;
  readonly agents: AgentsDraft;
  readonly onAgentsChange: (agents: AgentsDraft) => void;
  /** The agents the agents toolkit's entry may name: not the agent itself. */
  readonly usableAgents: ReadonlyArray<UsableAgent>;
  /** Write tools with no approval rule, by toolkit id, while the notice on an unattended agent shows. */
  readonly uncovered?: ReadonlyMap<string, number> | undefined;
  readonly disabled?: boolean;
  readonly invalid?: boolean;
  readonly describedBy?: string | undefined;
}): ReactNode => {
  const ids = useId();

  return (
    <fieldset
      className={styles["editor"]}
      disabled={disabled}
      aria-invalid={invalid}
      aria-describedby={describedBy}
    >
      <legend className={kit["fieldLabel"]}>Tools it may use</legend>
      {toolkits.length === 0 ? (
        <p className={kit["muted"]}>
          No toolkit is there to give it yet. An org admin adds toolkits on the Tools page.
        </p>
      ) : (
        <ul className={styles["toolkits"]}>
          {toolkits.map((toolkit) => {
            const pick = pickOf(draft, toolkit.id);
            const open = uncovered?.get(toolkit.id);

            return (
              <li key={toolkit.id} className={styles["toolkit"]}>
                <div className={styles["toolkitHead"]}>
                  <label className={styles["toolkitName"]} htmlFor={`${ids}-${toolkit.id}`}>
                    {toolkit.name}
                    {toolkit.private ? <span className={kit["muted"]}> · yours</span> : null}
                  </label>
                  <select
                    id={`${ids}-${toolkit.id}`}
                    className={`${kit["input"]} ${styles["choice"]}`}
                    value={pick.choice}
                    onChange={(event) =>
                      onChange(
                        setChoice(
                          draft,
                          toolkit.id,
                          TOOLKIT_CHOICES.find((entry) => entry.id === event.target.value)?.id ??
                            ("none" satisfies ToolkitChoice),
                        ),
                      )
                    }
                  >
                    {TOOLKIT_CHOICES.map((choice) => (
                      <option key={choice.id} value={choice.id}>
                        {choice.label}
                      </option>
                    ))}
                  </select>
                </div>
                {open === undefined ? null : (
                  <p className={styles["open"]}>
                    {writeToolsText(open)} here ask no one&rsquo;s approval.{" "}
                    <Link to="/tools/$toolkitId" params={{ toolkitId: toolkit.id }}>
                      Toolkit page
                    </Link>
                  </p>
                )}
                {pick.choice === "named" ? (
                  <ToolPicker
                    toolkit={toolkit}
                    chosen={pick.ids}
                    onToggle={(tool) => onChange(toggleTool(draft, toolkit.id, tool))}
                  />
                ) : null}
                {toolkit.id === AGENTS_TOOLKIT && pick.choice !== "none" ? (
                  <AgentPicker
                    agents={agents}
                    usable={usableAgents}
                    onChange={onAgentsChange}
                    invalid={invalid}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </fieldset>
  );
};
