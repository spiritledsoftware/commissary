// A toolkit's settings, for its managers (#208): its name, which credentials an org toolkit accepts and an OpenAPI
// toolkit's base URL; its OAuth app (#202), for a service that offers no client registration; and removing it. Each
// edit names the revision it was based on, so one made meanwhile is refused (`409 conflict`) rather than overwritten.
import { useNavigate } from "@tanstack/react-router";
import { Schema } from "effect";
import { type FormEvent, useId, useState } from "react";
import {
  type CredentialsAccepted,
  SetOAuthApp,
  type ToolkitView,
  type UpdateToolkit,
} from "@commissary/contract/tools";
import {
  clearOAuthAppAtom,
  removeToolkitAtom,
  setOAuthAppAtom,
  TOOLKITS,
  updateToolkitAtom,
} from "../api/client.ts";
import { type ConfirmRequest, ConfirmDialog } from "../components/Confirm.tsx";
import { kit, Problem, Section } from "../components/Kit.tsx";
import {
  type FieldValues,
  FORM_PROBLEM,
  type FormField,
  type FormResult,
  readFields,
  withoutSecrets,
} from "../lib/toolkit-credentials.ts";
import { ACCEPTS, isAccepted, problemOf, toolkitNameProblem } from "../lib/toolkits.ts";
import { useAction } from "../lib/use-action.ts";
import { SpecField, SpecFields } from "./ToolkitFields.tsx";
import styles from "./Tools.module.css";

/** A body built a field at a time. */
type Writable<T> = { -readonly [K in keyof T]: T[K] };

const ifMatch = (toolkit: ToolkitView) => ({ "if-match": String(toolkit.revision) });

/** What the general form changes: only the fields that differ from the toolkit's. */
const generalPatch = (
  toolkit: ToolkitView,
  form: { readonly name: string; readonly accepts: CredentialsAccepted; readonly baseUrl: string },
): UpdateToolkit => {
  const patch: Writable<UpdateToolkit> = {};
  const name = form.name.trim();
  const base = form.baseUrl.trim();

  if (name !== toolkit.name) patch.name = name;

  if (!toolkit.private && form.accepts !== toolkit.accepts) patch.accepts = form.accepts;

  if (toolkit.kind === "openapi" && base !== (toolkit.base_url ?? ""))
    patch.base_url = base === "" ? null : base;

  return patch;
};

/** Its name, what an org toolkit accepts, and an OpenAPI toolkit's base URL; only what changed is sent. */
const General = ({ toolkit }: { readonly toolkit: ToolkitView }) => {
  const id = useId();
  const update = useAction(updateToolkitAtom);
  const [name, setName] = useState(toolkit.name);
  const [accepts, setAccepts] = useState(toolkit.accepts);
  const [baseUrl, setBaseUrl] = useState(toolkit.base_url ?? "");
  const [problems, setProblems] = useState<Readonly<Record<string, string>>>({});
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [saved, setSaved] = useState(false);
  const patch = generalPatch(toolkit, { name, accepts, baseUrl });

  const changed = Object.keys(patch).length > 0;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(undefined);
    setSaved(false);
    const badName = name.trim() === "" ? "A toolkit needs a name." : toolkitNameProblem(name);

    setProblems(badName === undefined ? {} : { name: badName });

    if (badName !== undefined || !changed) return;

    const outcome = await update.run({
      params: { id: toolkit.id },
      headers: ifMatch(toolkit),
      payload: patch,
      reactivityKeys: TOOLKITS,
    });

    if (outcome.ok) {
      setSaved(true);

      return;
    }

    const said = problemOf(outcome) ?? outcome.message;

    if (outcome.error === "name_taken") setProblems({ name: said });
    else if (outcome.path === "base_url") setProblems({ base_url: said });
    else setProblem(said);
  };

  return (
    <form className={styles["form"]} onSubmit={(event) => void submit(event)} noValidate>
      <SpecField
        spec={{
          key: "name",
          label: "Name",
          secret: false,
          optional: false,
          hint: "Its tools are called <name>_<tool>: clients see the new names at once.",
        }}
        value={name}
        problem={problems["name"]}
        onChange={(value) => {
          setName(value);
          setSaved(false);
        }}
      />
      {toolkit.private ? null : (
        <div className={styles["field"]}>
          <label className={kit["fieldLabel"]} htmlFor={`${id}-accepts`}>
            Credentials it accepts
          </label>
          <select
            id={`${id}-accepts`}
            className={kit["input"]}
            value={accepts}
            onChange={(event) => {
              if (isAccepted(event.target.value)) setAccepts(event.target.value);
              setSaved(false);
            }}
          >
            {ACCEPTS.map((each) => (
              <option key={each.value} value={each.value}>
                {each.label}
              </option>
            ))}
          </select>
          <span className={styles["hint"]}>
            A credential it no longer accepts is kept, but not used.
          </span>
        </div>
      )}
      {toolkit.kind === "openapi" ? (
        <SpecField
          spec={{
            key: "base_url",
            label: "Base URL",
            secret: false,
            optional: true,
            hint: "Calls go here in place of the servers its document names. Empty: the document's.",
          }}
          value={baseUrl}
          problem={problems["base_url"]}
          onChange={(value) => {
            setBaseUrl(value);
            setSaved(false);
          }}
        />
      ) : null}
      {problem === undefined ? null : <Problem>{problem}</Problem>}
      <div className={styles["actions"]}>
        <button
          type="submit"
          className={kit["primary"]}
          disabled={update.busy || !changed}
          aria-busy={update.busy}
        >
          {update.busy ? "Saving…" : "Save"}
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

const APP_FIELDS: ReadonlyArray<FormField> = [
  { key: "client_id", label: "Client ID", secret: false, optional: false },
  {
    key: "client_secret",
    label: "Client secret",
    secret: true,
    optional: true,
    hint: "Empty: a public client, which signs in with PKCE only. Never shown again.",
  },
  { key: "authorize_url", label: "Authorization URL", secret: false, optional: false },
  { key: "token_url", label: "Token URL", secret: false, optional: false },
  {
    key: "scopes",
    label: "Scopes",
    secret: false,
    optional: true,
    hint: "Separated by spaces. Empty: those its tools name.",
  },
  {
    key: "issuer",
    label: "Issuer",
    secret: false,
    optional: true,
    hint: "When set, a sign-in's answer must name it.",
  },
  {
    key: "request_token_url",
    label: "Request token URL",
    secret: false,
    optional: true,
    hint: "An OAuth 1.0a service only: the app is then a consumer, its key the client ID.",
  },
];

const appValues = (toolkit: ToolkitView): FieldValues => {
  const app = toolkit.oauth_app;

  if (app === undefined) return {};

  return {
    client_id: app.client_id,
    authorize_url: app.authorize_url,
    token_url: app.token_url,
    scopes: app.scopes.join(" "),
    issuer: app.issuer ?? "",
    request_token_url: app.request_token_url ?? "",
  };
};

const isSetOAuthApp = Schema.is(SetOAuthApp);

/** The body of `PUT /toolkits/:id/oauth-app`, or what is missing; its scopes are typed space separated. */
const appBody = (values: FieldValues): FormResult<SetOAuthApp> => {
  const read = readFields(APP_FIELDS, values);

  if (!read.ok) return read;
  const { scopes, ...rest } = read.body;
  const body = scopes === undefined ? rest : { ...rest, scopes: scopes.split(/\s+/) };

  return isSetOAuthApp(body)
    ? { ok: true, body }
    : { ok: false, problems: { [FORM_PROBLEM]: "The form does not make an OAuth app." } };
};

/** The toolkit's OAuth app: set, replaced whole (its secret typed again) or cleared. */
const OAuthApp = ({ toolkit }: { readonly toolkit: ToolkitView }) => {
  const set = useAction(setOAuthAppAtom);
  const clear = useAction(clearOAuthAppAtom);
  const app = toolkit.oauth_app;
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<FieldValues>(() => appValues(toolkit));
  const [problems, setProblems] = useState<Readonly<Record<string, string>>>({});
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const busy = set.busy || clear.busy;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(undefined);
    const body = appBody(values);

    setProblems(body.ok ? {} : body.problems);

    if (!body.ok) {
      setProblem(body.problems[FORM_PROBLEM]);

      return;
    }

    const outcome = await set.run({
      params: { id: toolkit.id },
      payload: body.body,
      reactivityKeys: TOOLKITS,
    });

    if (outcome.ok) close();
    else if (outcome.path !== undefined && APP_FIELDS.some((field) => field.key === outcome.path))
      setProblems({ [outcome.path]: problemOf(outcome) ?? outcome.message });
    else setProblem(problemOf(outcome));
  };

  // Closing the form keeps nothing secret that was typed in it.
  const close = () => {
    setOpen(false);
    setValues((now) => withoutSecrets(APP_FIELDS, now));
  };

  const remove = async () => {
    setProblem(undefined);
    const outcome = await clear.run({ params: { id: toolkit.id }, reactivityKeys: TOOLKITS });

    setProblem(problemOf(outcome));
  };

  return (
    <div className={styles["slot"]}>
      <h3 className={styles["slotTitle"]}>OAuth app</h3>
      <p className={styles["lead"]}>
        For a service that does not let Commissary register itself (Slack, GitHub, Google): sign-ins
        then go through the app you registered with it.
        {toolkit.managed_oauth_app === true
          ? " Without one, sign-ins use Commissary Cloud's app with the service."
          : ""}
      </p>
      <p className={styles["state"]}>
        {app === undefined
          ? "None set."
          : `Set: client ${app.client_id}, ${app.client_secret ? "with" : "without"} a secret.`}
      </p>
      {open ? (
        <form className={styles["form"]} onSubmit={(event) => void submit(event)} noValidate>
          <SpecFields
            specs={APP_FIELDS}
            values={values}
            problems={problems}
            onChange={(key, value) => setValues((now) => ({ ...now, [key]: value }))}
          />
          {app?.client_secret === true ? (
            <p className={styles["hint"]}>
              Saving replaces the app whole: type its secret again to keep one.
            </p>
          ) : null}
          {problem === undefined ? null : <Problem>{problem}</Problem>}
          <div className={styles["actions"]}>
            <button type="submit" className={kit["primary"]} disabled={busy} aria-busy={set.busy}>
              {set.busy ? "Saving…" : "Save the app"}
            </button>
            <button type="button" className={kit["secondary"]} disabled={busy} onClick={close}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className={styles["actions"]}>
          <button type="button" className={kit["secondary"]} onClick={() => setOpen(true)}>
            {app === undefined ? "Set an OAuth app" : "Replace"}
          </button>
          {app === undefined ? null : (
            <button
              type="button"
              className={kit["danger"]}
              disabled={busy}
              aria-busy={clear.busy}
              onClick={() => void remove()}
            >
              {clear.busy ? "Clearing…" : "Clear"}
            </button>
          )}
        </div>
      )}
      {open || problem === undefined ? null : <Problem>{problem}</Problem>}
    </div>
  );
};

const Remove = ({ toolkit }: { readonly toolkit: ToolkitView }) => {
  const navigate = useNavigate();
  const remove = useAction(removeToolkitAtom);
  const [confirm, setConfirm] = useState<ConfirmRequest | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const ask = () =>
    setConfirm({
      title: `Remove ${toolkit.name}?`,
      body: (
        <p>
          Its credentials, tool list and tool edits are deleted at once, and clients lose its tools.
          {toolkit.private
            ? ""
            : " Its tool grants, pending approvals and Spend limits go with it."}
        </p>
      ),
      action: "Remove",
      busyAction: "Removing…",
      run: async () => {
        const outcome = await remove.run({
          params: { id: toolkit.id },
          headers: ifMatch(toolkit),
          reactivityKeys: TOOLKITS,
        });

        if (outcome.ok) await navigate({ to: "/tools" });
        else setProblem(problemOf(outcome));
      },
    });

  return (
    <div className={styles["slot"]}>
      <h3 className={styles["slotTitle"]}>Remove the toolkit</h3>
      <button type="button" className={kit["danger"]} disabled={remove.busy} onClick={ask}>
        Remove {toolkit.name}
      </button>
      {problem === undefined ? null : <Problem>{problem}</Problem>}
      <ConfirmDialog request={confirm} busy={remove.busy} onClose={() => setConfirm(undefined)} />
    </div>
  );
};

export const ToolkitSettings = ({ toolkit }: { readonly toolkit: ToolkitView }) => (
  <Section title="Settings" className={styles["section"]}>
    <General key={toolkit.revision} toolkit={toolkit} />
    <OAuthApp key={toolkit.oauth_app?.updated_at ?? "none"} toolkit={toolkit} />
    <Remove toolkit={toolkit} />
  </Section>
);
