// Sign-up on the auth host (#132, src/sign-in/sessions.ts): a person's first session signs them up once, before it
// starts (`ensureSignedUp`, `@commissary/auth`): a Personal org they own unless they were invited, and no session at
// all while a platform admin has them suspended.
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { resetStandingCaches } from "@commissary/auth";
import { platformOf } from "@commissary/state";
import {
  addMember,
  clearPeople,
  installFakes,
  membersOf,
  orgOwnedBy,
  orgsOf,
  restoreFetch,
  sessionOf,
  signIn,
  upstreams,
} from "./support.ts";

beforeAll(installFakes);

afterAll(restoreFetch);

beforeEach(async () => {
  await clearPeople();
  resetStandingCaches();
  upstreams.unexpected = [];
});

/** Suspends or unsuspends `email`, as a platform admin does (`PATCH /people/<email>`, the app Worker's). */
const suspend = async (email: string, suspended: boolean) => {
  await platformOf(env).updatePerson(email, { suspended }, Date.now(), 3);
  resetStandingCaches();
};

describe("signing up", () => {
  it("gives a person signing in for the first time a Personal org they own", async () => {
    const cookie = await signIn({ email: "ada@example.com" });

    expect(await sessionOf(cookie)).toMatchObject({ email: "ada@example.com" });
    const orgs = await platformOf(env).orgsOfEmail("ada@example.com");
    const [personal] = orgs;

    expect(orgs).toHaveLength(1);

    if (personal === undefined) return;
    expect(personal.name).toBe("Personal");
    expect(personal.slug).toMatch(/^personal-[0-9a-f]{10}$/);
    expect(await membersOf(personal.id)).toMatchObject([
      { email: "ada@example.com", role: "owner" },
    ]);

    // Signing in again creates nothing more.
    resetStandingCaches();
    await signIn({ email: "ada@example.com" });
    expect(await orgsOf("ada@example.com")).toEqual([personal.slug]);
  });

  it("gives an invited person no Personal org", async () => {
    const org = await orgOwnedBy("acme", "owner@example.com");
    await addMember(org, "bob@example.com", "member");

    expect(await sessionOf(await signIn({ email: "bob@example.com" }))).toMatchObject({
      email: "bob@example.com",
    });
    expect(await orgsOf("bob@example.com")).toEqual(["acme"]);
  });

  it("starts no session for a suspended person until the suspension is lifted", async () => {
    await signIn({ email: "mallory@example.com" });

    await suspend("mallory@example.com", true);
    expect(await signIn({ email: "mallory@example.com" })).toBe("");

    await suspend("mallory@example.com", false);
    const cookie = await signIn({ email: "mallory@example.com" });
    expect(await sessionOf(cookie)).toMatchObject({ email: "mallory@example.com" });
    expect(await orgsOf("mallory@example.com")).toHaveLength(1);
  });
});
