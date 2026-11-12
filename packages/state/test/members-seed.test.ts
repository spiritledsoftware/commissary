// Seeding the platform admins into `global` (`MemberStore.seedPlatformAdmins`, ADR 0022): the first time a ControlPlane
// is used, the deployment's platform admins become org owners of `global`, once. Each test starts from a ControlPlane
// whose members are cleared and whose seeding has not run.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { GLOBAL_ORG, OrgId } from "@commissary/core";
import { controlPlaneOf, MemberStore } from "../src/index.ts";

const controlPlane = (org: OrgId) => controlPlaneOf(env, org);

/** The members and the seeded flag back to a ControlPlane that was never used. */
const unseeded = async (org: OrgId) => {
  await runInDurableObject(controlPlane(org), async (instance, state) => {
    await instance.started;

    for (const table of ["members", "teams", "team_members", "service_tokens"])
      state.storage.sql.exec(`DELETE FROM ${table}`);
    state.storage.sql.exec(
      `UPDATE membership SET admins_migrated = 0, counter = 0, index_synced = 0`,
    );
  });
};

/** Seeds `org`'s store with `emails` (a second call with `later` too) and answers who is a member afterwards. */
const seed = async (org: OrgId, emails: ReadonlyArray<string>, later: ReadonlyArray<string> = []) =>
  await runInDurableObject(controlPlane(org), (_instance, state) => {
    const store = new MemberStore(state.storage.sql, org, (body) =>
      state.storage.transactionSync(body),
    );

    store.seedPlatformAdmins(emails);
    store.seedPlatformAdmins(later);

    return {
      seeded: store.platformAdminsSeeded(),
      members: store.members().map(({ email, role }) => ({ email, role })),
    };
  });

beforeEach(async () => {
  await unseeded(GLOBAL_ORG);
});

describe("seeding the platform admins", () => {
  it("makes them org owners of global, lowercased and without invalid emails", async () => {
    expect(
      await seed(GLOBAL_ORG, ["Boss@example.com", "boss@example.com", "not an email"]),
    ).toEqual({
      seeded: true,
      members: [{ email: "boss@example.com", role: "owner" }],
    });
  });

  it("runs once: a platform admin named later is not added", async () => {
    expect(await seed(GLOBAL_ORG, ["boss@example.com"], ["late@example.com"])).toEqual({
      seeded: true,
      members: [{ email: "boss@example.com", role: "owner" }],
    });
  });

  it("raises a member who joined before it to owner", async () => {
    await runInDurableObject(controlPlane(GLOBAL_ORG), (_instance, state) => {
      new MemberStore(state.storage.sql, GLOBAL_ORG, (body) =>
        state.storage.transactionSync(body),
      ).admit({ kind: "user", email: "boss@example.com" }, true);
    });

    expect((await seed(GLOBAL_ORG, ["boss@example.com"])).members).toEqual([
      { email: "boss@example.com", role: "owner" },
    ]);
  });

  it("only records that it ran in another org", async () => {
    const org = OrgId.make(`seed-${crypto.randomUUID().slice(0, 8)}`);

    await unseeded(org);

    expect(await seed(org, ["boss@example.com"])).toEqual({ seeded: true, members: [] });
  });
});
