// The consent page of an MCP client's sign-in on Commissary Cloud (#200, `/authorize`, the OAuth server's authorization
// endpoint): an MCP client sends the member here with its request; the page asks the server who the client is (`POST
// /mcp-sign-ins`), shows it, lets the member pick the tools it may use, and allows it (an API key of the member named
// after the client, with that tool scope) or denies it. Either way the browser goes back to the client. Opened without
// an org, it asks which org the client signs in to first (`AuthorizeOrgChooser`). A self-hosted Commissary has no such
// page: Access signs its MCP clients in.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Check, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { McpSignInClient } from "@commissary/contract/mcp-sign-ins";
import {
  API_KEYS,
  approveMcpSignInAtom,
  beginMcpSignInAtom,
  denyMcpSignInAtom,
  meAtom,
  usableToolsAtom,
} from "../api/client.ts";
import { kit, Problem, Section } from "../components/Kit.tsx";
import { ToolScopeEditor } from "../components/ToolScopeEditor.tsx";
import {
  authorizeQuery,
  clientName,
  consentPageOf,
  consentProblem,
  identityNote,
  isAuthorizeRequest,
  redirectNote,
} from "../lib/consent.ts";
import { failureMessage } from "../lib/failure.ts";
import { EVERY_TOOL, type ScopeDraft, scopeOfDraft } from "../lib/tool-scope.ts";
import { type Outcome, useAction } from "../lib/use-action.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import styles from "./Authorize.module.css";

/** Where the sign-in stands on this page. */
type Step =
  | { readonly kind: "starting" }
  | { readonly kind: "consent"; readonly handle: string; readonly client: McpSignInClient }
  | { readonly kind: "leaving" }
  | { readonly kind: "refused"; readonly message: string };

const refusalOf = (outcome: Outcome<unknown> & { readonly ok: false }): Step => ({
  kind: "refused",
  message: consentProblem(outcome.error, outcome.message, outcome.detail),
});

const NotStarted = () => (
  <p className={kit["muted"]}>
    This page is where an app asks to use Commissary for you. Start signing in from the app; it
    opens this page with its request.
  </p>
);

/** The tools the client may use: every tool the member may, or the ones they pick. */
const Tools = ({
  draft,
  onChange,
  disabled,
}: {
  readonly draft: ScopeDraft;
  readonly onChange: (draft: ScopeDraft) => void;
  readonly disabled: boolean;
}) => {
  const usable = useAtomValue(usableToolsAtom);
  const retry = useAtomRefresh(usableToolsAtom);

  if (AsyncResult.isSuccess(usable))
    return (
      <ToolScopeEditor
        usable={usable.value}
        draft={draft}
        onChange={onChange}
        disabled={disabled}
        subject="The app"
      />
    );

  return AsyncResult.isFailure(usable) ? (
    <Problem onRetry={retry}>Could not load your tools. {failureMessage(usable)}</Problem>
  ) : (
    <p className={kit["muted"]} aria-busy="true">
      Loading your tools…
    </p>
  );
};

const Consent = ({
  handle,
  client,
  onStep,
}: {
  readonly handle: string;
  readonly client: McpSignInClient;
  readonly onStep: (step: Step) => void;
}) => {
  const approve = useAction(approveMcpSignInAtom);
  const deny = useAction(denyMcpSignInAtom);
  const [draft, setDraft] = useState<ScopeDraft>(EVERY_TOOL);
  const busy = approve.busy || deny.busy;
  const name = clientName(client);

  const leave = (outcome: Outcome<{ readonly redirect_to: string }>) => {
    if (!outcome.ok) {
      onStep(refusalOf(outcome));

      return;
    }

    onStep({ kind: "leaving" });
    window.location.assign(outcome.value.redirect_to);
  };

  return (
    <div className={styles["consent"]}>
      <div className={styles["client"]}>
        <p className={styles["ask"]}>
          <strong className={styles["clientName"]}>{name}</strong> wants to use Commissary&rsquo;s
          tools as you, in this org.
        </p>
        <p className={kit["muted"]}>{identityNote(client)}</p>
        <p className={kit["muted"]}>{redirectNote(client)}</p>
        <p className={kit["muted"]}>
          Allowing it creates an API key named after it, which you can change or revoke on the API
          keys page; revoking it signs the app out.
        </p>
      </div>
      <Tools draft={draft} onChange={setDraft} disabled={busy} />
      <div className={styles["actions"]}>
        <button
          type="button"
          className={kit["primary"]}
          disabled={busy}
          aria-busy={approve.busy}
          onClick={async () =>
            leave(
              await approve.run({
                payload: { handle, tool_scope: scopeOfDraft(draft) },
                reactivityKeys: API_KEYS,
              }),
            )
          }
        >
          <Check aria-hidden="true" size={18} strokeWidth={2.5} />
          {approve.busy ? "Allowing…" : `Allow ${name}`}
        </button>
        <button
          type="button"
          className={kit["secondary"]}
          disabled={busy}
          aria-busy={deny.busy}
          onClick={async () => leave(await deny.run({ payload: { handle } }))}
        >
          <X aria-hidden="true" size={18} strokeWidth={2.5} />
          {deny.busy ? "Denying…" : "Deny"}
        </button>
      </div>
    </div>
  );
};

/** `/authorize` in an org: starts the sign-in once, then asks. */
export const AuthorizePage = () => {
  usePageTitle("Allow an app");
  const begin = useAction(beginMcpSignInAtom);
  const [step, setStep] = useState<Step>({ kind: "starting" });
  const search = window.location.search;
  const started = useRef(false);
  const request = isAuthorizeRequest(search);

  useEffect(() => {
    if (!request || started.current) return;
    started.current = true;

    void begin.run({ payload: { query: authorizeQuery(search) } }).then((outcome) => {
      if (!outcome.ok) {
        setStep(refusalOf(outcome));

        return;
      }

      if (outcome.value.kind === "redirect") {
        // A request the client must fix: it hears why at its redirect URI.
        setStep({ kind: "leaving" });
        window.location.assign(outcome.value.redirect_to);

        return;
      }

      setStep({ kind: "consent", handle: outcome.value.handle, client: outcome.value.client });
    });
  }, [begin, request, search]);

  return (
    <div className={kit["page"]}>
      <header className={styles["head"]}>
        <h1 className={styles["title"]}>Allow an app</h1>
      </header>
      <Section title="Sign-in request">
        {!request ? (
          <NotStarted />
        ) : step.kind === "starting" ? (
          <p className={kit["muted"]} aria-busy="true">
            Checking the app&rsquo;s request…
          </p>
        ) : step.kind === "leaving" ? (
          <p className={kit["muted"]} aria-busy="true">
            Going back to the app…
          </p>
        ) : step.kind === "refused" ? (
          <Problem>{step.message}</Problem>
        ) : (
          <Consent handle={step.handle} client={step.client} onStep={setStep} />
        )}
      </Section>
    </div>
  );
};

/** `/authorize` without an org (the caller belongs to several): which org the app signs in to. */
export const AuthorizeOrgChooser = () => {
  usePageTitle("Allow an app");
  const me = useAtomValue(meAtom);
  const retry = useAtomRefresh(meAtom);
  const search = window.location.search;

  return (
    <main className={styles["chooser"]}>
      <h1 className={styles["title"]}>Allow an app</h1>
      {!isAuthorizeRequest(search) ? (
        <NotStarted />
      ) : AsyncResult.isSuccess(me) ? (
        <>
          <p className={kit["muted"]}>
            Choose the org the app signs in to. It gets an API key there, and uses the tools you may
            use in that org.
          </p>
          <ul className={styles["orgs"]}>
            {me.value.orgs.map((org) => (
              <li key={org.slug}>
                <a className={styles["org"]} href={consentPageOf(org.slug, search)}>
                  <span className={styles["orgName"]}>{org.name}</span>
                  <span className={kit["muted"]}>/o/{org.slug}</span>
                </a>
              </li>
            ))}
          </ul>
        </>
      ) : AsyncResult.isFailure(me) ? (
        <Problem onRetry={retry}>Could not load your orgs. {failureMessage(me)}</Problem>
      ) : (
        <p className={kit["muted"]} aria-busy="true">
          Loading your orgs…
        </p>
      )}
    </main>
  );
};
