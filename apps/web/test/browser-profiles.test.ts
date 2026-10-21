// The Browser profiles page (src/lib/browser-profiles.ts, #217, ADR 0039): who sees its controls, what a create form
// refuses (a shared profile needs someone chosen to use it; nothing is preselected), the grants a shared profile gets
// when it is created, the changes of who may use it, and deleting both kinds.
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type {
  BrowserProfileGrant,
  BrowserProfileGrantBody,
  BrowserProfileView,
  CreateBrowserProfile,
} from "@commissary/contract/browser-profiles";
import {
  accessChange,
  accessProblem,
  accessText,
  BROWSER_PROFILES_PAGE,
  canCreate,
  chosenOf,
  createBody,
  createProfile,
  deleteProfile,
  deleteText,
  emptyDraft,
  grantBodies,
  grantsOf,
  hasChange,
  hasErrors,
  kindsFor,
  managesShared,
  nameProblem,
  otherRows,
  type ProfileDraft,
  type ProfileIo,
  privateRows,
  profileProblem,
  saveAccess,
  savedText,
  sharedRows,
  subjectKey,
  subjectOfKey,
  targetOf,
  targetOfKey,
  toggled,
  WHO_REQUIRED,
  validateDraft,
} from "../src/lib/browser-profiles.ts";
import type { MemberView, TeamView } from "@commissary/contract/members";
import { pageAllowed } from "../src/lib/role.ts";
import type { ToolsCaller } from "../src/lib/toolkits.ts";

const NOW = Date.parse("2026-10-11T10:30:00.000Z");

const ADMIN: ToolsCaller = { admin: true, privateCredentials: true, privateToolkits: true };

const MEMBER: ToolsCaller = { admin: false, privateCredentials: true, privateToolkits: true };

const MEMBER_NO_PRIVATE: ToolsCaller = { ...MEMBER, privateToolkits: false };

const profile = (id: string, extra: Partial<BrowserProfileView> = {}): BrowserProfileView => ({
  id,
  name: id,
  private: false,
  saved_at: null,
  revision: 1,
  created_at: "2026-10-01T09:00:00.000Z",
  updated_at: "2026-10-01T09:00:00.000Z",
  ...extra,
});

const grant = (
  id: string,
  profileId: string,
  subject: BrowserProfileGrant["subject"],
  revision = 1,
): BrowserProfileGrant => ({
  id,
  profile: profileId,
  subject,
  revision,
  updated_at: NOW,
  updated_by: "user:admin@example.com",
});

const member = (id: string, email: string): MemberView => ({
  id,
  email,
  role: "member",
  added_at: "2026-10-01T09:00:00.000Z",
  teams: [],
});

const team = (id: string, name: string): TeamView => ({
  id,
  name,
  created_at: "2026-10-01T09:00:00.000Z",
  members: [],
});

const directory = {
  members: [member("m-ana", "ana@example.com"), member("m-bo", "bo@example.com")],
  teams: [team("t-design", "Design")],
};

describe("the Browser profiles page", () => {
  it("is opened by every member", () => {
    expect(pageAllowed("member", BROWSER_PROFILES_PAGE)).toBe(true);
  });

  it("gives a plain member no control of the shared profiles, and org admins both kinds", () => {
    expect(managesShared(ADMIN)).toBe(true);
    expect(managesShared(MEMBER)).toBe(false);
    expect(kindsFor(ADMIN)).toEqual(["shared", "private"]);
    expect(kindsFor(MEMBER)).toEqual(["private"]);
    expect(kindsFor(MEMBER_NO_PRIVATE)).toEqual([]);
    expect(kindsFor({ ...ADMIN, privateToolkits: false })).toEqual(["shared"]);
    expect(canCreate(MEMBER)).toBe(true);
    expect(canCreate(MEMBER_NO_PRIVATE)).toBe(false);
  });

  it("offers no shared profile while the members and teams could not be read", () => {
    expect(kindsFor(ADMIN, false)).toEqual(["private"]);
    expect(kindsFor({ ...ADMIN, privateToolkits: false }, false)).toEqual([]);
    expect(emptyDraft(ADMIN, false).kind).toBe("private");
    expect(kindsFor(MEMBER, false)).toEqual(["private"]);
  });
});

describe("a profile's name", () => {
  const profiles = [profile("marketing"), profile("ana-bank", { private: true })];

  it("is 1 to 64 lowercase letters, digits, hyphens and underscores", () => {
    expect(nameProblem("", "shared", [])).toBeDefined();
    expect(nameProblem("  ", "shared", [])).toBeDefined();
    expect(nameProblem("Ana Bank", "private", [])).toBeDefined();
    expect(nameProblem("a".repeat(65), "private", [])).toBeDefined();
    expect(nameProblem("ana_bank-2", "private", [])).toBeUndefined();
    expect(nameProblem(" ana ", "private", [])).toBeUndefined();
  });

  it("is unique among the shared ones for a shared profile, and among the caller's own and the shared ones for a private one", () => {
    expect(nameProblem("marketing", "shared", profiles)).toBeDefined();
    expect(nameProblem("ana-bank", "shared", profiles)).toBeUndefined();
    expect(nameProblem("ana-bank", "private", profiles)).toBeDefined();
    expect(nameProblem("marketing", "private", profiles)).toBeDefined();
    // Renaming a profile to its own name is no clash.
    expect(nameProblem("marketing", "shared", profiles, "marketing")).toBeUndefined();
  });
});

describe("creating a shared profile", () => {
  it("starts with no one chosen, shared for an org admin and private for a member", () => {
    expect(emptyDraft(ADMIN)).toEqual({ name: "", kind: "shared", who: [] });
    expect(emptyDraft(MEMBER)).toEqual({ name: "", kind: "private", who: [] });
  });

  it("cannot be done without choosing who may use it", () => {
    const draft: ProfileDraft = { name: "marketing", kind: "shared", who: [] };
    const errors = validateDraft(draft, []);

    expect(hasErrors(errors)).toBe(true);
    expect(errors.who).toMatch(/Choose who may use it/);
    expect(errors.name).toBeUndefined();

    expect(hasErrors(validateDraft({ ...draft, who: ["everyone"] }, []))).toBe(false);
    expect(hasErrors(validateDraft({ ...draft, who: ["team:t-design"] }, []))).toBe(false);
  });

  it("asks nothing of who for a private profile, and still checks its name", () => {
    expect(hasErrors(validateDraft({ name: "my-bank", kind: "private", who: [] }, []))).toBe(false);
    expect(validateDraft({ name: "", kind: "private", who: [] }, []).name).toBeDefined();
  });

  it("names the subjects the checklist ticks, one grant each", () => {
    const draft: ProfileDraft = {
      name: "marketing",
      kind: "shared",
      who: ["everyone", "team:t-design", "member:m-ana", "member:m-ana", "bogus"],
    };

    expect(createBody(draft)).toEqual({ name: "marketing" });

    expect(grantBodies("bp_1", draft)).toEqual([
      { subject: { kind: "everyone" }, profile: "bp_1" },
      { subject: { kind: "team", id: "t-design" }, profile: "bp_1" },
      { subject: { kind: "member", id: "m-ana" }, profile: "bp_1" },
    ]);
  });

  it.effect("creates the profile, then its grants, one after another", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];

      const io: ProfileIo<never, never> = {
        create: (body: CreateBrowserProfile) =>
          Effect.sync(() => {
            calls.push(`create ${body.name}${body.private === true ? " private" : ""}`);

            return profile("bp_1", { name: body.name });
          }),
        remove: (id) => Effect.sync(() => void calls.push(`remove ${id}`)),
        grant: (body: BrowserProfileGrantBody) =>
          Effect.sync(() => void calls.push(`grant ${subjectKey(body.subject)} ${body.profile}`)),
        ungrant: () => Effect.void,
      };

      const created = yield* createProfile(
        { name: "marketing", kind: "shared", who: ["everyone", "team:t-design"] },
        io,
      );

      expect(created.id).toBe("bp_1");

      expect(calls).toEqual([
        "create marketing",
        "grant everyone bp_1",
        "grant team:t-design bp_1",
      ]);
    }),
  );

  it.effect(
    "deletes the profile again when a grant is refused, so none is left that no one may use",
    () =>
      Effect.gen(function* () {
        const calls: Array<string> = [];

        const io: ProfileIo<string, never> = {
          create: (body) => Effect.sync(() => profile("bp_1", { name: body.name })),
          remove: (id, revision) =>
            Effect.sync(() => void calls.push(`remove ${id} at ${revision}`)),
          grant: (body) =>
            body.subject.kind === "team" ? Effect.fail("unknown team") : Effect.void,
          ungrant: () => Effect.void,
        };

        const failure = yield* Effect.flip(
          createProfile({ name: "marketing", kind: "shared", who: ["everyone", "team:gone"] }, io),
        );

        expect(failure).toBe("unknown team");
        expect(calls).toEqual(["remove bp_1 at 1"]);
      }),
  );
});

describe("a member's private profile", () => {
  it.effect("is created private, with no grant", () =>
    Effect.gen(function* () {
      const draft: ProfileDraft = { name: "my-bank", kind: "private", who: [] };
      const sent: Array<CreateBrowserProfile> = [];
      let grants = 0;

      const io: ProfileIo<never, never> = {
        create: (body) =>
          Effect.sync(() => {
            sent.push(body);

            return profile("bp_2", { name: body.name, private: true });
          }),
        remove: () => Effect.void,
        grant: () => Effect.sync(() => void (grants += 1)),
        ungrant: () => Effect.void,
      };

      const created = yield* createProfile(draft, io);

      expect(sent).toEqual([{ name: "my-bank", private: true }]);
      expect(grants).toBe(0);
      expect(created.private).toBe(true);
    }),
  );
});

describe("who may use a shared profile", () => {
  const held = [
    grant("g1", "marketing", { kind: "everyone" }, 3),
    grant("g2", "marketing", { kind: "team", id: "t-design" }, 1),
    grant("g3", "ops", { kind: "member", id: "m-bo" }),
  ];

  it("reads as the subjects' names, everyone first, or says no one yet", () => {
    expect(accessText(grantsOf(held, "marketing"), directory)).toBe("Everyone, Design");

    expect(
      accessText(
        [
          grant("g4", "x", { kind: "member", id: "m-bo" }),
          grant("g5", "x", { kind: "member", id: "m-ana" }),
        ],
        directory,
      ),
    ).toBe("ana@example.com, bo@example.com");

    expect(accessText([], directory)).toBeUndefined();
  });

  it("maps subjects to form values and back", () => {
    expect(subjectKey({ kind: "everyone" })).toBe("everyone");
    expect(subjectKey({ kind: "member", id: "m-ana" })).toBe("member:m-ana");
    expect(subjectOfKey("team:t-design")).toEqual({ kind: "team", id: "t-design" });
    expect(subjectOfKey("everyone")).toEqual({ kind: "everyone" });
    expect(subjectOfKey("team:")).toBeUndefined();
    expect(subjectOfKey("robot:r1")).toBeUndefined();
    expect(chosenOf(grantsOf(held, "marketing"))).toEqual(["everyone", "team:t-design"]);
    expect(toggled(["everyone"], "team:t-design")).toEqual(["everyone", "team:t-design"]);
    expect(toggled(["everyone", "team:t-design"], "everyone")).toEqual(["team:t-design"]);
  });

  it("writes only what changed: new grants to add, dropped ones to remove at their revision", () => {
    const mine = grantsOf(held, "marketing");

    expect(hasChange(accessChange(mine, chosenOf(mine)))).toBe(false);

    expect(accessChange(mine, ["team:t-design", "member:m-ana"])).toEqual({
      add: [{ kind: "member", id: "m-ana" }],
      remove: [{ id: "g1", revision: 3 }],
    });

    expect(accessChange(mine, [])).toEqual({
      add: [],
      remove: [
        { id: "g1", revision: 3 },
        { id: "g2", revision: 1 },
      ],
    });
  });

  it.effect("adds grants before it removes any, so the profile is never unusable midway", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];

      const io = {
        grant: (body: BrowserProfileGrantBody) =>
          Effect.sync(() => void calls.push(`grant ${subjectKey(body.subject)}`)),
        ungrant: (id: string, revision: number) =>
          Effect.sync(() => void calls.push(`ungrant ${id} at ${revision}`)),
      };

      yield* saveAccess(
        "marketing",
        accessChange(grantsOf(held, "marketing"), ["team:t-design", "member:m-ana"]),
        io,
      );

      expect(calls).toEqual(["grant member:m-ana", "ungrant g1 at 3"]);
    }),
  );
});

describe("the lists", () => {
  const list = [
    profile("zeta"),
    profile("beta", { saved_at: "2026-10-11T10:18:00.000Z" }),
    profile("mine", { private: true }),
    profile("alpha", { private: true }),
  ];

  it("keeps the shared profiles apart from the caller's private ones, each by name", () => {
    expect(sharedRows(list, NOW).map((row) => row.profile.name)).toEqual(["beta", "zeta"]);
    expect(privateRows(list, NOW).map((row) => row.profile.name)).toEqual(["alpha", "mine"]);
  });

  it("says whether a login is saved in a profile", () => {
    expect(savedText(profile("a"), NOW)).toBe("Empty: no session has saved into it yet");
    expect(savedText(profile("a", { saved_at: "2026-10-11T10:18:00.000Z" }), NOW)).toBe(
      "Saved 12 min ago",
    );
    expect(savedText(profile("a", { saved_at: "2026-10-11T10:30:00.000Z" }), NOW)).toBe(
      "Saved just now",
    );
  });

  it("shows an org admin only that another member's private profile exists, and whose it is", () => {
    expect(
      otherRows([
        {
          id: "bp_9",
          private: true,
          limited: true,
          owner: { member_id: "m-cy", email: "cy@example.com" },
          created_at: "2026-10-01T09:00:00.000Z",
          revision: 4,
        },
        {
          id: "bp_10",
          private: true,
          limited: true,
          owner: { member_id: "m-di" },
          created_at: "2026-10-02T09:00:00.000Z",
          revision: 1,
        },
      ]),
    ).toEqual([
      { id: "bp_9", owner: "cy@example.com", added: "Added Oct 1, 2026", revision: 4 },
      { id: "bp_10", owner: "m-di", added: "Added Oct 2, 2026", revision: 1 },
    ]);
  });
});

describe("changing who may use a shared profile", () => {
  it("is refused when no one is left, with the create form's message", () => {
    expect(accessProblem([])).toBe(WHO_REQUIRED);
    expect(accessProblem(["everyone"])).toBeUndefined();
    expect(validateDraft({ name: "marketing", kind: "shared", who: [] }, []).who).toBe(
      WHO_REQUIRED,
    );
  });
});

describe("deleting a profile", () => {
  const sent: Array<string> = [];

  const io: Pick<ProfileIo<never, never>, "remove"> = {
    remove: (id, revision) => Effect.sync(() => void sent.push(`${id} if-match ${revision}`)),
  };

  it.effect(
    "sends a shared profile's, the caller's private one's and another member's at the revision of their rows",
    () =>
      Effect.gen(function* () {
        sent.length = 0;

        yield* deleteProfile(targetOf(profile("marketing", { revision: 4 })), io);
        yield* deleteProfile(targetOf(profile("my-bank", { private: true, revision: 2 })), io);

        const others = otherRows([
          {
            id: "bp_9",
            private: true,
            limited: true,
            owner: { member_id: "m-cy", email: "cy@example.com" },
            created_at: "2026-10-01T09:00:00.000Z",
            revision: 7,
          },
        ]);

        const target = targetOfKey(others, "bp_9");

        expect(target).toEqual({ id: "bp_9", revision: 7 });

        if (target !== undefined) yield* deleteProfile(target, io);

        expect(sent).toEqual(["marketing if-match 4", "my-bank if-match 2", "bp_9 if-match 7"]);
      }),
  );

  it("sends nothing for a row the list no longer has: it never guesses a revision", () => {
    expect(targetOfKey([{ id: "bp_9", revision: 7 }], "bp_gone")).toBeUndefined();
  });

  it("says what goes with each kind: a shared profile's grants, a private one's logins", () => {
    expect(deleteText({ name: "marketing", private: false })).toMatch(/every grant of it/);
    expect(deleteText({ name: "my-bank", private: true })).not.toMatch(/grant/);
    expect(deleteText({ name: "my-bank", private: true })).toMatch(/my-bank/);
  });
});

describe("what a refused write says", () => {
  it("tells a taken name, a stale revision, a name the server refuses and the org's private setting apart", () => {
    expect(profileProblem("name_taken", "a browser profile is already named x")).toMatch(
      /exists already/,
    );
    expect(profileProblem("conflict", "stale")).toMatch(/changed elsewhere/);

    expect(profileProblem("invalid", "x", "a browser profile's name is 1 to 64 letters")).toBe(
      "A browser profile's name is 1 to 64 letters.",
    );

    expect(profileProblem("private_toolkits_unavailable", "x")).toMatch(/private toolkits/);
    expect(profileProblem("other", "The server said no.")).toBe("The server said no.");
  });
});
