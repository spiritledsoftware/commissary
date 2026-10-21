// The sandbox toolkit's open sessions through the management API (#225, ADR 0041): the app Worker's router, the Access
// gate and the role table, and the real ControlPlane with the Tools part (and its sandbox: sessions are opened on it
// as in org-isolation.test.ts), each answer decoded with the contract. What each session says of itself, and the
// cases of who sees and who may end one, are `@commissary/tools`' tests (test/sandbox-sessions.test.ts).
import { env } from "cloudflare:workers";
import { afterAll, describe, expect, it } from "vitest";
import { Schema } from "effect";
import { EndedSandboxSession, SandboxSessionsList } from "@commissary/contract/sandbox-sessions";
import { ADMIN, isolatedPlatform, jsonInit, makeHarness, token } from "./support/management.ts";

const registry = isolatedPlatform();

const harness = makeHarness(undefined, registry.bindings);

afterAll(async () => {
  await harness.dispose();
});

interface Person {
  readonly id: string;
  readonly email: string;
  readonly auth: string;
}

/** An org with an org admin and two plain members, everyone granted the sandbox toolkit. */
const newOrg = async () => {
  const slug = `sandbox-${crypto.randomUUID().slice(0, 8)}`;
  const platform = await token(ADMIN);

  const made = await harness.json("/v9/management/orgs", jsonInit("POST", { slug, name: slug }));

  expect(made.status).toBe(201);

  const person = async (name: string, role: string): Promise<Person> => {
    const email = `${name}-${slug}@example.com`;

    const added = await harness.json(`/v9/management/orgs/${slug}/members`, {
      ...jsonInit("POST", { email, role }),
      auth: platform,
    });

    expect(added.status).toBe(201);

    return { id: (added.body as { id: string }).id, email, auth: await token(email) };
  };

  const found = await registry.platform.getOrgBySlug(slug);

  if (found === undefined) throw new Error("the org is not registered");

  const granted = await env.CONTROL_PLANE.getByName(found.id)
    .tools()
    .writeGrant(
      {
        revision: 0,
        value: { subject: { kind: "everyone" }, toolkit: "sandbox", tools: { kind: "all" } },
      },
      "test",
    );

  if (!granted.ok) throw new Error(granted.message);

  /** Opens a sandbox session as `who`, on the org's ControlPlane; its id. */
  const open = async (who: Person): Promise<string> => {
    const opened = await env.CONTROL_PLANE.getByName(found.id)
      .tools()
      .callTool(
        { member: who.id, admin: false },
        { name: "sandbox_open", arguments: {}, principalId: `user:${who.email}` },
        { ownHosts: [], localDevelopment: false },
      );

    if (opened.outcome !== "result") throw new Error(`the call came to ${opened.outcome}`);

    // SAFETY: `sandbox_open` answers the session in its structured content.
    return (opened.result["structuredContent"] as { session: string }).session;
  };

  return {
    slug,
    open,
    admin: await person("admin", "admin"),
    member: await person("member", "member"),
    other: await person("other", "member"),
  };
};

const send = async (slug: string, path: string, auth: string, method = "GET") =>
  await harness.json(`/v9/management/orgs/${slug}/sandbox-sessions${path}`, { method, auth });

/** The ids of the sessions a list answer holds. */
const idsOf = (reply: { readonly body: unknown }) =>
  Schema.decodeUnknownSync(SandboxSessionsList)(reply.body).sessions.map((session) => session.id);

describe("sandbox sessions", () => {
  it("are listed to a member and an org admin alike, none while nothing is open", async () => {
    const org = await newOrg();

    for (const who of [org.member, org.admin]) {
      const listed = await send(org.slug, "", who.auth);

      expect(listed.status).toBe(200);
      expect(Schema.decodeUnknownSync(SandboxSessionsList)(listed.body)).toEqual({
        sessions: [],
        truncated: false,
      });
    }
  });

  it("are listed to their member and to an org admin, and ended by either, not by another member", async () => {
    const org = await newOrg();
    const mine = await org.open(org.member);
    const theirs = await org.open(org.other);

    expect(idsOf(await send(org.slug, "", org.member.auth))).toEqual([mine]);
    expect(idsOf(await send(org.slug, "", org.admin.auth))).toEqual([mine, theirs]);

    const refused = await send(org.slug, `/${mine}`, org.other.auth, "DELETE");

    expect(refused.status).toBe(404);
    expect((refused.body as { error?: string }).error).toBe("not_found");

    const ended = await send(org.slug, `/${mine}`, org.member.auth, "DELETE");

    expect(ended.status).toBe(200);
    expect(Schema.decodeUnknownSync(EndedSandboxSession)(ended.body)).toEqual({
      id: mine,
      ended: true,
    });

    const byAdmin = await send(org.slug, `/${theirs}`, org.admin.auth, "DELETE");

    expect(byAdmin.status).toBe(200);
    expect(idsOf(await send(org.slug, "", org.admin.auth))).toEqual([]);
  });

  it("answer not_found when a session is not open", async () => {
    const org = await newOrg();
    const reply = await send(org.slug, `/sbx_${"0".repeat(32)}`, org.member.auth, "DELETE");

    expect(reply.status).toBe(404);
    expect((reply.body as { error?: string }).error).toBe("not_found");
  });
});
