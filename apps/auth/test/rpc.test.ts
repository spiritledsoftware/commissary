// The auth Worker's RPC (`SignInService`, `@commissary/auth`; src/index.ts), as the app Worker's service binding calls
// it: whose session a cookie is, ending people's or a domain's sessions, and deleting a sign-in account.
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { resetStandingCaches } from "@commissary/auth";
import {
  clearPeople,
  installFakes,
  restoreFetch,
  rpc,
  SESSION_COOKIE,
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

/** The rows the `SignIn` database keeps of `email`. */
const rowsOf = async (email: string) => {
  const count = async (sql: string) =>
    (await env.SIGN_IN.prepare(sql).bind(email).first<{ n: number }>())?.n;

  const ofUser = `"userId" IN (SELECT id FROM "user" WHERE email = ?)`;

  return {
    users: await count(`SELECT count(*) AS n FROM "user" WHERE email = ?`),
    sessions: await count(`SELECT count(*) AS n FROM "session" WHERE ${ofUser}`),
    accounts: await count(`SELECT count(*) AS n FROM "account" WHERE ${ofUser}`),
  };
};

describe("session", () => {
  it("names the person of a live session, and nobody without one", async () => {
    const cookie = await signIn({ email: "Ada@Example.com" });
    const person = await sessionOf(cookie);

    expect(person).toEqual({ userId: expect.any(String), email: "ada@example.com" });
    expect(await sessionOf("")).toBeNull();
    expect(await sessionOf(`${SESSION_COOKIE}=forged`)).toBeNull();
  });
});

describe("endSessions", () => {
  it("ends every session of the people named and keeps their accounts", async () => {
    const first = await signIn({ email: "mallory@example.com" });
    const second = await signIn({ email: "mallory@example.com" });
    const other = await signIn({ email: "bob@example.com" });

    expect(await rpc.endSessions(["Mallory@example.com"])).toBe(2);
    expect(await sessionOf(first)).toBeNull();
    expect(await sessionOf(second)).toBeNull();
    expect(await sessionOf(other)).toMatchObject({ email: "bob@example.com" });
    expect(await rowsOf("mallory@example.com")).toEqual({ users: 1, sessions: 0, accounts: 1 });
    expect(await rpc.endSessions(["mallory@example.com"])).toBe(0);
  });
});

describe("endDomainSessions", () => {
  it("ends the sessions of the people at the domain only", async () => {
    const worker = await signIn({ email: "ada@acme.test" });
    const outsider = await signIn({ email: "ada@acme.test.example.com" });

    expect(await rpc.endDomainSessions("acme.test")).toBe(1);
    expect(await sessionOf(worker)).toBeNull();
    expect(await sessionOf(outsider)).toMatchObject({ email: "ada@acme.test.example.com" });
  });
});

describe("deleteSignInAccount", () => {
  it("deletes the account with its sessions and linked accounts, and succeeds again once it is gone", async () => {
    const cookie = await signIn({ email: "gus@example.com" });

    expect(await rowsOf("gus@example.com")).toEqual({ users: 1, sessions: 1, accounts: 1 });
    expect(await rpc.deleteSignInAccount("Gus@example.com")).toBe(1);
    expect(await rowsOf("gus@example.com")).toEqual({ users: 0, sessions: 0, accounts: 0 });
    expect(await sessionOf(cookie)).toBeNull();
    expect(await rpc.deleteSignInAccount("gus@example.com")).toBe(0);

    // A later sign-in is a new sign-up.
    expect(await sessionOf(await signIn({ email: "gus@example.com" }))).toMatchObject({
      email: "gus@example.com",
    });
  });
});
