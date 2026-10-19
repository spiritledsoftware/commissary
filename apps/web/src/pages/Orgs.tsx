// The org chooser: the panel's address without an org (`/`) when the caller manages several, or asked for it
// (`/?choose`). Each org opens its panel (`/o/<slug>/`); a platform admin (or anyone, on Commissary Cloud, up to their
// limit) also creates orgs here, and a platform admin of Commissary Cloud suspends them.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { type FormEvent, useId, useState } from "react";
import type { Me } from "@commissary/contract/orgs";
import { createOrgAtom, meAtom, ORGS, orgListAtom, updateOrgAtom } from "../api/client.ts";
import { ConfirmDialog, type ConfirmRequest } from "../components/Confirm.tsx";
import { kit, Problem } from "../components/Kit.tsx";
import { SignOut } from "../components/SignOut.tsx";
import {
  atOrgLimit,
  canCreateOrg,
  canSuspend,
  orgCountText,
  orgLimitNote,
  orgProblem,
} from "../lib/hosted.ts";
import { orgPanelPath } from "../lib/org.ts";
import { useAction } from "../lib/use-action.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import styles from "./Orgs.module.css";

const NewOrg = ({ me }: { readonly me: Me }) => {
  const create = useAction(createOrgAtom);
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [privateCredentials, setPrivateCredentials] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const ids = useId();
  const full = atOrgLimit(me);
  const count = orgCountText(me);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(undefined);

    if (full) return;

    const outcome = await create.run({
      payload: {
        slug: slug.trim().toLowerCase(),
        name: name.trim(),
        private_credentials: privateCredentials,
      },
      reactivityKeys: ORGS,
    });

    if (outcome.ok) {
      window.location.assign(orgPanelPath(outcome.value.slug));

      return;
    }

    setProblem(orgProblem(outcome.error, outcome.message, outcome.detail));
  };

  return (
    <form className={styles["create"]} onSubmit={submit} aria-label="Create an org">
      <h2 className={kit["sectionTitle"]}>New org</h2>
      {count === undefined ? null : (
        <p className={kit["muted"]} role="status">
          You own {count}.
        </p>
      )}
      {full ? <p className={kit["fieldError"]}>{orgLimitNote(me)}</p> : null}
      <label className={kit["field"]} htmlFor={`${ids}-name`}>
        <span className={kit["fieldLabel"]}>Name</span>
        <input
          id={`${ids}-name`}
          className={kit["input"]}
          value={name}
          maxLength={100}
          required
          disabled={full}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className={kit["field"]} htmlFor={`${ids}-slug`}>
        <span className={kit["fieldLabel"]}>Address</span>
        <input
          id={`${ids}-slug`}
          className={kit["input"]}
          value={slug}
          maxLength={63}
          required
          disabled={full}
          autoCapitalize="none"
          spellCheck={false}
          placeholder="acme"
          aria-invalid={problem !== undefined}
          onChange={(event) => setSlug(event.target.value)}
        />
      </label>
      <p className={kit["muted"]}>
        Lowercase letters, digits and hyphens; the panel opens at /o/{slug.trim() || "acme"}/.
      </p>
      <label className={styles["choice"]} htmlFor={`${ids}-private`}>
        <input
          id={`${ids}-private`}
          type="checkbox"
          checked={privateCredentials}
          disabled={full}
          onChange={(event) => setPrivateCredentials(event.target.checked)}
        />
        <span>Let members connect private accounts and provider keys</span>
      </label>
      <p className={kit["muted"]}>
        A private account or provider key is used only for its owner&rsquo;s requests; org admins
        see that it exists, not how it is used. Org admins can change this later.
      </p>
      {problem === undefined ? null : <p className={kit["fieldError"]}>{problem}</p>}
      <div>
        <button type="submit" className={kit["primary"]} disabled={create.busy || full}>
          {create.busy ? "Creating…" : "Create org"}
        </button>
      </div>
    </form>
  );
};

/** One org of the list, with (for a hosted platform admin) its suspension and the button that changes it. */
const OrgRow = ({
  slug,
  name,
  suspended,
  onSuspension,
}: {
  readonly slug: string;
  readonly name: string;
  readonly suspended: boolean | undefined;
  /** Present for platform admins of Commissary Cloud. */
  readonly onSuspension: (() => void) | undefined;
}) => (
  <li className={styles["row"]}>
    <a className={styles["org"]} href={orgPanelPath(slug)}>
      <span className={styles["orgName"]}>
        {name}
        {suspended === true ? <span className={styles["state"]}>Suspended</span> : null}
      </span>
      <span className={styles["orgSlug"]}>/o/{slug}</span>
    </a>
    {onSuspension === undefined ? null : (
      <button
        type="button"
        className={kit["secondary"]}
        aria-label={`${suspended === true ? "Unsuspend" : "Suspend"} ${name}`}
        onClick={onSuspension}
      >
        {suspended === true ? "Unsuspend" : "Suspend"}
      </button>
    )}
  </li>
);

const OrgList = ({ me }: { readonly me: Me }) => {
  const suspendable = canSuspend(me);
  const registry = useAtomValue(orgListAtom);
  const update = useAction(updateOrgAtom);
  const [confirm, setConfirm] = useState<ConfirmRequest | undefined>(undefined);
  const [note, setNote] = useState<string | undefined>(undefined);

  const suspensions = new Map(
    suspendable && AsyncResult.isSuccess(registry)
      ? registry.value.orgs.map((org) => [org.slug, org.suspended === true] as const)
      : [],
  );

  const ask = (slug: string, name: string, suspended: boolean) => {
    setNote(undefined);

    setConfirm({
      title: `${suspended ? "Unsuspend" : "Suspend"} ${name}?`,
      body: suspended ? (
        <p>Its members can use the org and its API keys work again. Nothing was deleted.</p>
      ) : (
        <p>
          Everyone in {name} is signed out of it and its API and management keys are refused until
          you unsuspend it. Nothing is deleted.
        </p>
      ),
      action: suspended ? "Unsuspend org" : "Suspend org",
      busyAction: suspended ? "Unsuspending…" : "Suspending…",
      run: async () => {
        const outcome = await update.run({
          params: { slug },
          payload: { suspended: !suspended },
          reactivityKeys: ORGS,
        });

        setNote(
          outcome.ok
            ? `${suspended ? "Unsuspended" : "Suspended"} ${name}.`
            : `Could not change ${name}. ${orgProblem(outcome.error, outcome.message, outcome.detail)}`,
        );
      },
    });
  };

  return (
    <>
      <ul className={styles["list"]}>
        {me.orgs.map((org) => {
          const suspended = suspensions.get(org.slug);

          return (
            <OrgRow
              key={org.slug}
              slug={org.slug}
              name={org.name}
              suspended={suspended}
              onSuspension={
                suspendable && suspended !== undefined
                  ? () => ask(org.slug, org.name, suspended)
                  : undefined
              }
            />
          );
        })}
      </ul>
      <p className={kit["muted"]} role="status">
        {note}
      </p>
      <ConfirmDialog request={confirm} busy={update.busy} onClose={() => setConfirm(undefined)} />
    </>
  );
};

export const OrgsPage = () => {
  usePageTitle("Choose an org");
  const result = useAtomValue(meAtom);
  const retry = useAtomRefresh(meAtom);

  return (
    <main id="main" className={styles["page"]}>
      <h1 className={styles["title"]}>Choose an org</h1>
      {AsyncResult.match(result, {
        onInitial: () => (
          <p className={kit["muted"]} aria-busy="true">
            Loading orgs…
          </p>
        ),
        onFailure: () => <Problem onRetry={retry}>Could not load your orgs.</Problem>,
        onSuccess: ({ value }) => (
          <>
            {value.orgs.length === 0 ? (
              <p className={kit["muted"]}>
                {canCreateOrg(value)
                  ? "You are not in an org yet. Create one below."
                  : "You do not manage any org."}
              </p>
            ) : (
              <OrgList me={value} />
            )}
            {canCreateOrg(value) ? <NewOrg me={value} /> : null}
            {canSuspend(value) ? (
              <p>
                <a className={styles["link"]} href="/people">
                  People: org limits and suspension
                </a>
              </p>
            ) : null}
            {value.deployment.hosted ? <SignOut className={kit["secondary"]} /> : null}
          </>
        ),
      })}
    </main>
  );
};
