// Single sign-on (/settings/sso, Commissary Cloud only): the org's own identity provider (OpenID Connect or SAML) and the
// email domains whose people sign in through it, optionally refusing GitHub and Google for them. Org admins read;
// org owners change (the server enforces it again). The settings never carry the client secret, and nothing here
// shows one: a saved OpenID Connect provider says its secret is stored and takes a blank secret to keep it.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { kit, Problem, Section } from "../components/Kit.tsx";
import { failureMessage } from "../lib/failure.ts";
import { canManageMembers, roleAs } from "../lib/role.ts";
import { canChangeSso } from "../lib/sso.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import { meAtom, ssoAtom } from "../api/client.ts";
import { useRole } from "../lib/use-role.ts";
import { NotAllowed } from "./NotAllowed.tsx";
import styles from "./Sso.module.css";
import { DomainsSection } from "./SsoDomains.tsx";
import { ProviderSection } from "./SsoProvider.tsx";

const Body = ({ owner }: { readonly owner: boolean }) => {
  const result = useAtomValue(ssoAtom);
  const retry = useAtomRefresh(ssoAtom);

  if (AsyncResult.isFailure(result))
    return (
      <Problem onRetry={retry}>Could not load single sign-on. {failureMessage(result)}</Problem>
    );

  if (!AsyncResult.isSuccess(result))
    return (
      <p className={kit["muted"]} aria-busy="true">
        Loading single sign-on…
      </p>
    );

  return (
    <>
      <Section title="Identity provider">
        <ProviderSection settings={result.value} owner={owner} />
      </Section>
      <Section title="Domains">
        <DomainsSection settings={result.value} owner={owner} />
      </Section>
    </>
  );
};

export const SsoPage = () => {
  usePageTitle("Single sign-on");
  const role = useRole();
  const me = useAtomValue(meAtom);

  if (role.kind !== "ready") return null;

  if (!canManageMembers(role.caller)) return <NotAllowed home="/usage" />;
  const owner = canChangeSso(role.caller);

  // Self-hosted proxies have no such routes: Cloudflare Access configures their identity providers.
  if (AsyncResult.isSuccess(me) && !me.value.deployment.hosted)
    return (
      <div className={kit["page"]}>
        <header className={styles["head"]}>
          <h1 className={styles["title"]}>Single sign-on</h1>
          <p className={styles["intro"]}>
            Single sign-on is part of the hosted service. On a self-hosted Commissary, Cloudflare
            Access decides who may sign in.
          </p>
        </header>
      </div>
    );

  return (
    <div className={kit["page"]}>
      <header className={styles["head"]}>
        <h1 className={styles["title"]}>Single sign-on</h1>
        <p className={styles["intro"]}>
          Let your people sign in with the identity provider your organization already uses, instead
          of GitHub or Google. Prove the email domains you own, set your provider (OpenID Connect or
          SAML), then require it per domain.{" "}
          {owner
            ? "As an org owner you can change all of this."
            : `Only an org owner can change this; you are ${roleAs(role.caller.role)}, so you can read it.`}
        </p>
      </header>
      <Body owner={owner} />
    </div>
  );
};
