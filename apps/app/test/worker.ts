// The test Worker's entry (vitest.config.ts): the app Worker's handler and the state Worker's Durable Objects in one
// isolate (#135, ADR 0030). Deployed, the app binds the state Worker's namespaces by script name; here they are the
// test Worker's own, so `runInDurableObject` and global `fetch` stubs reach them, with no auxiliary Worker.
//
// On Commissary Cloud the app Worker asks the auth Worker (apps/auth) who a session belongs to over its service binding
// (`AUTH`). Here `AUTH` is {@link FakeSignIn}, an entrypoint of this Worker reached over RPC like the real one
// (`ctx.exports`), whose sessions the tests start themselves (test/hosted/support.ts `signIn`). Better Auth's own
// sign-in is the auth Worker's, tested there (apps/auth/test/).
//
// A request with {@link API_WORKER_HEADER} goes to the API Worker's handler (apps/api) instead, with the same bindings:
// the client API as the zone routes send it to the API Worker on a stage with one host, so a test can follow an MCP
// client from the app host's OAuth server to `/mcp` (test/hosted/mcp-oauth.test.ts).
//
// The agent runs (#227) are the API Worker's `AgentRun` and run gateway, exported here as the API Worker exports them: a
// run's model and tool calls go through the API Worker's handler over this Worker's `ctx.exports`, with its bindings.
// The schedule triggers' `AgentSchedule` (#231) is the API Worker's too.
import { WorkerEntrypoint } from "cloudflare:workers";
import { api } from "@commissary/api";
import type { SignedInPerson, SignInService } from "@commissary/auth";
import app from "../src/index.ts";

export { AgentRun, AgentRunGateway, AgentSchedule } from "@commissary/api";

export {
  ControlPlane,
  Platform,
  SandboxEgress,
  SandboxSession,
  SessionState,
  WorkspaceServiceProxy,
} from "@commissary/state-worker";

/** A request that carries this header goes to the API Worker's handler rather than the app Worker's. */
export const API_WORKER_HEADER = "x-test-api-worker";

// The browser sessions' objects (#213) over a fake provider's browsers: the cross-org suite opens sessions in them. The
// tests' ControlPlane has no `BROWSER`, so no browser toolkit reaches them.
export { FakeBrowserSession as BrowserSession } from "@commissary/tools/testing";

/** The session cookie the fake reads, named like Better Auth's. */
export const FAKE_SESSION_COOKIE = "__Secure-better-auth.session_token";

/** Where the fake keeps a session (`<prefix><token>`: the person) in the test Worker's KV namespace. */
export const FAKE_SESSION_PREFIX = "test:sign-in:session:";

/** A session token whose lookup fails, as the auth Worker's does when its database cannot be reached. */
export const FAILING_SESSION_TOKEN = "lookup-fails";

/** Where the fake keeps a sign-in account (`<prefix><email>`), as Better Auth's `user` row. */
export const FAKE_ACCOUNT_PREFIX = "test:sign-in:account:";

const tokenOf = (cookie: string): string | undefined =>
  cookie
    .split(";")
    .map((pair) => pair.trim())
    .find((pair) => pair.startsWith(`${FAKE_SESSION_COOKIE}=`))
    ?.slice(FAKE_SESSION_COOKIE.length + 1);

/** The auth Worker's RPC (`SignInService`) over sessions the tests start, kept in `CACHE`. */
export class FakeSignIn extends WorkerEntrypoint<Env> implements SignInService {
  async session(cookie: string): Promise<SignedInPerson | null> {
    const token = tokenOf(cookie);

    if (token === undefined || token === "") return null;

    if (token === FAILING_SESSION_TOKEN) throw new Error("the sign-in database is unreachable");

    return await this.env.CACHE.get<SignedInPerson>(`${FAKE_SESSION_PREFIX}${token}`, "json");
  }

  async endSessions(emails: ReadonlyArray<string>): Promise<number> {
    const ended = new Set(emails.map((email) => email.toLowerCase()));

    return await this.#end((email) => ended.has(email));
  }

  async endDomainSessions(domain: string): Promise<number> {
    return await this.#end((email) => email.endsWith(`@${domain.toLowerCase()}`));
  }

  async deleteSignInAccount(email: string): Promise<number> {
    const address = email.toLowerCase();
    const key = `${FAKE_ACCOUNT_PREFIX}${address}`;
    const existed = (await this.env.CACHE.get(key)) !== null;

    await this.#end((holder) => holder === address);
    await this.env.CACHE.delete(key);

    return existed ? 1 : 0;
  }

  /** Ends the sessions of the people `ends` names; how many. */
  async #end(ends: (email: string) => boolean): Promise<number> {
    const { keys } = await this.env.CACHE.list({ prefix: FAKE_SESSION_PREFIX });
    let ended = 0;

    for (const { name } of keys) {
      const person = await this.env.CACHE.get<SignedInPerson>(name, "json");

      if (person !== null && ends(person.email)) {
        await this.env.CACHE.delete(name);
        ended += 1;
      }
    }

    return ended;
  }
}

/** The bindings of each `env` with `AUTH` added, kept so that what the Worker caches per `env` object stays cached. */
const withAuth = new WeakMap<Env, Env>();

export default {
  fetch: async (request, env, ctx) => {
    let bound = withAuth.get(env);

    if (bound === undefined) {
      // SAFETY: `ctx.exports` holds a loopback binding of each entrypoint this module exports, `FakeSignIn` among
      // them; its RPC stub has `SignInService`'s methods. `Cloudflare.Exports` is typed after the app Worker's own
      // module (src/env.d.ts), which does not export the fake.
      const fake = (ctx.exports as unknown as { FakeSignIn: SignInService }).FakeSignIn;

      bound = { ...env, AUTH: fake };
      withAuth.set(env, bound);
    }

    if (request.headers.has(API_WORKER_HEADER)) return await api.fetch(request, bound, ctx);

    return await app.fetch(request, bound, ctx);
  },
} satisfies ExportedHandler<Env>;
