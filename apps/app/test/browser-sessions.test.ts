// The Browser sessions page's routes through the management API (#216, ADR 0039): the app Worker's router, the Access
// gate and the role table, and the real ControlPlane with the Tools part, each answer decoded with the contract. This
// ControlPlane has no browser, so no session is ever open; the sessions themselves, their handoffs and Live Views, and
// who may watch or end one are `@commissary/tools`' tests (test/browser-handoff.test.ts).
import { afterAll, describe, expect, it } from "vitest";
import { Schema } from "effect";
import { BrowserSessionsList } from "@commissary/contract/browser-sessions";
import { ADMIN, isolatedPlatform, jsonInit, makeHarness, token } from "./support/management.ts";

const registry = isolatedPlatform();

const harness = makeHarness(undefined, registry.bindings);

afterAll(async () => {
  await harness.dispose();
});

/** An org with an org admin and a plain member, and their tokens. */
const newOrg = async () => {
  const slug = `sessions-${crypto.randomUUID().slice(0, 8)}`;
  const platform = await token(ADMIN);

  const made = await harness.json("/v9/management/orgs", jsonInit("POST", { slug, name: slug }));

  expect(made.status).toBe(201);

  const person = async (name: string, role: string) => {
    const email = `${name}-${slug}@example.com`;

    const added = await harness.json(`/v9/management/orgs/${slug}/members`, {
      ...jsonInit("POST", { email, role }),
      auth: platform,
    });

    expect(added.status).toBe(201);

    return await token(email);
  };

  return { slug, admin: await person("admin", "admin"), member: await person("member", "member") };
};

const send = async (slug: string, path: string, auth: string, method = "GET") =>
  await harness.json(`/v9/management/orgs/${slug}/browser-sessions${path}`, { method, auth });

describe("browser sessions", () => {
  it("are listed to a member and an org admin alike, none while nothing is open", async () => {
    const org = await newOrg();

    for (const auth of [org.member, org.admin]) {
      const listed = await send(org.slug, "", auth);

      expect(listed.status).toBe(200);
      expect(Schema.decodeUnknownSync(BrowserSessionsList)(listed.body).sessions).toEqual([]);
    }
  });

  it("answer not_found for a session the caller may not see, however it is asked for", async () => {
    const org = await newOrg();
    const id = crypto.randomUUID();

    for (const [path, method] of [
      [`/${id}`, "GET"],
      [`/${id}/live-view`, "POST"],
      [`/${id}`, "DELETE"],
    ] as const) {
      const reply = await send(org.slug, path, org.member, method);

      expect(reply.status).toBe(404);
      expect((reply.body as { error?: string }).error).toBe("not_found");
      // A Live View's reply is never cached: neither its link nor its refusal.
      expect(reply.headers.get("cache-control")).toBe("no-store");
    }
  });
});
