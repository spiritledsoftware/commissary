// Members (/members): who belongs to the org and with which role, the teams they are on, the service tokens that may
// call the management API, and whether people join by themselves. Org admins manage plain members and teams; org
// owners also change roles, add org admins and org owners, and decide on auto-join and on whether the client API
// accept an Access sign-in. The server enforces every rule again: the page only offers what the caller's role allows,
// and says why when a choice is missing.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";
import type { MembershipSettings } from "@commissary/contract/members";
import {
  MEMBERS,
  membershipAtom,
  ORGS,
  TOOLKITS,
  membersAtom,
  serviceTokensAtom,
  teamsAtom,
  updateMembershipAtom,
} from "../api/client.ts";
import { kit, Problem, Section } from "../components/Kit.tsx";
import { failureMessage } from "../lib/failure.ts";
import {
  PRIVATE_SWITCH_ORDER,
  PRIVATE_SWITCHES,
  type PrivateSetting,
  privateSettingPatch,
} from "../lib/members.ts";
import { type Caller, canManageMembers, canSetAutoJoin, roleAs } from "../lib/role.ts";
import { useAction } from "../lib/use-action.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import { useRole } from "../lib/use-role.ts";
import styles from "./Members.module.css";
import { NoteLine, useNote } from "./MembersNote.tsx";
import { People } from "./MembersPeople.tsx";
import { ServiceTokens } from "./MembersTokens.tsx";
import { Teams } from "./MembersTeams.tsx";
import { NotAllowed } from "./NotAllowed.tsx";

/** What a list that is not there yet shows: its loading, or its failure with a retry. */
const Waiting = ({
  result,
  retry,
  what,
}: {
  readonly result: AsyncResult.AsyncResult<unknown, unknown>;
  readonly retry: () => void;
  readonly what: string;
}) =>
  AsyncResult.isFailure(result) ? (
    <Problem onRetry={retry}>
      Could not load {what}. {failureMessage(result)}
    </Problem>
  ) : (
    <p className={kit["muted"]} aria-busy="true">
      Loading {what}…
    </p>
  );

/** One list's loading, its failure with a retry, and its content. */
const Loaded = <A, E>({
  result,
  retry,
  what,
  children,
}: {
  readonly result: AsyncResult.AsyncResult<A, E>;
  readonly retry: () => void;
  readonly what: string;
  readonly children: (value: A) => ReactNode;
}) =>
  AsyncResult.isSuccess(result) ? (
    children(result.value)
  ) : (
    <Waiting result={result} retry={retry} what={what} />
  );

/** One owner-only membership setting: a checkbox that saves just itself (the write is a partial patch), and what it does. */
const MembershipToggle = ({
  caller,
  setting,
  label,
  what,
  describe,
  said,
  ownerNote,
}: {
  readonly caller: Caller;
  readonly setting: keyof MembershipSettings;
  readonly label: string;
  readonly what: string;
  /** What the setting means in its current state. */
  readonly describe: (on: boolean) => string;
  /** What changed, said after a save. */
  readonly said: (on: boolean) => string;
  /** Said to an org owner after the description. */
  readonly ownerNote?: string;
}) => {
  const result = useAtomValue(membershipAtom);
  const retry = useAtomRefresh(membershipAtom);
  const save = useAction(updateMembershipAtom);
  const { note, settle, clear } = useNote();
  const owner = canSetAutoJoin(caller);

  return (
    <Loaded result={result} retry={retry} what={what}>
      {(settings) => {
        const on = settings[setting];

        // `access_clients` exists in the first org only (an Access sign-in reaches no other).
        if (on === undefined) return null;

        return (
          <>
            <label className={styles["toggle"]}>
              <input
                type="checkbox"
                checked={on}
                disabled={!owner || save.busy}
                onChange={async (event) => {
                  clear();

                  settle(
                    await save.run({
                      payload: { [setting]: event.target.checked },
                      reactivityKeys: MEMBERS,
                    }),
                    said(event.target.checked),
                  );
                }}
              />
              <span>{label}</span>
            </label>
            <p className={kit["muted"]}>
              {describe(on)}{" "}
              {owner
                ? (ownerNote ?? "")
                : `Only an org owner can change this; you are ${roleAs(caller.role)}.`}
            </p>
            <NoteLine note={note} />
          </>
        );
      }}
    </Loaded>
  );
};

/**
 * Whether plain members may connect private accounts and provider keys (ADR 0023) or add private toolkits (#209, ADR
 * 0038); org admins decide, each setting on its own.
 */
const PrivateSwitchSetting = ({ setting }: { readonly setting: PrivateSetting }) => {
  const result = useAtomValue(membershipAtom);
  const retry = useAtomRefresh(membershipAtom);
  const save = useAction(updateMembershipAtom);
  const { note, settle, clear } = useNote();
  const control = PRIVATE_SWITCHES[setting];

  return (
    <Loaded result={result} retry={retry} what={control.what}>
      {(settings) => {
        const on = settings[setting];

        return (
          <>
            <label className={styles["toggle"]}>
              <input
                type="checkbox"
                checked={on}
                disabled={save.busy}
                onChange={async (event) => {
                  clear();

                  settle(
                    await save.run({
                      payload: privateSettingPatch(setting, event.target.checked),
                      // The panel's pages for plain members follow the setting (`GET /me`).
                      // The toolkits a member may add follow the setting (`GET /toolkits`, `GET /tools`).
                      reactivityKeys:
                        setting === "private_toolkits"
                          ? [...MEMBERS, ...ORGS, ...TOOLKITS]
                          : [...MEMBERS, ...ORGS],
                    }),
                    control.said(event.target.checked),
                  );
                }}
              />
              <span>{control.label}</span>
            </label>
            <p className={kit["muted"]}>{control.describe(on)}</p>
            <NoteLine note={note} />
          </>
        );
      }}
    </Loaded>
  );
};

const AutoJoin = ({ caller }: { readonly caller: Caller }) => (
  <MembershipToggle
    caller={caller}
    setting="auto_join"
    label="Let everyone Access admits join as a member"
    what="the joining setting"
    describe={(on) =>
      on
        ? "On: anyone Cloudflare Access lets in joins this org as a plain member on their first request, and a service token Access admits is let in as a member without being registered."
        : "Off: only people and service tokens listed here can use this org; anyone else Access admits is turned away."
    }
    said={(on) =>
      on ? "Everyone Access admits now joins as a member." : "Only people you add can join now."
    }
    ownerNote="Existing members and their roles do not change."
  />
);

const AccessClients = ({ caller }: { readonly caller: Caller }) => (
  <MembershipToggle
    caller={caller}
    setting="access_clients"
    label="Accept an Access sign-in on the client API"
    what="the client API sign-in setting"
    describe={(on) =>
      on
        ? "On: the client API still accepts an Access sign-in (cloudflared's cf-access-token) instead of an API key, for clients set up before API keys. Turn it off once every client sends an API key, so only keys open Commissary."
        : "Off: the client API accepts API keys only. A client that still signs in through Access is asked for an API key until its member creates one on the API keys page."
    }
    said={(on) =>
      on
        ? "The client API accepts an Access sign-in again."
        : "The client API accepts API keys only now."
    }
  />
);

/** The `access_clients` setting, shown in the org that has it (the first org). */
const ClientApiSignIn = ({ caller }: { readonly caller: Caller }) => {
  const result = useAtomValue(membershipAtom);

  if (!AsyncResult.isSuccess(result) || result.value.access_clients === undefined) return null;

  return (
    <Section title="Client API sign-in">
      <AccessClients caller={caller} />
    </Section>
  );
};

const Lists = ({ caller }: { readonly caller: Caller }) => {
  const members = useAtomValue(membersAtom);
  const teams = useAtomValue(teamsAtom);
  const tokens = useAtomValue(serviceTokensAtom);
  const retryMembers = useAtomRefresh(membersAtom);
  const retryTeams = useAtomRefresh(teamsAtom);
  const retryTokens = useAtomRefresh(serviceTokensAtom);

  // The people list and the teams read each other: the rows show teams, a team lists its members.
  const both =
    AsyncResult.isSuccess(members) && AsyncResult.isSuccess(teams)
      ? { members: members.value.members, teams: teams.value.teams }
      : undefined;

  return (
    <>
      <Section title="People">
        {both === undefined ? (
          <Waiting
            result={AsyncResult.isSuccess(members) ? teams : members}
            retry={() => {
              retryMembers();
              retryTeams();
            }}
            what="the members"
          />
        ) : (
          <People members={both.members} teams={both.teams} caller={caller} />
        )}
      </Section>
      <Section title="Teams">
        {both === undefined ? (
          <Waiting
            result={AsyncResult.isSuccess(members) ? teams : members}
            retry={() => {
              retryMembers();
              retryTeams();
            }}
            what="the teams"
          />
        ) : (
          <Teams teams={both.teams} members={both.members} />
        )}
      </Section>
      <Section title="Service tokens">
        <p className={styles["lead"]}>
          Access service tokens that may call this org&rsquo;s management API from scripts. Each
          carries a role like a person does.
        </p>
        <Loaded result={tokens} retry={retryTokens} what="the service tokens">
          {(value) => <ServiceTokens tokens={value.service_tokens} caller={caller} />}
        </Loaded>
      </Section>
      <Section title="Joining">
        <AutoJoin caller={caller} />
      </Section>
      {PRIVATE_SWITCH_ORDER.map((setting) => (
        <Section key={setting} title={PRIVATE_SWITCHES[setting].title}>
          <PrivateSwitchSetting setting={setting} />
        </Section>
      ))}
      <ClientApiSignIn caller={caller} />
    </>
  );
};

export const MembersPage = () => {
  usePageTitle("Members");
  const role = useRole();

  if (role.kind !== "ready") return null;

  if (!canManageMembers(role.caller)) return <NotAllowed home="/usage" />;

  return (
    <div className={kit["page"]}>
      <header className={styles["head"]}>
        <h1 className={styles["title"]}>Members</h1>
        <p className={styles["intro"]}>
          You are{" "}
          {role.caller.platformAdmin
            ? "a platform admin, an org owner of every org"
            : roleAs(role.caller.role)}
          . Org owners can do everything here. Org admins add and remove plain members and manage
          teams; adding or promoting org admins and owners, changing roles and the joining and API
          sign-in settings are for org owners.
        </p>
      </header>
      <Lists caller={role.caller} />
    </div>
  );
};
