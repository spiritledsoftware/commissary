// Helpers for the API Worker's Commissary Cloud tests (vitest project `hosted`, vitest.config.ts): requests to
// `https://commissary.test` through the Worker's default export, and orgs whose people hold API keys, set up straight
// through the state Worker's objects (sign-up, the member routes and the API key routes are the app Worker's:
// apps/app/test/hosted/).
import { env, exports } from "cloudflare:workers";
import { Effect } from "effect";
import { AuthDirectory, syncOrgIndex } from "@commissary/auth";
import { newOrgId, type OrgId } from "@commissary/core";
import { platformOf, stateAuthDirectory } from "@commissary/state";
import { addMember, issueKey } from "../support/client.ts";

export const ORIGIN = "https://commissary.test";

/** A request to the API Worker at {@link ORIGIN}. */
export const call = async (path: string, init?: RequestInit): Promise<Response> =>
  await exports.default.fetch(new Request(`${ORIGIN}${path}`, init));

/** `GET /v1/models` with the API key `key`. */
export const models = (key: string): Promise<Response> =>
  call("/v1/models", { headers: { authorization: `Bearer ${key}` } });

/**
 * A new org owned by `email` and an API key of theirs in it, as signing up (a Personal org) or `POST /orgs` and
 * `POST /api-keys` make them: the org's id and slug, the owner's member id, and the key.
 */
export const keyedOrg = async (
  email: string,
): Promise<{
  readonly org: OrgId;
  readonly slug: string;
  readonly member: string;
  readonly key: string;
}> => {
  const slug = `org-${crypto.randomUUID().slice(0, 8)}`;
  const org = newOrgId();
  const created = await platformOf(env).createOrg({ slug, name: slug, id: org }, Date.now());

  if (!created.ok) throw new Error(created.message);
  const owner = await addMember(org, email, "owner");

  await Effect.runPromise(
    syncOrgIndex(org).pipe(Effect.provideService(AuthDirectory, stateAuthDirectory(env))),
  );

  return { org, slug, member: owner.id, key: (await issueKey(org, owner)).key };
};
