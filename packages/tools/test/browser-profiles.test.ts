// Browser profiles (#215, ADR 0039) in the Tools part over RPC, on a fake provider's browsers (test/support/
// fake-sessions.ts, whose `/login` sets a `session` cookie and whose `/account` says who it signs in): a session opened
// from a profile starts with what the last save put in it; a profile opens only for who may use it (its member, or a
// profile grant's subjects for a shared one), and anything else answers as an unknown profile; saving is its member's
// (private) or an org admin's (shared), and a refused save still closes the session; a save over a browser reached
// again misses the local storage of the sites visited before, and says so; the stored state is sealed for its row and
// org; org admins see only that another member's private profile exists; private profiles follow the private-toolkits
// setting.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Schema } from "effect";
import type { GrantSubject } from "@commissary/contract/grants";
import { PROFILE_TABLES } from "../src/browser/profiles.ts";
import { fakeBrowsers } from "./support/fake-sessions.ts";

const POLICY = { ownHosts: [], localDevelopment: false };

const OWNER = { role: "owner" as const, sensitive: false };

const EVERYONE: GrantSubject = { kind: "everyone" };

interface Person {
  readonly viewer: { readonly member: string; readonly admin: boolean };
  /** Their principal on the API host: an API key of theirs. */
  readonly principal: string;
}

/**
 * A new org whose deployment has the browser, with an org admin and two plain members, private toolkits on and the
 * browser toolkit's tools granted to everyone.
 */
const org = async () => {
  const stub = env.BROWSER_CONTROL_PLANE.getByName(crypto.randomUUID());

  await stub.setMembershipSettings({ privateToolkits: true });

  const person = async (name: string, role: string): Promise<Person> => {
    const added = await stub.addMember({ email: `${name}@example.com`, role }, OWNER, "test");

    if (!added.ok) throw new Error(added.message);

    return {
      viewer: { member: added.value.id, admin: role !== "member" },
      principal: `key:k-${name}`,
    };
  };

  const written = await stub.tools().writeGrant(
    {
      revision: 0,
      value: { subject: EVERYONE, toolkit: "browser", tools: { kind: "all" } },
    },
    "test",
  );

  if (!written.ok) throw new Error(written.message);

  return {
    stub,
    get tools() {
      return stub.tools();
    },
    admin: await person("admin", "admin"),
    alice: await person("alice", "member"),
    bob: await person("bob", "member"),
  };
};

type Org = Awaited<ReturnType<typeof org>>;

/** The result of a call of the tool `name`, as `caller`. */
const call = async (
  plane: Org,
  caller: Person,
  name: string,
  args: Schema.JsonObject = {},
): Promise<Schema.JsonObject> => {
  const outcome = await plane.tools.callTool(
    caller.viewer,
    { name, arguments: args, principalId: caller.principal },
    POLICY,
  );

  if (outcome.outcome !== "result") throw new Error(`the call came to ${outcome.outcome}`);

  return outcome.result;
};

/** The text of a result's contents. */
const textOf = (result: Schema.JsonObject): string =>
  // SAFETY: the session tools answer text contents.
  (result["content"] as ReadonlyArray<{ readonly text?: string }>)
    .map((content) => content.text ?? "")
    .join("\n");

/** Opens a session as `caller` with `args`; its id. */
const open = async (plane: Org, caller: Person, args: Schema.JsonObject = {}) => {
  const result = await call(plane, caller, "browser_open", args);
  const id = /Browser session (bs_[0-9a-f]{32}) is open/.exec(textOf(result))?.[1];

  if (id === undefined) throw new Error(`no session opened: ${textOf(result)}`);

  return id;
};

/** Creates a profile as `who`; its id. */
const createProfile = async (plane: Org, who: Person, name: string, isPrivate?: boolean) => {
  const created = await plane.tools.createProfile(
    who.viewer,
    { name, ...(isPrivate === undefined ? {} : { private: isPrivate }) },
    who.principal,
  );

  if (!created.ok) throw new Error(created.message);

  return created.value;
};

/** Signs in to the fake web as `user` in the session `id`, at `site`. */
const signIn = async (plane: Org, caller: Person, id: string, user: string, site: string) => {
  await call(plane, caller, "browser_navigate", { sessionId: id, url: `${site}/login` });
  await call(plane, caller, "browser_type", { sessionId: id, ref: "e2", text: user });
  await call(plane, caller, "browser_type", { sessionId: id, ref: "e3", text: "hunter2" });
  await call(plane, caller, "browser_click", { sessionId: id, ref: "e4" });
};

/** Who the fake web's `/account` page of `site` says the session `id` is signed in as. */
const account = async (plane: Org, caller: Person, id: string, site: string) => {
  await call(plane, caller, "browser_navigate", { sessionId: id, url: `${site}/account` });

  return textOf(await call(plane, caller, "browser_snapshot", { sessionId: id }));
};

/** What the fake web's `/prefs` page of `site` says of its local storage in the session `id`. */
const theme = async (plane: Org, caller: Person, id: string, site: string) => {
  await call(plane, caller, "browser_navigate", { sessionId: id, url: `${site}/prefs` });

  return textOf(await call(plane, caller, "browser_snapshot", { sessionId: id }));
};

/** The `state` column of the profile `id`, as stored. */
const storedState = (plane: Org, id: string) =>
  runInDurableObject(plane.stub, (_instance, state) =>
    state.storage.sql
      .exec<{ state: string | null }>(`SELECT state FROM browser_profiles WHERE id = ?`, id)
      .one(),
  );

/** Overwrites the `state` column of the profile `id`. */
const putState = (plane: Org, id: string, value: string | null) =>
  runInDurableObject(plane.stub, (_instance, state) => {
    state.storage.sql.exec(`UPDATE browser_profiles SET state = ? WHERE id = ?`, value, id);
  });

const SITE = "https://shop.example.com";

/** What `browser_open` answers for a profile whose stored state does not open. */
const unreadable = (name: string) => ({
  content: [{ type: "text", text: `The browser profile ${name} could not be read.` }],
  isError: true,
});

/** What `browser_close` answers once it saved the session's state. */
const SAVED = (id: string) =>
  `Browser session ${id} is closed, and its state is saved into its browser profile.`;

/** What `browser_open` answers for a profile the caller may not use, whether or not it exists. */
const refusal = (name: string) => ({
  content: [
    {
      type: "text",
      text: `Unknown browser profile ${name}. browser_profile_list lists the profiles you may open a session from.`,
    },
  ],
  isError: true,
});

describe("browser profiles", () => {
  it("logging in, then closing with save, then opening again from the same profile starts logged in", async () => {
    const plane = await org();

    await createProfile(plane, plane.alice, "shop");
    const first = await open(plane, plane.alice, { profile: "shop" });

    expect(await account(plane, plane.alice, first, SITE)).toContain("Not signed in");
    await signIn(plane, plane.alice, first, "alice", SITE);

    expect(
      textOf(await call(plane, plane.alice, "browser_close", { sessionId: first, save: true })),
    ).toBe(`Browser session ${first} is closed, and its state is saved into its browser profile.`);

    const again = await open(plane, plane.alice, { profile: "shop" });

    expect(await account(plane, plane.alice, again, SITE)).toContain("Signed in as alice");

    // Without the profile, a session starts empty; closing without a save keeps the profile as it was.
    const empty = await open(plane, plane.alice);

    expect(await account(plane, plane.alice, empty, SITE)).toContain("Not signed in");
    await signIn(plane, plane.alice, again, "someone-else", SITE);
    await call(plane, plane.alice, "browser_close", { sessionId: again });

    const third = await open(plane, plane.alice, { profile: "shop" });

    expect(await account(plane, plane.alice, third, SITE)).toContain("Signed in as alice");

    const listed = await plane.tools.listProfiles(plane.alice.viewer);

    expect(listed.profiles).toMatchObject([{ name: "shop", private: true, revision: 1 }]);
    expect(listed.profiles[0]?.saved_at).not.toBeNull();
  });

  it("saves and restores a site's local storage with its cookies", async () => {
    const plane = await org();

    await createProfile(plane, plane.alice, "shop");
    const first = await open(plane, plane.alice, { profile: "shop" });

    await call(plane, plane.alice, "browser_navigate", {
      sessionId: first,
      url: `${SITE}/prefs?theme=dark`,
    });
    await signIn(plane, plane.alice, first, "alice", SITE);
    expect(
      textOf(await call(plane, plane.alice, "browser_close", { sessionId: first, save: true })),
    ).toBe(SAVED(first));

    const again = await open(plane, plane.alice, { profile: "shop" });

    expect(await theme(plane, plane.alice, again, SITE)).toContain("Theme: dark");
    expect(await account(plane, plane.alice, again, SITE)).toContain("Signed in as alice");

    // Saved again unchanged, it keeps the local storage it was opened with.
    expect(
      textOf(await call(plane, plane.alice, "browser_close", { sessionId: again, save: true })),
    ).toBe(SAVED(again));
    expect(
      await theme(plane, plane.alice, await open(plane, plane.alice, { profile: "shop" }), SITE),
    ).toContain("Theme: dark");
  });

  it("saves only the cookies of a browser reached again on a new connection, and says so", async () => {
    const plane = await org();
    const other = "https://news.example.com";

    await createProfile(plane, plane.alice, "shop");
    const id = await open(plane, plane.alice, { profile: "shop" });

    await call(plane, plane.alice, "browser_navigate", {
      sessionId: id,
      url: `${other}/prefs?theme=dark`,
    });
    await call(plane, plane.alice, "browser_navigate", { sessionId: id, url: `${SITE}/` });
    fakeBrowsers.drop(fakeBrowsers.opened.at(-1) ?? "");

    // The session goes on over a new connection, which knows nothing of the site visited before.
    await signIn(plane, plane.alice, id, "alice", SITE);
    expect(
      textOf(await call(plane, plane.alice, "browser_close", { sessionId: id, save: true })),
    ).toBe(
      `Browser session ${id} is closed, and its cookies are saved into its browser profile; the local storage of sites visited before the browser was reconnected was not.`,
    );

    const again = await open(plane, plane.alice, { profile: "shop" });

    expect(await account(plane, plane.alice, again, SITE)).toContain("Signed in as alice");
    expect(await theme(plane, plane.alice, again, other)).toContain("Theme: none");
  });

  it("a member without a grant cannot open a shared profile, and an unknown or forbidden profile answers the same way", async () => {
    const plane = await org();
    const shared = await createProfile(plane, plane.admin, "marketing");

    // No grant: not even its org admin may use it.
    expect(await call(plane, plane.alice, "browser_open", { profile: "marketing" })).toEqual(
      refusal("marketing"),
    );
    expect(await call(plane, plane.admin, "browser_open", { profile: "marketing" })).toEqual(
      refusal("marketing"),
    );
    expect(await call(plane, plane.alice, "browser_open", { profile: "nowhere" })).toEqual(
      refusal("nowhere"),
    );

    // Another member's private profile is as unknown.
    await createProfile(plane, plane.bob, "bobs");
    expect(await call(plane, plane.alice, "browser_open", { profile: "bobs" })).toEqual(
      refusal("bobs"),
    );

    const granted = await plane.tools.writeProfileGrant(
      {
        revision: 0,
        value: { subject: { kind: "member", id: plane.alice.viewer.member }, profile: shared.id },
      },
      "test",
    );

    expect(granted.ok).toBe(true);
    await open(plane, plane.alice, { profile: "marketing" });
    expect(await call(plane, plane.bob, "browser_open", { profile: "marketing" })).toEqual(
      refusal("marketing"),
    );

    expect(textOf(await call(plane, plane.alice, "browser_profile_list"))).toBe(
      "- marketing (shared)",
    );
    expect(textOf(await call(plane, plane.bob, "browser_profile_list"))).toBe("- bobs (private)");
  });

  it("refuses a plain member's save into a shared profile, still closing the session, and takes an org admin's", async () => {
    const plane = await org();
    const shared = await createProfile(plane, plane.admin, "marketing");

    await plane.tools.writeProfileGrant(
      { revision: 0, value: { subject: EVERYONE, profile: shared.id } },
      "test",
    );

    const admins = await open(plane, plane.admin, { profile: "marketing" });

    await signIn(plane, plane.admin, admins, "marketing", SITE);
    expect(
      textOf(await call(plane, plane.admin, "browser_close", { sessionId: admins, save: true })),
    ).toBe(`Browser session ${admins} is closed, and its state is saved into its browser profile.`);

    const alices = await open(plane, plane.alice, { profile: "marketing" });

    expect(await account(plane, plane.alice, alices, SITE)).toContain("Signed in as marketing");
    await signIn(plane, plane.alice, alices, "alice", SITE);

    expect(
      await call(plane, plane.alice, "browser_close", { sessionId: alices, save: true }),
    ).toEqual({
      content: [
        {
          type: "text",
          text: `Browser session ${alices} is closed, but its state was not saved: only an org admin may save into a shared browser profile.`,
        },
      ],
      isError: true,
    });

    // Closed all the same, and the profile kept the admin's login.
    expect(
      textOf(await call(plane, plane.alice, "browser_snapshot", { sessionId: alices })),
    ).toContain("is closed");

    const later = await open(plane, plane.bob, { profile: "marketing" });

    expect(await account(plane, plane.bob, later, SITE)).toContain("Signed in as marketing");
  });

  it("refuses a save from a session opened without a profile, closing it all the same", async () => {
    const plane = await org();
    const id = await open(plane, plane.alice);

    expect(await call(plane, plane.alice, "browser_close", { sessionId: id, save: true })).toEqual({
      content: [
        {
          type: "text",
          text: `Browser session ${id} is closed, but its state was not saved: it was not opened from a browser profile.`,
        },
      ],
      isError: true,
    });
    expect(textOf(await call(plane, plane.alice, "browser_tab_list", { sessionId: id }))).toContain(
      "is closed",
    );
  });

  it("keeps the stored state sealed: the raw stored bytes hold no cookie value", async () => {
    const plane = await org();

    await createProfile(plane, plane.alice, "shop");
    const id = await open(plane, plane.alice, { profile: "shop" });

    await signIn(plane, plane.alice, id, "alice", SITE);
    await call(plane, plane.alice, "browser_close", { sessionId: id, save: true });

    const stored = await runInDurableObject(plane.stub, (_instance, state) =>
      state.storage.sql
        .exec<Record<string, SqlStorageValue>>(`SELECT * FROM browser_profiles`)
        .toArray(),
    );

    expect(stored).toHaveLength(1);
    expect(stored[0]?.["state"]).toMatch(/^enc:v1:/);
    expect(JSON.stringify(stored)).not.toContain("secret-cookie-alice");

    // The session's own object keeps nothing of it either.
    const again = await open(plane, plane.alice, { profile: "shop" });

    expect(await account(plane, plane.alice, again, SITE)).toContain("Signed in as alice");
  });

  it("shows org admins only that another member's private profile exists", async () => {
    const plane = await org();
    const alices = await createProfile(plane, plane.alice, "alice-bank");

    const listed = await plane.tools.listProfiles(plane.admin.viewer);

    expect(listed.profiles).toEqual([]);
    expect(listed.others).toEqual([
      {
        id: alices.id,
        private: true,
        limited: true,
        owner: { member_id: plane.alice.viewer.member, email: "alice@example.com" },
        created_at: alices.created_at,
        revision: 1,
      },
    ]);
    expect(JSON.stringify(listed)).not.toContain("alice-bank");

    // Neither renamed nor used by them, but removed.
    expect(
      await plane.tools.updateProfile(plane.admin.viewer, alices.id, 1, { name: "x" }, "test"),
    ).toMatchObject({ ok: false, error: "forbidden" });
    expect(await call(plane, plane.admin, "browser_open", { profile: "alice-bank" })).toMatchObject(
      {
        isError: true,
      },
    );
    expect(textOf(await call(plane, plane.admin, "browser_profile_list"))).toBe(
      "You may use no browser profile.",
    );
    expect(await plane.tools.removeProfile(plane.admin.viewer, alices.id, 1)).toEqual({
      ok: true,
      value: { id: alices.id, removed: true },
    });
    expect((await plane.tools.listProfiles(plane.alice.viewer)).profiles).toEqual([]);
  });

  it("follows the private-toolkits setting: while it is off, private profiles are neither created nor used", async () => {
    const plane = await org();

    await createProfile(plane, plane.alice, "shop");
    await plane.stub.setMembershipSettings({ privateToolkits: false });

    expect(
      await plane.tools.createProfile(plane.alice.viewer, { name: "more" }, "test"),
    ).toMatchObject({ ok: false, error: "private_toolkits_unavailable" });
    expect(await call(plane, plane.alice, "browser_open", { profile: "shop" })).toMatchObject({
      isError: true,
    });
    expect(textOf(await call(plane, plane.alice, "browser_profile_list"))).toBe(
      "You may use no browser profile.",
    );

    // Kept, and usable again once it is on.
    await plane.stub.setMembershipSettings({ privateToolkits: true });
    await open(plane, plane.alice, { profile: "shop" });
  });

  it("is named, renamed at its revision and removed with its grants; names follow toolkits' rules", async () => {
    const plane = await org();
    const shared = await createProfile(plane, plane.admin, "team");

    // A plain member's profile is private whatever they ask; an admin's is shared unless they ask.
    expect(await createProfile(plane, plane.alice, "mine", false)).toMatchObject({ private: true });
    expect(await createProfile(plane, plane.admin, "admins", true)).toMatchObject({
      private: true,
    });

    expect(
      await plane.tools.createProfile(plane.admin.viewer, { name: "team" }, "test"),
    ).toMatchObject({ ok: false, error: "name_taken" });
    expect(
      await plane.tools.createProfile(plane.alice.viewer, { name: "team" }, "test"),
    ).toMatchObject({ ok: false, error: "name_taken" });
    expect(
      await plane.tools.createProfile(plane.bob.viewer, { name: "mine" }, "test"),
    ).toMatchObject({ ok: true });
    expect(
      await plane.tools.createProfile(plane.bob.viewer, { name: "Not OK" }, "test"),
    ).toMatchObject({ ok: false, error: "invalid" });

    expect(
      await plane.tools.updateProfile(plane.alice.viewer, shared.id, 1, { name: "x" }, "test"),
    ).toMatchObject({ ok: false, error: "not_found" });
    expect(
      await plane.tools.updateProfile(plane.admin.viewer, shared.id, 2, { name: "x" }, "test"),
    ).toMatchObject({ ok: false, error: "conflict" });

    const renamed = await plane.tools.updateProfile(
      plane.admin.viewer,
      shared.id,
      1,
      { name: "renamed" },
      "test",
    );

    expect(renamed).toMatchObject({ ok: true, value: { name: "renamed", revision: 2 } });

    const grant = await plane.tools.writeProfileGrant(
      { revision: 0, value: { subject: EVERYONE, profile: shared.id } },
      "test",
    );

    expect(grant).toMatchObject({ ok: true, value: { revision: 1 } });
    expect(
      await plane.tools.writeProfileGrant(
        { revision: 0, value: { subject: EVERYONE, profile: shared.id } },
        "test",
      ),
    ).toMatchObject({ ok: false, error: "conflict" });

    // A private profile takes no grant.
    const mine = (await plane.tools.listProfiles(plane.alice.viewer)).profiles[0];

    expect(
      await plane.tools.writeProfileGrant(
        { revision: 0, value: { subject: EVERYONE, profile: mine?.id ?? "" } },
        "test",
      ),
    ).toMatchObject({ ok: false, error: "invalid" });

    expect(await plane.tools.removeProfile(plane.admin.viewer, shared.id, 1)).toMatchObject({
      ok: false,
      error: "conflict",
    });
    expect(await plane.tools.removeProfile(plane.admin.viewer, shared.id, 2)).toMatchObject({
      ok: true,
    });
    expect((await plane.tools.listProfileGrants()).grants).toEqual([]);
  });

  it("goes with its member, as do the profile grants that named them", async () => {
    const plane = await org();
    const shared = await createProfile(plane, plane.admin, "team");

    await createProfile(plane, plane.bob, "bobs");
    await plane.tools.writeProfileGrant(
      {
        revision: 0,
        value: { subject: { kind: "member", id: plane.bob.viewer.member }, profile: shared.id },
      },
      "test",
    );

    await plane.stub.removeMember(plane.bob.viewer.member, OWNER);

    expect((await plane.tools.listProfiles(plane.admin.viewer)).others).toEqual([]);
    expect((await plane.tools.listProfileGrants()).grants).toEqual([]);
  });

  it("opens only in its own org: another org's profile is unknown there, by name and by id", async () => {
    const home = await org();
    const away = await org();
    const shared = await createProfile(home, home.admin, "team");

    await createProfile(home, home.alice, "shop");
    await home.tools.writeProfileGrant(
      { revision: 0, value: { subject: EVERYONE, profile: shared.id } },
      "test",
    );
    await open(home, home.alice, { profile: "team" });

    for (const name of ["team", "shop"])
      expect(await call(away, away.alice, "browser_open", { profile: name })).toMatchObject({
        isError: true,
      });

    expect(
      await away.tools.writeProfileGrant(
        { revision: 0, value: { subject: EVERYONE, profile: shared.id } },
        "test",
      ),
    ).toMatchObject({ ok: false, error: "invalid" });
    expect(
      await away.tools.removeProfile(away.admin.viewer, shared.id, shared.revision),
    ).toMatchObject({ ok: false, error: "not_found" });
  });

  it("opens another org's profile of the same name as that org's own", async () => {
    const home = await org();
    const away = await org();

    await createProfile(home, home.alice, "shop");
    await createProfile(away, away.alice, "shop");

    const id = await open(home, home.alice, { profile: "shop" });

    await signIn(home, home.alice, id, "alice", SITE);
    await call(home, home.alice, "browser_close", { sessionId: id, save: true });

    const theirs = await open(away, away.alice, { profile: "shop" });

    expect(await account(away, away.alice, theirs, SITE)).toContain("Not signed in");
  });

  it("does not open a state copied into another profile's row, of its org or of another", async () => {
    const home = await org();
    const away = await org();
    const saved = await createProfile(home, home.alice, "shop");
    const sibling = await createProfile(home, home.alice, "bank");
    const elsewhere = await createProfile(away, away.alice, "shop");

    const id = await open(home, home.alice, { profile: "shop" });

    await signIn(home, home.alice, id, "alice", SITE);
    await call(home, home.alice, "browser_close", { sessionId: id, save: true });

    const { state } = await storedState(home, saved.id);

    expect(state).toMatch(/^enc:v1:/);
    await putState(home, sibling.id, state);
    await putState(away, elsewhere.id, state);

    expect(await call(home, home.alice, "browser_open", { profile: "bank" })).toEqual(
      unreadable("bank"),
    );
    expect(await call(away, away.alice, "browser_open", { profile: "shop" })).toEqual(
      unreadable("shop"),
    );

    // Its own row still opens.
    const again = await open(home, home.alice, { profile: "shop" });

    expect(await account(home, home.alice, again, SITE)).toContain("Signed in as alice");
  });

  it("goes with its org: deleting the org drops the profiles' tables", async () => {
    const plane = await org();

    await createProfile(plane, plane.admin, "team");

    const tables = () =>
      runInDurableObject(plane.stub, (_instance, state) =>
        state.storage.sql
          .exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
          .toArray()
          .map((row) => row.name)
          .filter((name) => (PROFILE_TABLES as ReadonlyArray<string>).includes(name))
          .toSorted(),
      );

    expect(await tables()).toEqual(PROFILE_TABLES.toSorted());
    await plane.stub.wipeOrg();
    expect(await tables()).toEqual([]);
  });
});
