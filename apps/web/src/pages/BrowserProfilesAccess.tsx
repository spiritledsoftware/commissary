// Who may use a shared browser profile (#217): the list of subjects an org admin ticks, in the create form and in a
// shared profile's editor. Nothing is ticked for a new profile; the members and teams come from the Members page's reads,
// which only org admins have.
import type { ApproverDirectory } from "../lib/approval-rules.ts";
import styles from "./BrowserProfiles.module.css";
import tools from "./Tools.module.css";

/** The subjects of `directory` as a checklist: everyone, then each team, then each member. */
export const AccessPicker = ({
  directory,
  chosen,
  onToggle,
  invalid,
  describedBy,
}: {
  readonly directory: ApproverDirectory;
  /** The ticked subjects' form values (`subjectKey`). */
  readonly chosen: ReadonlyArray<string>;
  readonly onToggle: (key: string) => void;
  readonly invalid: boolean;
  readonly describedBy: string;
}) => (
  <fieldset
    className={`${tools["choices"]} ${styles["access"]}`}
    aria-describedby={describedBy}
    data-invalid={invalid}
  >
    <legend>Who may use it</legend>
    <label className={tools["choice"]}>
      <input
        type="checkbox"
        checked={chosen.includes("everyone")}
        aria-invalid={invalid}
        onChange={() => onToggle("everyone")}
      />
      <span className={tools["choiceText"]}>
        Everyone
        <span className={tools["hint"]}>
          Every member of the org, including those who join later.
        </span>
      </span>
    </label>
    {directory.teams.length === 0 ? null : (
      <>
        <p className={styles["subhead"]}>Teams</p>
        <ul className={styles["pickList"]} aria-label="Teams">
          {directory.teams.map((team) => (
            <li key={team.id}>
              <label className={styles["pick"]}>
                <input
                  type="checkbox"
                  checked={chosen.includes(`team:${team.id}`)}
                  onChange={() => onToggle(`team:${team.id}`)}
                />
                <span className={styles["pickName"]}>{team.name}</span>
              </label>
            </li>
          ))}
        </ul>
      </>
    )}
    {directory.members.length === 0 ? null : (
      <>
        <p className={styles["subhead"]}>Members</p>
        <ul className={styles["pickList"]} aria-label="Members">
          {directory.members.map((member) => (
            <li key={member.id}>
              <label className={styles["pick"]}>
                <input
                  type="checkbox"
                  checked={chosen.includes(`member:${member.id}`)}
                  onChange={() => onToggle(`member:${member.id}`)}
                />
                <span className={styles["pickName"]}>{member.email}</span>
              </label>
            </li>
          ))}
        </ul>
      </>
    )}
  </fieldset>
);
