// One provider key group, or a new one: its endpoint (name, base URL, prefix, priority), its keys (new ones are typed in
// once and never shown again), the models it offers and the ones it excludes, saved in one write; and deleting it.
// Settings the form does not show are kept as they are (the server restores them).
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { ArrowLeft, Plus, Search, Trash2, X } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useRef, useState } from "react";
import type {
  ProviderKeyFamily,
  ProviderKeysList,
  ProbeResult,
} from "@commissary/contract/provider-keys";
import {
  PROVIDER_KEYS,
  providerKeysAtom,
  deleteKeyGroupAtom,
  probeKeyAtom,
  putKeyGroupAtom,
} from "../api/client.ts";
import { kit, Problem, Section } from "../components/Kit.tsx";
import { addsPrivately, Ownership } from "../components/Ownership.tsx";
import { TrailMark } from "../components/Signs.tsx";
import { failureMessage } from "../lib/failure.ts";
import { formatCount } from "../lib/format.ts";
import {
  type AnyGroupView,
  baseUrlPlaceholder,
  changesIdentity,
  choosesProtocol,
  defaultBaseUrl,
  draftOf,
  FAMILY_ORDER,
  familyName,
  type GroupDraft,
  groupTitle,
  hasErrors,
  isFamily,
  isStaleWrite,
  keptSettings,
  keyTail,
  newKeyDraft,
  newModelDraft,
  PROTOCOL_CHOICES,
  putGroupRequest,
  validateDraft,
  writeProblem,
} from "../lib/keys.ts";
import { useAction } from "../lib/use-action.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import { useRole } from "../lib/use-role.ts";
import styles from "./KeyGroup.module.css";

const editRoute = getRouteApi("/keys/$family/$index");

const ownRoute = getRouteApi("/keys/private/$family/$index");

const newRoute = getRouteApi("/keys/new");

const FAMILY_NOTES: Readonly<Record<ProviderKeyFamily, string>> = {
  claude: "Anthropic provider keys, or a Claude-compatible endpoint.",
  codex: "OpenAI keys for the Responses API; the endpoint needs a base URL.",
  gemini: "Google AI Studio keys for the Gemini API.",
  interactions: "Gemini keys used only for the native Interactions API.",
  vertex: "Vertex AI express-mode keys; every model needs an alias.",
  xai: "xAI keys for Grok; the endpoint needs a base URL.",
  meta: "Meta Llama provider keys.",
  "opencode-zen":
    "OpenCode Zen keys; models come from the OpenCode catalog unless listed. A listed model can pin its protocol.",
  "opencode-go":
    "OpenCode Go subscription keys; models come from the OpenCode catalog unless listed. A listed model can pin its protocol.",
  typesafe: "TypeSafe keys for Jev, a System One model served on /v1/systemone.",
  subq: "Subquadratic keys for SubQ Snap, a System One model served on /v1/systemone.",
  "openai-compatibility":
    "Any endpoint that speaks the OpenAI chat API, under a provider name of your own.",
};

// ---------------------------------------------------------------------------------------------------------------
// Pieces of the form

const Field = ({
  id,
  label,
  hint,
  error,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint?: ReactNode;
  readonly error?: string | undefined;
  readonly children: ReactNode;
}) => (
  <div className={kit["field"]}>
    <label className={kit["fieldLabel"]} htmlFor={id}>
      {label}
    </label>
    {children}
    {error === undefined ? (
      hint === undefined ? null : (
        <span id={`${id}-hint`} className={styles["hint"]}>
          {hint}
        </span>
      )
    ) : (
      <span id={`${id}-hint`} className={kit["fieldError"]}>
        {error}
      </span>
    )}
  </div>
);

const Discover = ({
  authIndex,
  known,
  onAdd,
}: {
  readonly authIndex: string;
  readonly known: ReadonlySet<string>;
  readonly onAdd: (names: ReadonlyArray<string>) => void;
}) => {
  const probe = useAction(probeKeyAtom(authIndex));

  const [found, setFound] = useState<NonNullable<ProbeResult["models"]> | string | undefined>(
    undefined,
  );

  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const ids = useId();
  const offered = typeof found === "object" ? found.filter((model) => !known.has(model.id)) : [];

  return (
    <div className={styles["discover"]}>
      <button
        type="button"
        className={kit["secondary"]}
        disabled={probe.busy}
        aria-busy={probe.busy}
        onClick={async () => {
          const outcome = await probe.run();

          if (!outcome.ok) return setFound(outcome.message);

          const { value } = outcome;

          if (!value.ok) {
            return setFound(
              `${value.status_code === undefined ? "" : `HTTP ${value.status_code}: `}${value.error ?? "the provider refused the request"}`,
            );
          }

          setPicked(new Set());
          setFound(value.models ?? "The provider does not list its models.");
        }}
      >
        <Search
          aria-hidden="true"
          size={16}
          strokeWidth={2.25}
          className={probe.busy ? kit["spinning"] : undefined}
        />
        {probe.busy ? "Asking the provider…" : "Discover models"}
      </button>
      {found === undefined ? null : (
        <div className={styles["discoverResult"]}>
          {typeof found === "string" ? (
            <p className={styles["problemLine"]}>
              <TrailMark />
              {found}
            </p>
          ) : offered.length === 0 ? (
            <p className={kit["muted"]}>Every model the provider lists is already here.</p>
          ) : (
            <div className={styles["found"]} role="group" aria-labelledby={`${ids}-found`}>
              <p id={`${ids}-found`} className={styles["foundTitle"]}>
                {formatCount(offered.length)} more model{offered.length === 1 ? "" : "s"} offered
              </p>
              <ul className={styles["foundList"]}>
                {offered.map((model) => (
                  <li key={model.id}>
                    <label className={styles["check"]}>
                      <input
                        type="checkbox"
                        checked={picked.has(model.id)}
                        onChange={(event) => {
                          const next = new Set(picked);

                          if (event.target.checked) next.add(model.id);
                          else next.delete(model.id);
                          setPicked(next);
                        }}
                      />
                      <span>{model.id}</span>
                    </label>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className={kit["secondary"]}
                disabled={picked.size === 0}
                onClick={() => {
                  onAdd(offered.map((model) => model.id).filter((id) => picked.has(id)));
                  setFound(undefined);
                }}
              >
                <Plus aria-hidden="true" size={16} strokeWidth={2.25} />
                {picked.size === 0
                  ? "Add selected"
                  : `Add ${formatCount(picked.size)} model${picked.size === 1 ? "" : "s"}`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// The form

const GroupForm = ({
  family,
  view,
  privately,
  onReload,
}: {
  readonly family: ProviderKeyFamily;
  readonly view: AnyGroupView | undefined;
  /** The group is the caller's private one (ADR 0023). */
  readonly privately: boolean;
  readonly onReload: () => void;
}) => {
  const ids = useId();
  const navigate = useNavigate();
  const save = useAction(putKeyGroupAtom);
  const [draft, setDraft] = useState<GroupDraft>(() => draftOf(view));
  const [tried, setTried] = useState(false);
  const [problem, setProblem] = useState<{ text: string; stale: boolean } | undefined>(undefined);
  const [replacing, setReplacing] = useState<ReadonlySet<string>>(new Set());
  const errors = validateDraft(family, draft);
  const shown = tried ? errors : { keyErrors: {} };
  const compat = family === "openai-compatibility";
  const protocols = choosesProtocol(family);
  const kept = keptSettings(view);

  const probeWith = draft.keys.find((key) => key.stored?.auth_index !== undefined)?.stored
    ?.auth_index;

  const set = <K extends keyof GroupDraft>(field: K, value: GroupDraft[K]) =>
    setDraft((current) => ({ ...current, [field]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTried(true);

    if (hasErrors(errors)) {
      const form = event.currentTarget;

      // The fields are marked on the next render; then the first one takes focus.
      requestAnimationFrame(() =>
        form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
      );

      return;
    }

    const request = putGroupRequest(family, view, draft, privately);

    // One branch per request shape: the mutation takes a union of argument objects, not a union payload.
    const outcome = await save.run(
      request.family === "openai-compatibility"
        ? { payload: request, reactivityKeys: PROVIDER_KEYS }
        : { payload: request, reactivityKeys: PROVIDER_KEYS },
    );

    if (outcome.ok) {
      await navigate({ to: "/keys" });

      return;
    }

    setProblem({
      text: writeProblem(outcome.error, outcome.message),
      stale: isStaleWrite(outcome.error),
    });
  };

  return (
    <form className={styles["form"]} onSubmit={submit} noValidate>
      <Section title="Endpoint">
        <div className={styles["fields"]}>
          <Field
            id={`${ids}-name`}
            label={compat ? "Provider name" : "Name"}
            hint={
              compat
                ? "Clients see this as the provider. Renaming it starts a new history for its keys."
                : "Only for you: tells groups apart on this page."
            }
            error={shown.name}
          >
            <input
              id={`${ids}-name`}
              className={kit["input"]}
              value={draft.name}
              aria-invalid={shown.name !== undefined}
              aria-describedby={`${ids}-name-hint`}
              onChange={(event) => set("name", event.target.value)}
            />
          </Field>
          <Field
            id={`${ids}-base`}
            label="Base URL"
            hint={
              defaultBaseUrl(family) === undefined
                ? "Required: where Commissary sends this group's requests."
                : "Leave empty for the provider's own API."
            }
            error={shown.baseUrl}
          >
            <input
              id={`${ids}-base`}
              className={kit["input"]}
              type="url"
              inputMode="url"
              spellCheck={false}
              value={draft.baseUrl}
              placeholder={baseUrlPlaceholder(family)}
              aria-invalid={shown.baseUrl !== undefined}
              aria-describedby={`${ids}-base-hint`}
              onChange={(event) => set("baseUrl", event.target.value)}
            />
          </Field>
          <Field
            id={`${ids}-prefix`}
            label="Model prefix"
            hint={
              draft.prefix.trim() === ""
                ? "Optional. For example, with team, clients can also call team/<model> to reach these keys only."
                : `Clients can also call ${draft.prefix.trim()}/<model> to reach these keys only.`
            }
          >
            <input
              id={`${ids}-prefix`}
              className={kit["input"]}
              spellCheck={false}
              value={draft.prefix}
              aria-describedby={`${ids}-prefix-hint`}
              onChange={(event) => set("prefix", event.target.value)}
            />
          </Field>
          <Field
            id={`${ids}-priority`}
            label="Priority"
            hint="Commissary uses the highest priority first; empty counts as 0."
            error={shown.priority}
          >
            <input
              id={`${ids}-priority`}
              className={kit["input"]}
              inputMode="numeric"
              placeholder="0"
              value={draft.priority}
              aria-invalid={shown.priority !== undefined}
              aria-describedby={`${ids}-priority-hint`}
              onChange={(event) => set("priority", event.target.value)}
            />
          </Field>
        </div>
        {compat ? (
          <div className={styles["checks"]}>
            <label className={styles["check"]}>
              <input
                type="checkbox"
                checked={draft.disabled}
                onChange={(event) => set("disabled", event.target.checked)}
              />
              <span>Disable this endpoint: Commissary sends it no requests</span>
            </label>
            <label className={styles["check"]}>
              <input
                type="checkbox"
                checked={draft.promptCacheKey}
                onChange={(event) => set("promptCacheKey", event.target.checked)}
              />
              <span>Send a prompt cache key with each request</span>
            </label>
          </div>
        ) : null}
      </Section>

      <Section title="Keys">
        <p className={styles["lead"]}>
          A key is shown only by its last characters. Type a new one to replace it; Commissary keeps
          it and never sends it back to this page.
        </p>
        {shown.keys === undefined ? null : <p className={kit["fieldError"]}>{shown.keys}</p>}
        <ul className={styles["keyRows"]}>
          {draft.keys.map((key, position) => {
            const tail = key.stored === undefined ? "" : keyTail(key.stored.key_preview);
            const asking = key.stored === undefined || replacing.has(key.id);
            const error = shown.keyErrors[key.id];
            const secretError = error?.field === "secret" ? error.text : undefined;
            const weightError = error?.field === "weight" ? error.text : undefined;
            const errorId = `${ids}-key-error-${key.id}`;

            return (
              <li key={key.id} className={styles["keyRow"]}>
                <div className={styles["keyWho"]}>
                  <span className={styles["tail"]}>
                    {key.stored === undefined ? "New key" : tail === "" ? "No key" : tail}
                  </span>
                  {key.stored?.disabled === true ? (
                    <span className={kit["muted"]}>Disabled</span>
                  ) : null}
                </div>
                {asking ? (
                  <div className={kit["field"]}>
                    <label className={kit["fieldLabel"]} htmlFor={`${ids}-secret-${key.id}`}>
                      {key.stored === undefined ? "Provider key" : "New provider key"}
                    </label>
                    <input
                      id={`${ids}-secret-${key.id}`}
                      className={kit["input"]}
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      value={key.secret}
                      aria-invalid={secretError !== undefined}
                      aria-describedby={secretError === undefined ? undefined : errorId}
                      onChange={(event) =>
                        set(
                          "keys",
                          draft.keys.map((row) =>
                            row.id === key.id ? { ...row, secret: event.target.value } : row,
                          ),
                        )
                      }
                    />
                    {secretError === undefined ? null : (
                      <p id={errorId} className={kit["fieldError"]}>
                        {secretError}
                      </p>
                    )}
                  </div>
                ) : (
                  <button
                    type="button"
                    className={kit["secondary"]}
                    onClick={() => setReplacing(new Set([...replacing, key.id]))}
                  >
                    Replace key
                  </button>
                )}
                <div className={`${kit["field"]} ${styles["weightField"]}`}>
                  <label className={kit["fieldLabel"]} htmlFor={`${ids}-weight-${key.id}`}>
                    Weight
                  </label>
                  <input
                    id={`${ids}-weight-${key.id}`}
                    className={kit["input"]}
                    inputMode="numeric"
                    placeholder="1"
                    value={key.weight}
                    aria-invalid={weightError !== undefined}
                    aria-describedby={weightError === undefined ? undefined : errorId}
                    onChange={(event) =>
                      set(
                        "keys",
                        draft.keys.map((row) =>
                          row.id === key.id ? { ...row, weight: event.target.value } : row,
                        ),
                      )
                    }
                  />
                </div>
                <button
                  type="button"
                  className={styles["remove"]}
                  aria-label={`Remove ${key.stored === undefined ? `new key ${position + 1}` : `key ${tail}`}`}
                  onClick={() =>
                    set(
                      "keys",
                      draft.keys.filter((row) => row.id !== key.id),
                    )
                  }
                >
                  <X aria-hidden="true" size={18} strokeWidth={2.25} />
                </button>
                {weightError === undefined ? null : (
                  <p id={errorId} className={`${kit["fieldError"]} ${styles["rowError"]}`}>
                    {weightError}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          className={kit["secondary"]}
          onClick={() => set("keys", [...draft.keys, newKeyDraft()])}
        >
          <Plus aria-hidden="true" size={16} strokeWidth={2.25} />
          Add a key
        </button>
      </Section>

      <Section title="Models">
        <p className={styles["lead"]}>
          {compat
            ? "The models clients can call on this endpoint. An alias is the name clients use; empty keeps the provider's name."
            : "Leave the list empty to offer the provider's own models. A list replaces them: clients can call only these, by alias where one is set."}
        </p>
        {shown.models === undefined ? null : <p className={kit["fieldError"]}>{shown.models}</p>}
        {draft.models.length === 0 ? null : (
          <table className={styles["models"]}>
            <thead>
              <tr>
                <th scope="col">Provider's name</th>
                <th scope="col">Alias for clients</th>
                {protocols ? <th scope="col">Protocol</th> : null}
                <th scope="col">
                  <span className={kit["visuallyHidden"]}>Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {draft.models.map((model, position) => {
                const update = (patch: { name?: string; alias?: string; protocol?: string }) =>
                  set(
                    "models",
                    draft.models.map((row, at) => (at === position ? { ...row, ...patch } : row)),
                  );

                return (
                  // Rows have no identity of their own; their position is stable while editing.
                  // oxlint-disable-next-line react/no-array-index-key
                  <tr key={position}>
                    <td data-label="Provider's name">
                      <input
                        className={kit["input"]}
                        aria-label={`Model ${position + 1}, provider's name`}
                        spellCheck={false}
                        value={model.name}
                        onChange={(event) => update({ name: event.target.value })}
                      />
                    </td>
                    <td data-label="Alias for clients">
                      <input
                        className={kit["input"]}
                        aria-label={`Model ${position + 1}, alias`}
                        spellCheck={false}
                        value={model.alias}
                        aria-invalid={
                          shown.models !== undefined && model.alias.trim() === "" ? true : undefined
                        }
                        onChange={(event) => update({ alias: event.target.value })}
                      />
                    </td>
                    {protocols ? (
                      <td data-label="Protocol">
                        <select
                          className={kit["input"]}
                          aria-label={`Model ${position + 1}, protocol`}
                          value={model.protocol}
                          onChange={(event) => update({ protocol: event.target.value })}
                        >
                          {PROTOCOL_CHOICES.map((choice) => (
                            <option key={choice.value} value={choice.value}>
                              {choice.label}
                            </option>
                          ))}
                        </select>
                      </td>
                    ) : null}
                    <td className={styles["removeCell"]}>
                      <button
                        type="button"
                        className={styles["remove"]}
                        aria-label={`Remove model ${model.name === "" ? position + 1 : model.name}`}
                        onClick={() =>
                          set(
                            "models",
                            draft.models.filter((_, at) => at !== position),
                          )
                        }
                      >
                        <X aria-hidden="true" size={18} strokeWidth={2.25} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div className={styles["modelActions"]}>
          <button
            type="button"
            className={kit["secondary"]}
            onClick={() => set("models", [...draft.models, newModelDraft()])}
          >
            <Plus aria-hidden="true" size={16} strokeWidth={2.25} />
            Add a model
          </button>
          {probeWith === undefined || family === "vertex" ? null : (
            <Discover
              authIndex={probeWith}
              known={new Set(draft.models.map((model) => model.name.trim()))}
              onAdd={(names) =>
                set("models", [...draft.models, ...names.map((name) => newModelDraft(name))])
              }
            />
          )}
        </div>
      </Section>

      {compat ? null : (
        <Section title="Excluded models">
          <Field
            id={`${ids}-excluded`}
            label="Models these keys never serve"
            hint="One per line. * matches any characters: claude-3-* excludes every Claude 3 model, and * alone disables the group."
          >
            <textarea
              id={`${ids}-excluded`}
              className={`${kit["input"]} ${styles["patterns"]}`}
              spellCheck={false}
              rows={4}
              value={draft.excluded}
              aria-describedby={`${ids}-excluded-hint`}
              onChange={(event) => set("excluded", event.target.value)}
            />
          </Field>
        </Section>
      )}

      <div className={styles["save"]}>
        {kept.length === 0 ? null : (
          <p className={styles["kept"]}>
            Kept as they are: {kept.join(", ")}. Importing a Go config document (POST
            /settings/import) sets them.
          </p>
        )}
        {changesIdentity(family, view, draft) ? (
          <p className={styles["warning"]}>
            Saving changes what identifies these keys, so their request counts and usage history
            start over.
          </p>
        ) : null}
        {problem === undefined ? null : (
          <Problem {...(problem.stale ? { onRetry: onReload, retryLabel: "Reload" } : {})}>
            Could not save. {problem.text}
          </Problem>
        )}
        {tried && hasErrors(errors) ? (
          <p className={kit["fieldError"]} role="alert">
            Fix the fields marked above to save.
          </p>
        ) : null}
        <div className={styles["saveActions"]}>
          <button type="submit" className={kit["primary"]} disabled={save.busy}>
            {save.busy ? "Saving…" : view === undefined ? "Add keys" : "Save changes"}
          </button>
          <Link to="/keys" className={kit["secondary"]}>
            Cancel
          </Link>
        </div>
      </div>
    </form>
  );
};

const DeleteGroup = ({
  family,
  view,
  privately,
  onReload,
}: {
  readonly family: ProviderKeyFamily;
  readonly view: AnyGroupView;
  readonly privately: boolean;
  readonly onReload: () => void;
}) => {
  const remove = useAction(deleteKeyGroupAtom);
  const dialog = useRef<HTMLDialogElement>(null);
  const navigate = useNavigate();
  const titleId = useId();
  const [problem, setProblem] = useState<{ text: string; stale: boolean } | undefined>(undefined);
  const title = groupTitle(family, view);
  const count = view.group.keys.length;

  return (
    <Section title="Delete" className={styles["delete"]}>
      <p className={styles["lead"]}>
        Commissary stops using {count === 1 ? "this key" : `these ${formatCount(count)} keys`} and
        forgets {count === 1 ? "it" : "them"}. Their usage history stays.
      </p>
      {problem === undefined ? null : (
        <Problem {...(problem.stale ? { onRetry: onReload, retryLabel: "Reload" } : {})}>
          Could not delete the group. {problem.text}
        </Problem>
      )}
      <button type="button" className={kit["danger"]} onClick={() => dialog.current?.showModal()}>
        <Trash2 aria-hidden="true" size={16} strokeWidth={2.25} />
        Delete group
      </button>
      <dialog ref={dialog} className={kit["dialog"]} aria-labelledby={titleId}>
        <form
          method="dialog"
          className={kit["dialogBody"]}
          onSubmit={async (event) => {
            event.preventDefault();

            const outcome = await remove.run({
              payload: {
                family,
                id: view.id,
                revision: view.revision,
                ...(privately ? { private: true } : {}),
              },
              reactivityKeys: PROVIDER_KEYS,
            });

            dialog.current?.close();

            if (outcome.ok) await navigate({ to: "/keys" });
            else
              setProblem({
                text: writeProblem(outcome.error, outcome.message),
                stale: isStaleWrite(outcome.error),
              });
          }}
        >
          <h2 id={titleId} className={kit["dialogTitle"]}>
            Delete {title}?
          </h2>
          <p>
            Requests stop going to {count === 1 ? "its key" : `its ${formatCount(count)} keys`}, and
            the keys are removed from Commissary&rsquo;s configuration.
          </p>
          <div className={kit["dialogActions"]}>
            <button type="submit" className={kit["danger"]} disabled={remove.busy}>
              {remove.busy ? "Deleting…" : "Delete group"}
            </button>
            <button
              type="button"
              className={kit["secondary"]}
              onClick={() => dialog.current?.close()}
            >
              Keep it
            </button>
          </div>
        </form>
      </dialog>
    </Section>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// Pages

const Back = () => (
  <Link to="/keys" className={styles["back"]}>
    <ArrowLeft aria-hidden="true" size={16} strokeWidth={2.25} />
    Provider keys
  </Link>
);

const Loaded = ({ children }: { readonly children: (list: ProviderKeysList) => ReactNode }) => {
  const result = useAtomValue(providerKeysAtom);
  const retry = useAtomRefresh(providerKeysAtom);

  return AsyncResult.match(result, {
    onInitial: () => (
      <p className={kit["muted"]} aria-busy="true">
        Loading provider keys…
      </p>
    ),
    onFailure: (failure) => (
      <Problem onRetry={retry}>Could not load the provider keys. {failureMessage(failure)}</Problem>
    ),
    onSuccess: ({ value }) => children(value),
  });
};

export const KeyGroupPage = () => <ExistingGroup {...editRoute.useParams()} privately={false} />;

/** One of the caller's own private groups (`/keys/private/<family>/<index>`). */
export const OwnKeyGroupPage = () => <ExistingGroup {...ownRoute.useParams()} privately={true} />;

const ExistingGroup = ({
  family,
  index,
  privately,
}: {
  readonly family: string;
  readonly index: string;
  readonly privately: boolean;
}) => {
  const retry = useAtomRefresh(providerKeysAtom);
  const known = isFamily(family) ? family : undefined;
  const position = /^\d+$/.test(index) ? Number(index) : -1;

  return (
    <Loaded>
      {(list) => {
        const families = privately ? list.own : list.families;

        const groups: ReadonlyArray<AnyGroupView> =
          known === undefined ? [] : (families?.[known] ?? []);

        const view = groups.find((group) => group.index === position);

        if (known === undefined || view === undefined) return <MissingGroup />;

        return (
          <GroupPage
            family={known}
            view={view}
            privately={privately}
            // A reload remounts the form with what is stored now.
            key={`${view.id}:${view.revision}`}
            onReload={retry}
          />
        );
      }}
    </Loaded>
  );
};

const GroupPage = ({
  family,
  view,
  privately,
  onReload,
}: {
  readonly family: ProviderKeyFamily;
  readonly view: AnyGroupView;
  readonly privately: boolean;
  readonly onReload: () => void;
}) => {
  const title = groupTitle(family, view);
  usePageTitle(`${title} · Provider keys`);

  return (
    <div className={styles["page"]}>
      <header className={styles["head"]}>
        <Back />
        <div>
          <p className={styles["provider"]}>
            {familyName(family)}
            {privately ? " · private to you" : ""}
          </p>
          <h1 className={styles["name"]}>{title}</h1>
        </div>
      </header>
      <GroupForm family={family} view={view} privately={privately} onReload={onReload} />
      <DeleteGroup family={family} view={view} privately={privately} onReload={onReload} />
    </div>
  );
};

const MissingGroup = () => {
  usePageTitle("Group not found");

  return (
    <div className={styles["page"]}>
      <header className={styles["head"]}>
        <Back />
        <h1 className={styles["name"]}>Group not found</h1>
      </header>
      <p className={kit["muted"]}>
        No provider key group is stored here. It may have been deleted, or the configuration changed
        since the link was made. <Link to="/keys">See every key</Link>.
      </p>
    </div>
  );
};

export const NewKeyGroupPage = () => {
  const { family } = newRoute.useSearch();
  const retry = useAtomRefresh(providerKeysAtom);
  const role = useRole();
  const caller = role.kind === "ready" ? role.caller : undefined;
  const [mine, setMine] = useState(false);
  usePageTitle(family === undefined ? "Add provider key" : `Add ${familyName(family)} key`);

  return (
    <div className={styles["page"]}>
      <header className={styles["head"]}>
        <Back />
        <div>
          {family === undefined ? null : <p className={styles["provider"]}>{familyName(family)}</p>}
          <h1 className={styles["name"]}>
            {family === undefined ? "Add a provider key" : "New key group"}
          </h1>
        </div>
      </header>
      {family === undefined ? (
        <Section title="Provider">
          <ul className={styles["families"]}>
            {FAMILY_ORDER.map((candidate) => (
              <li key={candidate}>
                <Link to="/keys/new" search={{ family: candidate }} className={styles["family"]}>
                  <span className={styles["familyName"]}>{familyName(candidate)}</span>
                  <span className={styles["familyNote"]}>{FAMILY_NOTES[candidate]}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      ) : (
        <Loaded>
          {(list) => (
            <>
              <Ownership
                caller={caller}
                noun="Provider key group"
                chosen={mine}
                onChange={setMine}
              />
              <GroupForm
                key={`${family}:${list.version}`}
                family={family}
                view={undefined}
                privately={addsPrivately(caller, mine)}
                onReload={retry}
              />
            </>
          )}
        </Loaded>
      )}
    </div>
  );
};
