// Model rules (/models/rules): the channel rules of `oauth.model-alias`, `oauth.excluded-models` and `models.write-ins`,
// one section per channel (the provider key of its accounts), with a jump list above. Aliases rename an upstream model for
// clients, optionally keeping the original; exclusions take models away, with a live count of the models a pattern
// matches; write-ins add a model the catalog does not list yet, to the provider's accounts and to its provider keys
// without a model list, and say when the catalog has caught up. Add forms stay closed until asked for and take the
// focus when they open. Each edit is
// a delta saved with the channel entry's revision and re-applied once to a fresh read on 409 (`saveRuleChange`); the
// view refetches after a save, so the Models page shows the effect at once. Provider key and OpenAI-compatible rules live
// on the provider keys page, an account's own rules in its file; this page only points there.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { ArrowLeft, Check, Pencil, Plus, X } from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import type {
  ModelWriteIn,
  OAuthModelAliasWire,
  RoutingModels,
} from "@commissary/contract/routing";
import { routingModelsAtom, saveRuleAtom } from "../api/client.ts";
import { kit, Problem } from "../components/Kit.tsx";
import { failureMessage } from "../lib/failure.ts";
import { formatCount } from "../lib/format.ts";
import {
  type AliasDraft,
  aliasEntry,
  type ChannelRules,
  channelRules,
  exclusionMatches,
  hasAliasErrors,
  hasWriteInErrors,
  type RuleChange,
  ruleProblem,
  validateAlias,
  validateChannel,
  validatePattern,
  validateWriteIn,
  type WriteInDraft,
  writeInEntry,
  writeInState,
} from "../lib/models.ts";
import { providerName } from "../lib/providers.ts";
import { useAction } from "../lib/use-action.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import styles from "./ModelRules.module.css";

/** Provider keys accounts can have on Workers: suggestions when adding a channel no account uses yet. */
const KNOWN_CHANNELS = [
  "aistudio",
  "antigravity",
  "claude",
  "codex",
  "devin",
  "gemini-interactions",
  "kimi",
  "kimi.com",
  "meta",
  "vertex",
  "xai",
];

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${formatCount(count)} ${count === 1 ? one : many}`;

/** What a save did, or why it failed, said under the channel's rules. */
type Note =
  | { readonly tone: "done"; readonly text: string }
  | { readonly tone: "problem"; readonly text: string; readonly stale: boolean };

/** Focus the first field a failed submit marked (the marks render first). */
const focusFirstInvalid = (form: HTMLFormElement) => {
  requestAnimationFrame(() => form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
};

/** Focus the field behind `ref` once, when the form it belongs to opens. */
const useFocusOnOpen = () => {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return ref;
};

/** One channel's saves: the three rule lists, each through its own save atom, reporting into the channel's note. */
const useChannelSave = (channel: string, view: RoutingModels) => {
  const aliases = useAction(saveRuleAtom(`aliases:${channel}`));
  const excluded = useAction(saveRuleAtom(`excluded:${channel}`));
  const writeIns = useAction(saveRuleAtom(`write-ins:${channel}`));
  const [note, setNote] = useState<Note | undefined>(undefined);

  const save = async (change: RuleChange, done: string): Promise<boolean> => {
    setNote(undefined);

    const action = { aliases, excluded, "write-ins": writeIns }[change.rule];
    const outcome = await action.run({ change, base: view });

    if (outcome.ok) {
      setNote({
        tone: "done",
        text: outcome.value === "unchanged" ? `${done} The rules already said so.` : done,
      });

      return true;
    }

    setNote({
      tone: "problem",
      text: ruleProblem(outcome.error, outcome.message),
      stale: outcome.error === "conflict",
    });

    return false;
  };

  return {
    save,
    note,
    busy: { aliases: aliases.busy, excluded: excluded.busy, writeIns: writeIns.busy },
  } as const;
};

type Save = (change: RuleChange, done: string) => Promise<boolean>;

// ---------------------------------------------------------------------------------------------------------------
// Aliases

const AliasForm = ({
  rules,
  editing,
  busy,
  onSave,
  onCancel,
}: {
  readonly rules: ChannelRules;
  readonly editing: OAuthModelAliasWire | undefined;
  readonly busy: boolean;
  readonly onSave: (entry: OAuthModelAliasWire) => Promise<boolean>;
  readonly onCancel: () => void;
}) => {
  const ids = useId();
  const first = useFocusOnOpen();

  const [draft, setDraft] = useState<AliasDraft>({
    name: editing?.name ?? "",
    alias: editing?.alias ?? "",
    fork: editing?.fork ?? false,
  });

  const [tried, setTried] = useState(false);
  const errors = validateAlias(draft, rules.aliases, editing);
  const shown = tried ? errors : {};
  const name = draft.name.trim();
  const alias = draft.alias.trim();

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTried(true);

    if (hasAliasErrors(errors)) return focusFirstInvalid(event.currentTarget);

    if (await onSave(aliasEntry(draft, editing))) setTried(false);
  };

  return (
    <form
      className={styles["aliasForm"]}
      onSubmit={submit}
      noValidate
      aria-label={editing === undefined ? "Add an alias" : `Edit the alias ${editing.alias}`}
    >
      <div className={kit["field"]}>
        <label className={kit["fieldLabel"]} htmlFor={`${ids}-name`}>
          Provider&rsquo;s name
        </label>
        <input
          ref={first}
          id={`${ids}-name`}
          className={kit["input"]}
          list={`${ids}-names`}
          spellCheck={false}
          autoComplete="off"
          value={draft.name}
          aria-invalid={shown.name !== undefined}
          aria-describedby={shown.name === undefined ? undefined : `${ids}-name-error`}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
        <datalist id={`${ids}-names`}>
          {rules.upstreams.map((upstream) => (
            <option key={upstream} value={upstream} />
          ))}
        </datalist>
        {shown.name === undefined ? null : (
          <span id={`${ids}-name-error`} className={kit["fieldError"]}>
            {shown.name}
          </span>
        )}
      </div>
      <div className={kit["field"]}>
        <label className={kit["fieldLabel"]} htmlFor={`${ids}-alias`}>
          Alias for clients
        </label>
        <input
          id={`${ids}-alias`}
          className={kit["input"]}
          spellCheck={false}
          autoComplete="off"
          value={draft.alias}
          aria-invalid={shown.alias !== undefined}
          aria-describedby={shown.alias === undefined ? undefined : `${ids}-alias-error`}
          onChange={(event) => setDraft({ ...draft, alias: event.target.value })}
        />
        {shown.alias === undefined ? null : (
          <span id={`${ids}-alias-error`} className={kit["fieldError"]}>
            {shown.alias}
          </span>
        )}
      </div>
      <label className={styles["check"]}>
        <input
          type="checkbox"
          checked={draft.fork}
          onChange={(event) => setDraft({ ...draft, fork: event.target.checked })}
        />
        <span>Keep original</span>
      </label>
      <div className={styles["formActions"]}>
        <button type="submit" className={kit["secondary"]} disabled={busy} aria-busy={busy}>
          {editing === undefined ? (
            <Plus aria-hidden="true" size={16} strokeWidth={2.25} />
          ) : (
            <Check aria-hidden="true" size={16} strokeWidth={2.25} />
          )}
          {busy ? "Saving…" : editing === undefined ? "Add alias" : "Save alias"}
        </button>
        <button type="button" className={styles["quiet"]} onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className={styles["preview"]} aria-live="polite">
        {name === "" || alias === "" || hasAliasErrors(errors)
          ? null
          : draft.fork
            ? `Clients can call ${alias} and ${name}; both reach ${name}.`
            : `Clients call ${alias} instead of ${name}.`}
      </p>
    </form>
  );
};

/** Opens a closed add form. */
const OpenButton = ({ label, onOpen }: { readonly label: string; readonly onOpen: () => void }) => (
  <button type="button" className={kit["secondary"]} onClick={onOpen}>
    <Plus aria-hidden="true" size={16} strokeWidth={2.25} />
    {label}
  </button>
);

const Aliases = ({
  rules,
  busy,
  save,
  adding,
  onAdding,
}: {
  readonly rules: ChannelRules;
  readonly busy: boolean;
  readonly save: Save;
  readonly adding: boolean;
  readonly onAdding: (adding: boolean) => void;
}) => {
  const [editing, setEditing] = useState<OAuthModelAliasWire | undefined>(undefined);
  const { channel } = rules;

  return (
    <div className={styles["rule"]}>
      <h3 className={styles["ruleTitle"]}>Aliases</h3>
      {rules.aliases.length === 0 ? null : (
        <table className={`${styles["table"]} ${styles["aliases"]}`}>
          <thead>
            <tr>
              <th scope="col">Provider&rsquo;s name</th>
              <th scope="col">Alias for clients</th>
              <th scope="col">Original name</th>
              <th scope="col">
                <span className={kit["visuallyHidden"]}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rules.aliases.map((entry) =>
              entry === editing ? (
                <tr key={`${entry.alias}:edit`} className={styles["editRow"]}>
                  <td colSpan={4}>
                    <AliasForm
                      rules={rules}
                      editing={entry}
                      busy={busy}
                      onCancel={() => setEditing(undefined)}
                      onSave={async (to) => {
                        const saved = await save(
                          { rule: "aliases", channel, op: "replace", from: entry, to },
                          `Saved the alias ${to.alias}.`,
                        );

                        if (saved) setEditing(undefined);

                        return saved;
                      }}
                    />
                  </td>
                </tr>
              ) : (
                <tr key={entry.alias} className={styles["aliasRow"]}>
                  <td className={`${styles["name"]} ${styles["upstreamCell"]}`}>{entry.name}</td>
                  <td className={`${styles["name"]} ${styles["aliasCell"]}`}>
                    <span className={styles["cellKey"]} aria-hidden="true">
                      Alias
                    </span>
                    <span className={styles["aliasName"]}>{entry.alias}</span>
                    {entry["display-name"] === undefined ? null : (
                      <span className={styles["secondary"]}>Shown as {entry["display-name"]}</span>
                    )}
                  </td>
                  <td className={styles["kept"]}>
                    <span className={styles["cellKey"]} aria-hidden="true">
                      Original name
                    </span>
                    {entry.fork === true ? "Kept" : <span className={kit["muted"]}>Replaced</span>}
                  </td>
                  <td className={styles["actions"]}>
                    <button
                      type="button"
                      className={styles["icon"]}
                      aria-label={`Edit the alias ${entry.alias}`}
                      title="Edit"
                      onClick={() => setEditing(entry)}
                    >
                      <Pencil aria-hidden="true" size={16} strokeWidth={2.25} />
                    </button>
                    <button
                      type="button"
                      className={styles["icon"]}
                      aria-label={`Remove the alias ${entry.alias}`}
                      title="Remove"
                      disabled={busy}
                      onClick={() =>
                        save(
                          { rule: "aliases", channel, op: "remove", entry },
                          `Removed the alias ${entry.alias}.`,
                        )
                      }
                    >
                      <X aria-hidden="true" size={18} strokeWidth={2.25} />
                    </button>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}
      {adding ? (
        <AliasForm
          rules={rules}
          editing={undefined}
          busy={busy}
          onCancel={() => onAdding(false)}
          onSave={async (entry) => {
            const saved = await save(
              { rule: "aliases", channel, op: "add", entry },
              `Added the alias ${entry.alias}.`,
            );

            if (saved) onAdding(false);

            return saved;
          }}
        />
      ) : null}
    </div>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// Exclusions

/** "Matches 3 of the 12 models …: a, b, c." The names stop after five. */
const matchLine = (pattern: string, rules: ChannelRules): string => {
  if (rules.upstreams.length === 0)
    return "No account offers models on this channel, so nothing matches yet.";

  const matched = exclusionMatches(pattern, rules.upstreams);
  const offered = `the ${plural(rules.upstreams.length, "model")} this channel's accounts offer`;

  if (matched.length === 0) return `Matches none of ${offered}.`;

  const named = matched.slice(0, 5).join(", ");
  const more = matched.length > 5 ? ` and ${formatCount(matched.length - 5)} more` : "";

  return `Matches ${formatCount(matched.length)} of ${offered}: ${named}${more}.`;
};

const PatternForm = ({
  rules,
  busy,
  save,
  onClose,
}: {
  readonly rules: ChannelRules;
  readonly busy: boolean;
  readonly save: Save;
  readonly onClose: () => void;
}) => {
  const ids = useId();
  const first = useFocusOnOpen();
  const [pattern, setPattern] = useState("");
  const [tried, setTried] = useState(false);
  const error = validatePattern(pattern, rules.excluded);
  const shown = tried ? error : undefined;

  return (
    <form
      className={styles["patternForm"]}
      noValidate
      aria-label="Exclude a model"
      onSubmit={async (event) => {
        event.preventDefault();
        setTried(true);

        if (error !== undefined) return focusFirstInvalid(event.currentTarget);
        const value = pattern.trim().toLowerCase();

        const saved = await save(
          { rule: "excluded", channel: rules.channel, op: "add", pattern: value },
          `Excluded ${value}.`,
        );

        if (saved) onClose();
      }}
    >
      <div className={kit["field"]}>
        <label className={kit["fieldLabel"]} htmlFor={`${ids}-pattern`}>
          Model or pattern
        </label>
        <input
          ref={first}
          id={`${ids}-pattern`}
          className={kit["input"]}
          list={`${ids}-names`}
          spellCheck={false}
          autoComplete="off"
          value={pattern}
          aria-invalid={shown !== undefined}
          aria-describedby={`${ids}-pattern-hint`}
          onChange={(event) => setPattern(event.target.value)}
        />
        <datalist id={`${ids}-names`}>
          {rules.upstreams.map((upstream) => (
            <option key={upstream} value={upstream} />
          ))}
        </datalist>
        <span
          id={`${ids}-pattern-hint`}
          className={shown === undefined ? styles["preview"] : kit["fieldError"]}
          aria-live="polite"
        >
          {shown ?? (pattern.trim() === "" ? null : matchLine(pattern, rules))}
        </span>
      </div>
      <div className={styles["formActions"]}>
        <button type="submit" className={kit["secondary"]} disabled={busy} aria-busy={busy}>
          <Plus aria-hidden="true" size={16} strokeWidth={2.25} />
          {busy ? "Saving…" : "Exclude"}
        </button>
        <button type="button" className={styles["quiet"]} onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
};

const Exclusions = ({
  rules,
  busy,
  save,
  adding,
  onAdding,
}: {
  readonly rules: ChannelRules;
  readonly busy: boolean;
  readonly save: Save;
  readonly adding: boolean;
  readonly onAdding: (adding: boolean) => void;
}) => {
  const { channel } = rules;

  return (
    <div className={styles["rule"]}>
      <h3 className={styles["ruleTitle"]}>Excluded models</h3>
      {rules.excluded.length === 0 ? null : (
        <table className={`${styles["table"]} ${styles["patterns"]}`}>
          <thead>
            <tr>
              <th scope="col">Pattern</th>
              <th scope="col" className={styles["number"]}>
                Models matched
              </th>
              <th scope="col">
                <span className={kit["visuallyHidden"]}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rules.excluded.map((entry) => (
              <tr key={entry}>
                <td className={styles["name"]}>{entry}</td>
                <td className={styles["number"]}>
                  {formatCount(exclusionMatches(entry, rules.upstreams).length)}
                </td>
                <td className={styles["actions"]}>
                  <button
                    type="button"
                    className={styles["icon"]}
                    aria-label={`Stop excluding ${entry}`}
                    title="Remove"
                    disabled={busy}
                    onClick={() =>
                      save(
                        { rule: "excluded", channel, op: "remove", pattern: entry },
                        `Stopped excluding ${entry}.`,
                      )
                    }
                  >
                    <X aria-hidden="true" size={18} strokeWidth={2.25} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {adding ? (
        <PatternForm rules={rules} busy={busy} save={save} onClose={() => onAdding(false)} />
      ) : null}
    </div>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// Write-ins

/** What the form's write-in will do once saved. */
const writeInPreview = (draft: WriteInDraft, rules: ChannelRules): string | null => {
  const name = draft.name.trim();
  const like = draft.like.trim();

  if (name === "") return null;

  if (like === "")
    return `Clients can call ${name}. Without a model it is like, thinking settings pass through unchecked and it has no price until a price override names it.`;

  const known = rules.catalog.some((upstream) => upstream.toLowerCase() === like.toLowerCase());

  return known
    ? `Clients can call ${name}, with the limits, thinking settings and price of ${like} until the catalog lists it.`
    : `Clients can call ${name}. ${like} is not a catalog model of this provider's accounts or keys; if the catalog does not know it either, thinking settings pass through unchecked.`;
};

const WriteInForm = ({
  rules,
  busy,
  save,
  onClose,
}: {
  readonly rules: ChannelRules;
  readonly busy: boolean;
  readonly save: Save;
  readonly onClose: () => void;
}) => {
  const ids = useId();
  const first = useFocusOnOpen();
  const [draft, setDraft] = useState<WriteInDraft>({ name: "", like: "", displayName: "" });
  const [tried, setTried] = useState(false);
  const errors = validateWriteIn(draft, rules);
  const shown = tried ? errors : {};

  return (
    <form
      className={styles["writeInForm"]}
      noValidate
      aria-label="Write in a model"
      onSubmit={async (event) => {
        event.preventDefault();
        setTried(true);

        if (hasWriteInErrors(errors)) return focusFirstInvalid(event.currentTarget);
        const entry = writeInEntry(draft);

        const saved = await save(
          { rule: "write-ins", channel: rules.channel, op: "add", entry },
          `Wrote in ${entry.name}.`,
        );

        if (saved) onClose();
      }}
    >
      <div className={kit["field"]}>
        <label className={kit["fieldLabel"]} htmlFor={`${ids}-name`}>
          Model id
        </label>
        <input
          ref={first}
          id={`${ids}-name`}
          className={kit["input"]}
          spellCheck={false}
          autoComplete="off"
          value={draft.name}
          aria-invalid={shown.name !== undefined}
          aria-describedby={shown.name === undefined ? undefined : `${ids}-name-error`}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
        {shown.name === undefined ? null : (
          <span id={`${ids}-name-error`} className={kit["fieldError"]}>
            {shown.name}
          </span>
        )}
      </div>
      <div className={kit["field"]}>
        <label className={kit["fieldLabel"]} htmlFor={`${ids}-like`}>
          Like (optional)
        </label>
        <input
          id={`${ids}-like`}
          className={kit["input"]}
          list={`${ids}-catalog`}
          spellCheck={false}
          autoComplete="off"
          value={draft.like}
          aria-invalid={shown.like !== undefined}
          aria-describedby={shown.like === undefined ? undefined : `${ids}-like-error`}
          onChange={(event) => setDraft({ ...draft, like: event.target.value })}
        />
        <datalist id={`${ids}-catalog`}>
          {rules.catalog.map((upstream) => (
            <option key={upstream} value={upstream} />
          ))}
        </datalist>
        {shown.like === undefined ? null : (
          <span id={`${ids}-like-error`} className={kit["fieldError"]}>
            {shown.like}
          </span>
        )}
      </div>
      <div className={kit["field"]}>
        <label className={kit["fieldLabel"]} htmlFor={`${ids}-display`}>
          Display name (optional)
        </label>
        <input
          id={`${ids}-display`}
          className={kit["input"]}
          autoComplete="off"
          value={draft.displayName}
          onChange={(event) => setDraft({ ...draft, displayName: event.target.value })}
        />
      </div>
      <div className={styles["formActions"]}>
        <button type="submit" className={kit["secondary"]} disabled={busy} aria-busy={busy}>
          <Plus aria-hidden="true" size={16} strokeWidth={2.25} />
          {busy ? "Saving…" : "Write in"}
        </button>
        <button type="button" className={styles["quiet"]} onClick={onClose}>
          Cancel
        </button>
      </div>
      <p className={styles["preview"]} aria-live="polite">
        {hasWriteInErrors(errors) ? null : writeInPreview(draft, rules)}
      </p>
    </form>
  );
};

/** The line under a write-in when it is not simply serving. */
const writeInNote = (rules: ChannelRules, entry: ModelWriteIn) => {
  const state = writeInState(rules, entry);

  if (state === "listed") {
    return (
      <span className={styles["caughtUp"]}>
        The catalog lists it now, so this write-in changes nothing. You can remove it.
      </span>
    );
  }

  return state === "idle" ? (
    <span className={styles["secondary"]}>
      No account or provider key of this provider takes its models from the catalog yet.
    </span>
  ) : null;
};

const WriteIns = ({
  rules,
  busy,
  save,
  adding,
  onAdding,
}: {
  readonly rules: ChannelRules;
  readonly busy: boolean;
  readonly save: Save;
  readonly adding: boolean;
  readonly onAdding: (adding: boolean) => void;
}) => {
  const { channel } = rules;

  return (
    <div className={styles["rule"]}>
      <h3 className={styles["ruleTitle"]}>Written-in models</h3>
      {rules.writeIns.length === 0 ? null : (
        <table className={`${styles["table"]} ${styles["writeIns"]}`}>
          <thead>
            <tr>
              <th scope="col">Model id</th>
              <th scope="col">Like</th>
              <th scope="col">
                <span className={kit["visuallyHidden"]}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rules.writeIns.map((entry) => (
              <tr key={entry.name}>
                <td className={styles["name"]}>
                  {entry.name}
                  {entry["display-name"] === undefined ? null : (
                    <span className={styles["secondary"]}>Shown as {entry["display-name"]}</span>
                  )}
                  {writeInNote(rules, entry)}
                </td>
                <td className={styles["name"]}>
                  {entry.like ?? <span className={kit["muted"]}>Nothing: unchecked</span>}
                </td>
                <td className={styles["actions"]}>
                  <button
                    type="button"
                    className={styles["icon"]}
                    aria-label={`Remove the write-in ${entry.name}`}
                    title="Remove"
                    disabled={busy}
                    onClick={() =>
                      save(
                        { rule: "write-ins", channel, op: "remove", entry },
                        `Removed the write-in ${entry.name}.`,
                      )
                    }
                  >
                    <X aria-hidden="true" size={18} strokeWidth={2.25} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {adding ? (
        <WriteInForm rules={rules} busy={busy} save={save} onClose={() => onAdding(false)} />
      ) : null}
    </div>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// A channel

const Channel = ({
  rules,
  view,
  onReload,
}: {
  readonly rules: ChannelRules;
  readonly view: RoutingModels;
  readonly onReload: () => void;
}) => {
  const { save, note, busy } = useChannelSave(rules.channel, view);
  const [addingAlias, setAddingAlias] = useState(false);
  const [excluding, setExcluding] = useState(false);
  const [writingIn, setWritingIn] = useState(false);
  const titleId = useId();
  const title = providerName(rules.channel);
  const showAliases = rules.aliases.length > 0 || addingAlias;
  const showExcluded = rules.excluded.length > 0 || excluding;
  const showWriteIns = rules.writeIns.length > 0 || writingIn;

  return (
    <section
      id={`channel-${rules.channel}`}
      className={styles["channel"]}
      aria-labelledby={titleId}
    >
      <header className={styles["channelHead"]}>
        <h2 id={titleId} className={styles["channelTitle"]}>
          {title}
        </h2>
        <p className={styles["facts"]}>
          {title.toLowerCase() === rules.channel.toLowerCase() ? null : (
            <span>Channel {rules.channel}</span>
          )}
          <span>{rules.inert ? "No accounts" : plural(rules.accounts, "account")}</span>
          {rules.keys === 0 ? null : <span>{plural(rules.keys, "provider key")}</span>}
        </p>
      </header>
      {!rules.inert ? null : rules.keys === 0 ? (
        <p className={styles["inert"]}>
          No account uses this channel, so its rules have no effect until one is connected.
        </p>
      ) : (
        <p className={styles["inert"]}>
          No account uses this channel, so its aliases and exclusions have no effect until one is
          connected. Its write-ins reach the provider&rsquo;s keys.
        </p>
      )}
      {showAliases ? (
        <Aliases
          rules={rules}
          busy={busy.aliases}
          save={save}
          adding={addingAlias}
          onAdding={setAddingAlias}
        />
      ) : null}
      {showExcluded ? (
        <Exclusions
          rules={rules}
          busy={busy.excluded}
          save={save}
          adding={excluding}
          onAdding={setExcluding}
        />
      ) : null}
      {showWriteIns ? (
        <WriteIns
          rules={rules}
          busy={busy.writeIns}
          save={save}
          adding={writingIn}
          onAdding={setWritingIn}
        />
      ) : null}
      {addingAlias && excluding && writingIn ? null : (
        <div className={styles["foot"]}>
          {showAliases || showExcluded || showWriteIns ? null : (
            <p className={styles["none"]}>No aliases, exclusions or write-ins</p>
          )}
          {addingAlias ? null : (
            <OpenButton label="Add alias" onOpen={() => setAddingAlias(true)} />
          )}
          {excluding ? null : (
            <OpenButton label="Exclude a model" onOpen={() => setExcluding(true)} />
          )}
          {writingIn ? null : (
            <OpenButton label="Write in a model" onOpen={() => setWritingIn(true)} />
          )}
        </div>
      )}
      {note?.tone === "problem" ? (
        <Problem {...(note.stale ? { onRetry: onReload, retryLabel: "Reload" } : {})}>
          Could not save. {note.text}
        </Problem>
      ) : null}
      <p className={styles["note"]} role="status">
        {note?.tone === "done" ? note.text : null}
      </p>
    </section>
  );
};

const AddChannel = ({
  known,
  onAdd,
}: {
  /** Channels shown already; with none, the section is "Rules for a channel". */
  readonly known: ReadonlyArray<string>;
  readonly onAdd: (channel: string) => void;
}) => {
  const ids = useId();
  const [channel, setChannel] = useState("");
  const [tried, setTried] = useState(false);
  const error = validateChannel(channel, known);
  const shown = tried ? error : undefined;

  return (
    <section className={styles["add"]} aria-labelledby={`${ids}-title`}>
      <h2 id={`${ids}-title`} className={styles["addTitle"]}>
        {known.length === 0 ? "Rules for a channel" : "Rules for another channel"}
      </h2>
      <form
        className={styles["patternForm"]}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setTried(true);

          if (error !== undefined) return focusFirstInvalid(event.currentTarget);
          onAdd(channel.trim());
          setChannel("");
          setTried(false);
        }}
      >
        <div className={kit["field"]}>
          <label className={kit["fieldLabel"]} htmlFor={`${ids}-channel`}>
            Channel
          </label>
          <input
            id={`${ids}-channel`}
            className={kit["input"]}
            list={`${ids}-channels`}
            spellCheck={false}
            autoComplete="off"
            value={channel}
            aria-invalid={shown !== undefined}
            aria-describedby={`${ids}-channel-hint`}
            onChange={(event) => setChannel(event.target.value)}
          />
          <datalist id={`${ids}-channels`}>
            {KNOWN_CHANNELS.flatMap((candidate) =>
              known.includes(candidate) ? [] : [<option key={candidate} value={candidate} />],
            )}
          </datalist>
          <span
            id={`${ids}-channel-hint`}
            className={shown === undefined ? styles["preview"] : kit["fieldError"]}
          >
            {shown ?? "The provider key of its accounts, such as claude or kimi.com."}
          </span>
        </div>
        <button type="submit" className={kit["secondary"]}>
          <Plus aria-hidden="true" size={16} strokeWidth={2.25} />
          Add channel
        </button>
      </form>
    </section>
  );
};

const Rules = ({
  view,
  onReload,
}: {
  readonly view: RoutingModels;
  readonly onReload: () => void;
}) => {
  const [extra, setExtra] = useState<ReadonlyArray<string>>([]);
  const channels = channelRules(view, extra);

  return (
    <>
      {channels.length < 2 ? null : (
        <nav className={styles["jumps"]} aria-label="Channels">
          {channels.map((rules) => (
            <a key={rules.channel} href={`#channel-${rules.channel}`}>
              {providerName(rules.channel)}
            </a>
          ))}
        </nav>
      )}
      {channels.length === 0 ? (
        <p className={styles["empty"]}>
          No account uses a channel yet, and no rules are stored. Connect an account, or add rules
          for a channel below.
        </p>
      ) : (
        <div className={styles["channels"]}>
          {channels.map((rules) => (
            <Channel key={rules.channel} rules={rules} view={view} onReload={onReload} />
          ))}
        </div>
      )}
      <AddChannel
        known={channels.map((rules) => rules.channel)}
        onAdd={(channel) => setExtra([...extra, channel])}
      />
    </>
  );
};

export const ModelRulesPage = () => {
  usePageTitle("Model rules · Models");
  const result = useAtomValue(routingModelsAtom);
  const retry = useAtomRefresh(routingModelsAtom);

  return (
    <div className={styles["page"]}>
      <header className={styles["head"]}>
        <Link to="/models" className={styles["back"]}>
          <ArrowLeft aria-hidden="true" size={16} strokeWidth={2.25} />
          Models
        </Link>
        <h1 className={styles["title"]}>Model rules</h1>
        <p className={styles["intro"]}>
          Each rule applies to every account of one provider, its channel, as soon as it is saved.
          An alias lets clients call a model by another name; with Keep original, they can use both.
          An exclusion hides every model whose provider&rsquo;s name matches, where * matches any
          characters. Provider keys keep their own rules on the{" "}
          <Link to="/keys">Provider keys</Link> page.
        </p>
        <p className={styles["intro"]}>
          A write-in adds a model the catalog does not list yet, such as one released today. The
          provider&rsquo;s accounts serve it, and so do its provider keys that have no model list of
          their own. Once the catalog lists the model, the catalog&rsquo;s details take over.
        </p>
      </header>
      {AsyncResult.match(result, {
        onInitial: () => (
          <p className={kit["muted"]} aria-busy="true">
            Loading the rules…
          </p>
        ),
        onFailure: (failure) => (
          <Problem onRetry={retry}>Could not load the rules. {failureMessage(failure)}</Problem>
        ),
        onSuccess: ({ value }) => <Rules view={value} onReload={retry} />,
      })}
    </div>
  );
};
