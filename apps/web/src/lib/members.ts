// The Members page's model: what a refused write tells the caller, the checks that mirror the server's, and how
// members, teams and service tokens are read together. Pure: no DOM, tested in test/members.test.ts.
import type {
  MemberView,
  ServiceTokenView,
  TeamView,
  UpdateMembershipSettings,
} from "@commissary/contract/members";
import { asSentence } from "./failure.ts";
import { roleLabel } from "./role.ts";

/**
 * What a refused member, team or service token write says, by the server's error code. Codes without copy fall back
 * to the server's own explanation, then to the code.
 */
export const memberProblem = (
  error: string | undefined,
  message: string,
  detail?: string,
): string => {
  switch (error) {
    case "owner_required":
      return "Only an org owner can do this: adding or changing org admins and owners, changing roles, or removing an org admin or owner.";
    case "admin_required":
      return "Only an org admin can do this.";
    case "service_token_owner_required":
      return "A role above member for a service token needs a service token that is an org owner, or a platform admin. Register it as a member token here, or use the management API from an owner service token.";
    case "last_owner":
      return "An org needs at least one owner. Make someone else an owner first.";
    case "member_exists":
      return "That person is already a member of this org.";
    case "team_exists":
      return "A team with that name exists already; team names are unique regardless of case.";
    case "service_token_exists":
      return "That service token is already registered to this org.";
    case "service_token_taken":
      return "That service token is registered to another org. A token belongs to one org.";
    case "invalid_email":
      return "That is not a valid email address.";
    case "invalid_role":
      return "That role does not exist.";
    case "invalid_name":
      return `A name is 1 to ${TEAM_NAME_MAX} characters.`;
    case "invalid_client_id":
      return "That is not a valid service token client id. Copy the Client ID of the token from Cloudflare Access (it ends in .access).";
    case "member_not_found":
      return "That member no longer exists. Reload to see the current list.";
    case "team_not_found":
      return "That team no longer exists. Reload to see the current list.";
    case "service_token_not_found":
      return "That service token is no longer registered. Reload to see the current list.";
    default:
      return detail === undefined ? message : asSentence(detail);
  }
};

/** The server's rule (`validEmail`, packages/state/src/members/store.ts): the client never refuses an address the server accepts. */
const EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>"]+$/;

export const EMAIL_MAX = 254;

/** An email as the server stores it: trimmed and lower-case. */
export const normalizeEmail = (text: string): string => text.trim().toLowerCase();

/** What is wrong with a typed email, or `undefined` when it will do. */
export const emailProblem = (text: string): string | undefined => {
  const email = normalizeEmail(text);

  if (email === "") return "Enter an email address.";

  return email.length <= EMAIL_MAX && EMAIL.test(email)
    ? undefined
    : `“${text.trim()}” is not an email address.`;
};

/** A team name is 1 to 100 characters (code points, as the server counts), without control characters. */
export const TEAM_NAME_MAX = 100;

/** Whether a character is a control character (the server refuses those in names). */
const isControl = (character: string): boolean => {
  const code = character.codePointAt(0) ?? 0;

  return code < 0x20 || code === 0x7f;
};

/** What is wrong with a typed team name, or `undefined`; `others` are the other teams' names (unique, any case). */
export const teamNameProblem = (
  text: string,
  others: ReadonlyArray<string>,
): string | undefined => {
  const name = text.trim();

  if (name === "") return "Enter a name.";

  // Code points, as the server counts them.
  const characters = Array.from(name);

  if (characters.length > TEAM_NAME_MAX) return `A name is up to ${TEAM_NAME_MAX} characters.`;

  if (characters.some(isControl)) return "A name has no control characters.";

  return others.some((other) => other.trim().toLowerCase() === name.toLowerCase())
    ? "A team with that name exists already."
    : undefined;
};

/** What is wrong with a typed service token client id, or `undefined`. */
export const clientIdProblem = (text: string): string | undefined => {
  const id = text.trim();

  if (id === "") return "Enter the token's Client ID.";

  return /\s/.test(id) ? "A client id has no spaces." : undefined;
};

/** Org owners first, then org admins, then members; each by email. */
export const sortMembers = (members: ReadonlyArray<MemberView>): ReadonlyArray<MemberView> => {
  const order = { owner: 0, admin: 1, member: 2 } as const;

  return [...members].sort(
    (a, b) => order[a.role] - order[b.role] || a.email.localeCompare(b.email),
  );
};

export const sortTeams = (teams: ReadonlyArray<TeamView>): ReadonlyArray<TeamView> =>
  [...teams].sort((a, b) => a.name.localeCompare(b.name));

export const sortTokens = (
  tokens: ReadonlyArray<ServiceTokenView>,
): ReadonlyArray<ServiceTokenView> => {
  const order = { owner: 0, admin: 1, member: 2 } as const;

  return [...tokens].sort(
    (a, b) =>
      order[a.role] - order[b.role] || (a.name || a.client_id).localeCompare(b.name || b.client_id),
  );
};

/** The teams a member is on, by the ids the member lists (a team the list lacks is skipped). */
export const teamsOfMember = (
  member: MemberView,
  teams: ReadonlyArray<TeamView>,
): ReadonlyArray<TeamView> => teams.filter((team) => member.teams.includes(team.id));

/** The teams a member could still be added to. */
export const teamsToJoin = (
  member: MemberView,
  teams: ReadonlyArray<TeamView>,
): ReadonlyArray<TeamView> => teams.filter((team) => !member.teams.includes(team.id));

/** The members of a team, by the ids the team lists (a member the list lacks is skipped). */
export const membersOfTeam = (
  team: TeamView,
  members: ReadonlyArray<MemberView>,
): ReadonlyArray<MemberView> => members.filter((member) => team.members.includes(member.id));

/** A service token as the lists name it: its name, or its client id when it has none. */
export const tokenName = (token: ServiceTokenView): string =>
  token.name === "" ? token.client_id : token.name;

/** The count of each role among members, for the summary line ("1 org owner, 2 org admins, 5 members"). */
export const roleCounts = (members: ReadonlyArray<MemberView>): string => {
  const parts = (["owner", "admin", "member"] as const).flatMap((role) => {
    const count = members.filter((member) => member.role === role).length;

    return count === 0
      ? []
      : [`${count} ${roleLabel(role).toLowerCase()}${count === 1 ? "" : "s"}`];
  });

  return parts.length === 0 ? "No members" : parts.join(", ");
};

// ---------------------------------------------------------------------------------------------------------------
// What members may keep privately

/** The two settings that say what plain members may keep to themselves: org admins decide both (ADR 0023, ADR 0038). */
export type PrivateSetting = "private_credentials" | "private_toolkits";

/** One such switch as its section words it. */
export interface PrivateSwitch {
  readonly setting: PrivateSetting;
  /** The section's heading. */
  readonly title: string;
  readonly label: string;
  /** What the setting means in its current state. */
  readonly describe: (on: boolean) => string;
  /** What changed, said after a save. */
  readonly said: (on: boolean) => string;
  /** What the page is called while its setting loads or fails. */
  readonly what: string;
}

export const PRIVATE_SWITCHES: Readonly<Record<PrivateSetting, PrivateSwitch>> = {
  private_credentials: {
    setting: "private_credentials",
    title: "Private credentials",
    label: "Let members connect private accounts and provider keys",
    what: "the private credentials setting",
    describe: (on) =>
      on
        ? "On: a member's private account or provider key is used only for their own requests. Org admins see that it exists, its provider, owner and label, and can disable or remove it, but not how it is used."
        : "Off: members cannot connect private credentials, and the ones they connected stay in place but are not used. Turning it on again brings them back.",
    said: (on) =>
      on
        ? "Members can connect private accounts and provider keys now."
        : "Private accounts and provider keys are switched off, not deleted.",
  },
  private_toolkits: {
    setting: "private_toolkits",
    title: "Private toolkits",
    label: "Let members add private toolkits",
    what: "the private toolkits setting",
    describe: (on) =>
      on
        ? "On: a member may add toolkits of their own, from their own sources and with their own credentials, which only they can use. They set those toolkits' approval rules, but cannot price them. Org admins see that each exists and who added it, and can remove it, but not its tools or how it is used."
        : "Off: members cannot add private toolkits, and the ones they added stay in place but are not served. Turning it on again brings them back. This is separate from private credentials: members may still connect their own credentials to the org's toolkits.",
    said: (on) =>
      on
        ? "Members can add private toolkits now."
        : "Private toolkits are switched off, not deleted.",
  },
};

/** The sections in the order the Members page lists them. */
export const PRIVATE_SWITCH_ORDER: ReadonlyArray<PrivateSetting> = [
  "private_credentials",
  "private_toolkits",
];

/** The write that sets one switch: a partial patch, so it never changes the other settings. */
export const privateSettingPatch = (
  setting: PrivateSetting,
  on: boolean,
): UpdateMembershipSettings => ({ [setting]: on });
