// The browser toolkit's Browser profiles page (#217, ADR 0039, GLOSSARY "Browser profile"): saved logins and site data a
// browser session can start from, shared (an org admin's, used under profile grants) or private to one member. What a
// create form asks and refuses, the grants that say who may use a shared profile, how each profile reads in the lists,
// and the orders that create a profile with its grants, change who may use it or delete it, run against injected writes. The
// server decides who sees and may change a profile (a member's list holds only their private ones, an org admin's also
// the shared ones, and the other members' private ones as existence only); these functions word, check and order what
// it accepts. Pure apart from `createProfile`, `saveAccess` and `deleteProfile`, which run against injected writes; tested in
// test/browser-profiles.test.ts.
import { Effect } from "effect";
import type {
  BrowserProfileGrant,
  BrowserProfileGrantBody,
  BrowserProfileView,
  CreateBrowserProfile,
  LimitedBrowserProfileView,
} from "@commissary/contract/browser-profiles";
import type { GrantSubject } from "@commissary/contract/grants";
import { asSentence } from "./failure.ts";
import { formatAgo, formatDate } from "./format.ts";
import type { ApproverDirectory } from "./approval-rules.ts";
import type { ToolsCaller } from "./toolkits.ts";

/** The Browser profiles page's path, under the Tools pages (beside `/tools/sessions`). */
export const BROWSER_PROFILES_PAGE = "/tools/profiles";

// ---------------------------------------------------------------------------------------------------------------
// What the caller may do

/** Whose a new profile is: the org's (shared, with grants) or the caller's own (private). */
export type ProfileKind = "shared" | "private";

/** Whether the caller sees the controls of shared profiles (who may use them): org admins, never a plain member. */
export const managesShared = (caller: ToolsCaller): boolean => caller.admin;

/**
 * The kinds the caller may create: org admins either, a plain member their own private ones where the org allows.
 * `directory`: the members and teams a shared profile's grants name could be read; without them a shared profile cannot
 * be created (nothing could be chosen to use it).
 */
export const kindsFor = (caller: ToolsCaller, directory = true): ReadonlyArray<ProfileKind> => [
  ...(managesShared(caller) && directory ? (["shared"] as const) : []),
  ...(caller.privateToolkits ? (["private"] as const) : []),
];

/** Whether the caller has any profile to create. */
export const canCreate = (caller: ToolsCaller): boolean => kindsFor(caller).length > 0;

// ---------------------------------------------------------------------------------------------------------------
// Names

const NAME = /^[a-z0-9_-]{1,64}$/;

/** What a name must be, as the form says it. */
export const NAME_HINT =
  "What a client names it in browser_open: 1 to 64 lowercase letters, digits, hyphens and underscores.";

/** The profiles a name may not repeat: a shared profile's name is unique among the shared ones, a private one's among
 *  the caller's own and the shared ones (the list holds no one else's). `except` is the profile being renamed. */
const taken = (
  name: string,
  kind: ProfileKind,
  profiles: ReadonlyArray<BrowserProfileView>,
  except: string | undefined,
): boolean =>
  profiles.some(
    (other) => other.id !== except && other.name === name && (kind === "private" || !other.private),
  );

/** Why a typed name would be refused, or `undefined`. */
export const nameProblem = (
  name: string,
  kind: ProfileKind,
  profiles: ReadonlyArray<BrowserProfileView>,
  except?: string,
): string | undefined => {
  const typed = name.trim();

  if (typed === "") return "Give the profile a name.";

  if (!NAME.test(typed))
    return "Use 1 to 64 lowercase letters, digits, hyphens and underscores, such as ana-bank.";

  return taken(typed, kind, profiles, except)
    ? "A profile with this name exists already. Choose another."
    : undefined;
};

// ---------------------------------------------------------------------------------------------------------------
// Who may use a shared profile

/** A grant's subject as a form value: `everyone`, `team:<id>` or `member:<id>`. */
export const subjectKey = (subject: GrantSubject): string =>
  subject.kind === "everyone" ? "everyone" : `${subject.kind}:${subject.id}`;

/** The subject a form value names; `undefined` for a value no subject has. */
export const subjectOfKey = (key: string): GrantSubject | undefined => {
  if (key === "everyone") return { kind: "everyone" };

  const at = key.indexOf(":");
  const kind = key.slice(0, at);
  const id = key.slice(at + 1);

  if (id === "") return undefined;

  return kind === "team" || kind === "member" ? { kind, id } : undefined;
};

/** The grants of one profile. */
export const grantsOf = (
  grants: ReadonlyArray<BrowserProfileGrant>,
  profile: string,
): ReadonlyArray<BrowserProfileGrant> => grants.filter((grant) => grant.profile === profile);

/** The form values of the subjects a profile's grants name. */
export const chosenOf = (held: ReadonlyArray<BrowserProfileGrant>): ReadonlyArray<string> =>
  held.map((grant) => subjectKey(grant.subject));

/** A form value toggled in or out of a chosen list. */
export const toggled = (chosen: ReadonlyArray<string>, key: string): ReadonlyArray<string> =>
  chosen.includes(key) ? chosen.filter((each) => each !== key) : [...chosen, key];

/** What a change of who may use a profile writes: the grants to add, and those to remove at their revisions. */
export interface AccessChange {
  readonly add: ReadonlyArray<GrantSubject>;
  readonly remove: ReadonlyArray<{ readonly id: string; readonly revision: number }>;
}

/** The writes that turn the grants a profile holds into the chosen subjects; a subject held already is left alone. */
export const accessChange = (
  held: ReadonlyArray<BrowserProfileGrant>,
  chosen: ReadonlyArray<string>,
): AccessChange => {
  const wanted = [...new Set(chosen)];
  const heldKeys = new Set(chosenOf(held));

  return {
    add: wanted.flatMap((key) => {
      const subject = subjectOfKey(key);

      return subject === undefined || heldKeys.has(key) ? [] : [subject];
    }),
    remove: held.flatMap((grant) =>
      wanted.includes(subjectKey(grant.subject))
        ? []
        : [{ id: grant.id, revision: grant.revision }],
    ),
  };
};

/** Whether a change writes anything. */
export const hasChange = (change: AccessChange): boolean =>
  change.add.length > 0 || change.remove.length > 0;

const SUBJECT_RANK = { everyone: 0, team: 1, member: 2 } as const;

/** A subject by name; one the directory no longer has by its id. */
const subjectName = (subject: GrantSubject, directory: ApproverDirectory): string => {
  switch (subject.kind) {
    case "everyone":
      return "Everyone";
    case "member":
      return directory.members.find((member) => member.id === subject.id)?.email ?? subject.id;
    case "team":
      return directory.teams.find((team) => team.id === subject.id)?.name ?? subject.id;
  }
};

/** Who may use a profile, in a phrase: "Everyone", "Design, ana@acme.dev"; `undefined` while no grant names anyone. */
export const accessText = (
  held: ReadonlyArray<BrowserProfileGrant>,
  directory: ApproverDirectory,
): string | undefined => {
  if (held.length === 0) return undefined;

  return held
    .map((grant) => grant.subject)
    .toSorted(
      (a, b) =>
        SUBJECT_RANK[a.kind] - SUBJECT_RANK[b.kind] ||
        subjectName(a, directory).localeCompare(subjectName(b, directory)),
    )
    .map((subject) => subjectName(subject, directory))
    .join(", ");
};

/** What a shared profile says while no grant gives it to anyone. */
export const NOBODY_TEXT = "No one yet: no member can open a session from it.";

// ---------------------------------------------------------------------------------------------------------------
// The create form

/** The create form as filled in. `who` holds the subjects' form values (`subjectKey`); nothing is preselected. */
export interface ProfileDraft {
  readonly name: string;
  readonly kind: ProfileKind;
  readonly who: ReadonlyArray<string>;
}

/** The form for a caller: a shared profile for an org admin, otherwise their private one; no one chosen. */
export const emptyDraft = (caller: ToolsCaller, directory = true): ProfileDraft => ({
  name: "",
  kind: kindsFor(caller, directory)[0] ?? "private",
  who: [],
});

/** The message of each field that is wrong. */
export interface ProfileErrors {
  name?: string;
  who?: string;
}

/** What a shared profile with no one chosen to use it says: nothing may leave one that no member can use. */
export const WHO_REQUIRED =
  "Choose who may use it: everyone, teams or members. No one may use a shared profile until you do.";

/** Why a choice of who may use a shared profile is refused, or `undefined`: it names someone. */
export const accessProblem = (chosen: ReadonlyArray<string>): string | undefined =>
  chosen.length === 0 ? WHO_REQUIRED : undefined;

/** What is wrong with a draft, mirroring the server's checks; a shared profile needs at least one subject chosen. */
export const validateDraft = (
  draft: ProfileDraft,
  profiles: ReadonlyArray<BrowserProfileView>,
): ProfileErrors => {
  const errors: ProfileErrors = {};
  const name = nameProblem(draft.name, draft.kind, profiles);

  if (name !== undefined) errors.name = name;

  if (draft.kind === "shared") {
    const who = accessProblem(draft.who);

    if (who !== undefined) errors.who = who;
  }

  return errors;
};

export const hasErrors = (errors: ProfileErrors): boolean => Object.keys(errors).length > 0;

/** The body that creates a draft's profile: a private one says so (an org admin's is shared unless it does). */
export const createBody = (draft: ProfileDraft): CreateBrowserProfile => ({
  name: draft.name.trim(),
  ...(draft.kind === "private" ? { private: true } : {}),
});

/** The grants a draft's profile gets once it exists: one per chosen subject; none for a private profile. */
export const grantBodies = (
  profile: string,
  draft: ProfileDraft,
): ReadonlyArray<BrowserProfileGrantBody> =>
  draft.kind === "private"
    ? []
    : [...new Set(draft.who)].flatMap((key) => {
        const subject = subjectOfKey(key);

        return subject === undefined ? [] : [{ subject, profile }];
      });

/** The writes the page sends, one each; `E` and `R` are the transport's. */
export interface ProfileIo<E, R> {
  readonly create: (body: CreateBrowserProfile) => Effect.Effect<BrowserProfileView, E, R>;
  readonly remove: (id: string, revision: number) => Effect.Effect<unknown, E, R>;
  readonly grant: (body: BrowserProfileGrantBody) => Effect.Effect<unknown, E, R>;
  readonly ungrant: (id: string, revision: number) => Effect.Effect<unknown, E, R>;
}

/**
 * Creates the draft's profile and, for a shared one, the grant of each chosen subject, one after another. A shared
 * profile is never left without its grants: when one is refused, the profile just created (empty, nothing uses it) is
 * deleted again, as well as it can be, and the refusal is what fails. A private profile needs no grant.
 */
export const createProfile = <E, R>(
  draft: ProfileDraft,
  io: ProfileIo<E, R>,
): Effect.Effect<BrowserProfileView, E, R> =>
  Effect.gen(function* () {
    const profile = yield* io.create(createBody(draft));

    yield* Effect.forEach(grantBodies(profile.id, draft), io.grant, { discard: true }).pipe(
      Effect.tapError(() => io.remove(profile.id, profile.revision).pipe(Effect.ignore)),
    );

    return profile;
  });

/** Changes who may use a shared profile: the new grants first, then the removals, so it is never left unusable midway. */
export const saveAccess = <E, R>(
  profile: string,
  change: AccessChange,
  io: Pick<ProfileIo<E, R>, "grant" | "ungrant">,
): Effect.Effect<void, E, R> =>
  Effect.gen(function* () {
    yield* Effect.forEach(change.add, (subject) => io.grant({ subject, profile }), {
      discard: true,
    });

    yield* Effect.forEach(change.remove, ({ id, revision }) => io.ungrant(id, revision), {
      discard: true,
    });
  });

/** What a delete names: the profile and the revision its row was read at (the `If-Match`). */
export interface DeleteTarget {
  readonly id: string;
  readonly revision: number;
}

/** The target of a profile's own row. */
export const targetOf = (profile: Pick<BrowserProfileView, "id" | "revision">): DeleteTarget => ({
  id: profile.id,
  revision: profile.revision,
});

/**
 * The target of a row named by `key` (another member's private profile, which an org admin removes): `undefined` when
 * the list no longer has it, so nothing is sent at a revision that was never read.
 */
export const targetOfKey = (
  rows: ReadonlyArray<DeleteTarget>,
  key: string,
): DeleteTarget | undefined => {
  const row = rows.find((each) => each.id === key);

  return row === undefined ? undefined : targetOf(row);
};

/** Deletes a profile (shared or private, one's own or another member's) at the revision its row was read at. */
export const deleteProfile = <E, R>(
  target: DeleteTarget,
  io: Pick<ProfileIo<E, R>, "remove">,
): Effect.Effect<unknown, E, R> => io.remove(target.id, target.revision);

// ---------------------------------------------------------------------------------------------------------------
// The lists

/** A profile as its list row reads it. */
export interface ProfileRow {
  readonly profile: BrowserProfileView;
  /** Whether a login is saved in it: "Saved 3 d ago", or that it is empty. */
  readonly saved: string;
}

/** When a session last saved into a profile, or that it holds nothing yet. */
export const savedText = (profile: Pick<BrowserProfileView, "saved_at">, now: number): string => {
  if (profile.saved_at === null) return "Empty: no session has saved into it yet";

  const ago = formatAgo(Math.max(0, now - Date.parse(profile.saved_at)));

  return ago === "just now" ? "Saved just now" : `Saved ${ago}`;
};

const byName = (a: BrowserProfileView, b: BrowserProfileView): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

const rowOf = (profile: BrowserProfileView, now: number): ProfileRow => ({
  profile,
  saved: savedText(profile, now),
});

/** The shared profiles of a list (an org admin's), by name. */
export const sharedRows = (
  profiles: ReadonlyArray<BrowserProfileView>,
  now: number,
): ReadonlyArray<ProfileRow> =>
  profiles
    .filter((profile) => !profile.private)
    .toSorted(byName)
    .map((profile) => rowOf(profile, now));

/** The caller's own private profiles of a list, by name. */
export const privateRows = (
  profiles: ReadonlyArray<BrowserProfileView>,
  now: number,
): ReadonlyArray<ProfileRow> =>
  profiles
    .filter((profile) => profile.private)
    .toSorted(byName)
    .map((profile) => rowOf(profile, now));

/** An org admin's row of another member's private profile: that it exists, whose it is, and its revision to remove. */
export interface OtherProfileRow {
  readonly id: string;
  readonly owner: string;
  readonly added: string;
  readonly revision: number;
}

export const otherRows = (
  others: ReadonlyArray<LimitedBrowserProfileView>,
): ReadonlyArray<OtherProfileRow> =>
  others.map((other) => ({
    id: other.id,
    owner: other.owner.email ?? other.owner.member_id,
    added: `Added ${formatDate(Date.parse(other.created_at))}`,
    revision: other.revision,
  }));

/** The sentence under the lists while the caller has no profile. */
export const emptyText = (caller: ToolsCaller): string => {
  if (caller.admin)
    return "No shared profile yet. Create one below, choose who may use it, then log into it from a browser session.";

  return caller.privateToolkits
    ? "You have no private profile. Create one below, then log into it from a browser session."
    : "This org does not let members use private profiles. An org admin may share a profile with you: you open a session from it with browser_open.";
};

/** A member's note where the org shuts private profiles (the page has nothing else for them). */
export const MEMBER_NO_PRIVATE_TEXT =
  "This org does not let members use private toolkits, and with them private browser profiles: yours are kept, but no session opens from one or saves into one. An org admin can turn them back on.";

// ---------------------------------------------------------------------------------------------------------------
// Words

/** What a refused write says, by the server's error code (`detail`: its own explanation of a `422`). */
export const profileProblem = (
  error: string | undefined,
  message: string,
  detail?: string,
): string => {
  switch (error) {
    case "name_taken":
      return "A profile with this name exists already. Choose another.";
    case "conflict":
      return "The profile changed elsewhere while this page was open, or this subject already may use it. Reload to see it as it is, then make the edit again.";
    case "invalid":
      return asSentence(detail ?? message);
    case "private_toolkits_unavailable":
      return "This org does not let members use private profiles now. An org admin can turn private toolkits back on.";
    case "not_found":
      return "The profile is gone already, or it is not yours to change.";
    case "forbidden":
      return "Only an org admin changes a shared profile, and only its member a private one.";
    default:
      return message;
  }
};

/** The confirmation before deleting a profile of the caller's: what goes with it and what its users meet next. */
export const deleteText = (profile: Pick<BrowserProfileView, "name" | "private">): string =>
  profile.private
    ? `The profile ${profile.name} and the logins saved in it are deleted. A session open from it can no longer save into it.`
    : `The shared profile ${profile.name}, the logins saved in it and every grant of it are deleted: no one may open a session from it. A session open from it can no longer save into it.`;

/** How to log into a profile: the steps the page lists, each a title and what it means. */
export const LOGIN_STEPS: ReadonlyArray<{ readonly title: string; readonly body: string }> = [
  {
    title: "Open it in a session",
    body: "Your client calls browser_open with the profile's name. The session starts from what the profile holds: empty at first.",
  },
  {
    title: "Ask for a handoff",
    body: "The client calls browser_ask_human when a page needs you. You get a link to the session on the Browser sessions page: sign in there, in its Live View, then press Done. The client never sees what you type.",
  },
  {
    title: "Close it with save",
    body: "The client calls browser_close with save. The session's logins and site data replace what the profile held, and the next session opened from it starts logged in.",
  },
];

/** Who may save into a profile, said once under the steps. */
export const SAVE_NOTE =
  "Only the member of a private profile may save into it, and only an org admin into a shared one; members who may use a shared profile start sessions from it but never change it.";
