// The tool scope editor (#200): every tool the member may use, or only some, per toolkit none, all, its read tools or
// tools picked one by one. Used when an API key is created or edited and on the consent page of an MCP client's sign-in.
// The model is `lib/tool-scope.ts`; this only draws it.
import { useId } from "react";
import type { UsableTools } from "@commissary/contract/tools";
import {
  draftSummary,
  hasTools,
  pickOf,
  type ScopeDraft,
  setChoice,
  setLimited,
  TOOLKIT_CHOICES,
  type ToolkitChoice,
  toggleTool,
} from "../lib/tool-scope.ts";
import { kit } from "./Kit.tsx";
import styles from "./ToolScopeEditor.module.css";

export const ToolScopeEditor = ({
  usable,
  draft,
  onChange,
  disabled = false,
  subject = "The key",
}: {
  readonly usable: UsableTools;
  readonly draft: ScopeDraft;
  readonly onChange: (draft: ScopeDraft) => void;
  readonly disabled?: boolean;
  /** Who the scope binds, as the first words of the choices ("The key", "The app"). */
  readonly subject?: string;
}) => {
  const ids = useId();

  return (
    <fieldset className={styles["editor"]} disabled={disabled}>
      <legend className={kit["fieldLabel"]}>Tools</legend>
      <div className={styles["modes"]}>
        <label className={styles["check"]}>
          <input
            type="radio"
            name={`${ids}-mode`}
            checked={!draft.limited}
            onChange={() => onChange(setLimited(draft, false))}
          />
          {subject} may use every tool you may use
        </label>
        <label className={styles["check"]}>
          <input
            type="radio"
            name={`${ids}-mode`}
            checked={draft.limited}
            disabled={!hasTools(usable)}
            onChange={() => onChange(setLimited(draft, true))}
          />
          Only the tools picked below
        </label>
      </div>
      {draft.limited ? (
        <ul className={styles["toolkits"]}>
          {usable.toolkits.map((toolkit) => {
            const pick = pickOf(draft, toolkit.id);

            return (
              <li key={toolkit.id} className={styles["toolkit"]}>
                <div className={styles["toolkitHead"]}>
                  <label className={styles["toolkitName"]} htmlFor={`${ids}-${toolkit.id}`}>
                    {toolkit.name}
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
                {pick.choice === "named" ? (
                  <ul className={styles["tools"]} aria-label={`Tools of ${toolkit.name}`}>
                    {toolkit.tools.map((tool) => (
                      <li key={tool.id}>
                        <label className={styles["check"]}>
                          <input
                            type="checkbox"
                            checked={pick.ids.includes(tool.id)}
                            onChange={() => onChange(toggleTool(draft, toolkit.id, tool.id))}
                          />
                          <span className={styles["toolName"]}>{tool.name}</span>
                          {tool.tool_class === "read" ? (
                            <span className={kit["muted"]}>read</span>
                          ) : null}
                        </label>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <p className={kit["muted"]} role="status">
        {hasTools(usable)
          ? draftSummary(draft, usable)
          : "You may use no tools yet: an org admin adds toolkits and grants them."}
      </p>
    </fieldset>
  );
};
