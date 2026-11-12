// Shared and private credentials through the management API and the real ControlPlane (ADR 0023, ADR 0025): a
// member's private account or provider key is theirs alone, an org admin sees that it exists and may disable or remove it,
// and the org setting turns private credentials off without deleting them. Selection itself is tested in
// credentials-ownership.test.ts; here the same rule is checked end to end.
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { OrgId } from "@commissary/core";
import {
  ADMIN,
  claudeFile,
  isolatedPlatform,
  jsonInit,
  makeHarness,
  token,
} from "./support/management.ts";
import {
  insertUsageRecord,
  orgAuthIndexer,
  resetUsageDb,
  sampleRecord,
} from "@commissary/models/testing";

const registry = isolatedPlatform();

const harness = makeHarness(undefined, registry.bindings);

afterAll(harness.dispose);

beforeAll(async () => {
  await resetUsageDb();
});

type Payload = Parameters<typeof jsonInit>[1];

interface Auth {
  readonly auth: string;
}

interface Person extends Auth {
  readonly id: string;
  readonly email: string;
}

interface Org {
  readonly slug: string;
  readonly id: string;
  readonly platform: Auth;
  readonly admin: Person;
  readonly alice: Person;
  readonly bob: Person;
}

const as = async (email: string): Promise<Auth> => ({ auth: await token(email) });

const send = async (
  org: { readonly slug: string },
  path: string,
  who: Auth,
  method = "GET",
  body?: Payload,
): Promise<{ status: number; body: unknown }> =>
  await harness.json(`/v9/management/orgs/${org.slug}${path}`, {
    ...(body === undefined ? { method } : jsonInit(method, body)),
    ...who,
  });

/** An org with an org admin and two plain members; `privateCredentials` is the setting chosen at creation. */
const newOrg = async (privateCredentials = true): Promise<Org> => {
  const slug = `priv-${crypto.randomUUID().slice(0, 8)}`;
  const platform = { auth: await token(ADMIN) };

  const created = await harness.json(
    "/v9/management/orgs",
    jsonInit("POST", { slug, name: slug, private_credentials: privateCredentials }),
  );

  expect(created.status).toBe(201);

  const person = async (name: string, role: string): Promise<Person> => {
    const email = `${name}-${slug}@example.com`;
    const added = await send({ slug }, "/members", platform, "POST", { email, role });

    expect(added.status).toBe(201);

    return { ...(added.body as { id: string }), email, ...(await as(email)) };
  };

  return {
    slug,
    id: (created.body as { id: string }).id,
    platform,
    admin: await person("admin", "admin"),
    alice: await person("alice", "member"),
    bob: await person("bob", "member"),
  };
};

interface Entry {
  readonly name: string;
  readonly private?: boolean;
  readonly limited?: boolean;
  readonly disabled?: boolean;
  readonly owner?: { readonly member_id: string; readonly email?: string };
  readonly [key: string]: unknown;
}

const files = async (org: Org, who: Auth): Promise<ReadonlyArray<Entry>> => {
  const reply = await send(org, "/credentials", who);

  expect(reply.status).toBe(200);

  const { files, others } = reply.body as {
    files: ReadonlyArray<Entry>;
    others?: ReadonlyArray<Entry>;
  };

  return [...files, ...(others ?? [])];
};

/** The existence-only rows of other members' private accounts that an org admin is given apart. */
const others = async (org: Org, who: Auth): Promise<ReadonlyArray<Entry>> =>
  ((await send(org, "/credentials", who)).body as { others?: ReadonlyArray<Entry> }).others ?? [];

const upload = async (org: Org, who: Auth, name: string, query = "") =>
  await send(org, `/credentials?name=${name}${query}`, who, "POST", claudeFile());

const errorOf = (reply: { body: unknown }) => (reply.body as { error?: string }).error;

const controlPlane = (org: Org) => env.CONTROL_PLANE.getByName(OrgId.make(org.id));

const CLAUDE = { providers: ["claude"], model: "claude-sonnet-4-5" };

describe("a member's private account", () => {
  it("is listed in full to its owner, to nobody else, and as existence only to an org admin", async () => {
    const org = await newOrg();

    expect((await upload(org, org.alice, "alice.json")).status).toBe(200);
    expect((await upload(org, org.admin, "shared.json")).status).toBe(200);

    const mine = await files(org, org.alice);

    expect(mine.map((file) => file.name)).toEqual(["alice.json"]);
    expect(mine[0]).toMatchObject({
      private: true,
      owner: { member_id: org.alice.id, email: org.alice.email },
    });
    expect(mine[0]).toHaveProperty("status");

    // Bob (a plain member) sees nothing of it, and shared credentials are for org admins.
    expect(await files(org, org.bob)).toEqual([]);

    const seen = await files(org, org.admin);

    expect(seen.map((file) => file.name).toSorted()).toEqual(["alice.json", "shared.json"]);

    const limited = seen.find((file) => file.name === "alice.json");

    // Provider, owner and label (and whether it is disabled): nothing of its use, models, quota or standing.
    expect(Object.keys(limited ?? {}).toSorted()).toEqual(
      [
        "auth_index",
        "disabled",
        "id",
        "label",
        "limited",
        "name",
        "owner",
        "private",
        "provider",
        "source",
        "type",
      ].toSorted(),
    );
    expect(limited).toMatchObject({
      limited: true,
      provider: "claude",
      owner: { member_id: org.alice.id, email: org.alice.email },
    });
    expect(JSON.stringify(seen)).not.toContain("sk-ant-oat-secret");

    // Shared credentials stay entries in full; the private ones of others are listed apart.
    expect(seen.find((file) => file.name === "shared.json")?.limited).toBeUndefined();
    expect((await others(org, org.admin)).map((file) => file.name)).toEqual(["alice.json"]);
    expect(await others(org, org.alice)).toEqual([]);
  });

  it("is downloadable by its owner and by no org admin", async () => {
    const org = await newOrg();

    await upload(org, org.alice, "alice.json");

    const own = await send(org, "/credentials/download?name=alice.json", org.alice);

    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ access_token: "sk-ant-oat-secret-access" });

    for (const who of [org.admin, org.platform]) {
      const refused = await send(org, "/credentials/download?name=alice.json", who);

      expect(refused.status).toBe(403);
      expect(errorOf(refused)).toBe("private_credential");
    }

    // Another member is refused like for any credential they may not download.
    const other = await send(org, "/credentials/download?name=alice.json", org.bob);

    expect(errorOf(other)).toBe("download_requires_service_token");
  });

  it("can be disabled and removed by an org admin, never touched by another member", async () => {
    const org = await newOrg();

    await upload(org, org.alice, "alice.json");

    expect(
      (
        await send(org, "/credentials/status", org.bob, "PATCH", {
          name: "alice.json",
          disabled: true,
        })
      ).status,
    ).toBe(404);
    expect((await send(org, "/credentials?name=alice.json", org.bob, "DELETE")).status).toBe(404);
    expect((await files(org, org.alice))[0]?.disabled).toBe(false);

    const disabled = await send(org, "/credentials/status", org.admin, "PATCH", {
      name: "alice.json",
      disabled: true,
    });

    expect(disabled.status).toBe(200);
    expect((await files(org, org.alice))[0]?.disabled).toBe(true);

    expect((await send(org, "/credentials?name=alice.json", org.admin, "DELETE")).status).toBe(200);
    expect(await files(org, org.alice)).toEqual([]);
  });

  it("hides the details an org admin may not see: models and field edits", async () => {
    const org = await newOrg();

    await upload(org, org.alice, "alice.json");

    expect((await send(org, "/credentials/models?name=alice.json", org.admin)).body).toEqual({
      models: [],
    });

    const edit = await send(org, "/credentials/fields", org.admin, "PATCH", {
      name: "alice.json",
      priority: 5,
    });

    expect(edit.status).toBe(404);
  });

  it("is refused to a plain member where the org does not allow private credentials", async () => {
    const org = await newOrg(false);

    expect((await upload(org, org.alice, "alice.json")).status).toBe(403);
    expect(await files(org, org.alice)).toEqual([]);

    // An org admin still connects shared ones.
    expect((await upload(org, org.admin, "shared.json")).status).toBe(200);
  });

  it("is switched off, not deleted, when the org turns the setting off, and back on again", async () => {
    const org = await newOrg();

    await upload(org, org.alice, "alice.json");
    await upload(org, org.admin, "shared.json");

    const off = await send(org, "/membership", org.admin, "PATCH", { private_credentials: false });

    expect(off).toMatchObject({ status: 200, body: { private_credentials: false } });
    expect((await files(org, org.alice)).map((file) => [file.name, file.disabled])).toEqual([
      ["alice.json", true],
    ]);
    expect((await files(org, org.admin)).find((f) => f.name === "shared.json")?.disabled).toBe(
      false,
    );

    // Alice no longer gets her own (the shared one serves her); with it gone, nothing does.
    const aliceNow = await controlPlane(org)
      .models()
      .pick({ ...CLAUDE, memberId: org.alice.id });

    expect(aliceNow.ok && aliceNow.credential.id).toBe("shared.json");

    const on = await send(org, "/membership", org.admin, "PATCH", { private_credentials: true });

    expect(on).toMatchObject({ status: 200, body: { private_credentials: true } });
    expect((await files(org, org.alice))[0]?.disabled).toBe(false);
  });

  it("serves only its owner: not another member, an org admin or a request without a member", async () => {
    const org = await newOrg();

    await upload(org, org.alice, "alice.json");

    const plane = controlPlane(org);
    const owned = await plane.models().pick({ ...CLAUDE, memberId: org.alice.id });

    expect(owned.ok && owned.credential.id).toBe("alice.json");

    for (const memberId of [org.bob.id, org.admin.id, undefined]) {
      const refused = await plane.models().pick({
        ...CLAUDE,
        ...(memberId === undefined ? {} : { memberId }),
      });

      expect(refused.ok).toBe(false);
    }

    // A shared credential joins the pool: everyone gets it.
    await upload(org, org.admin, "shared.json");

    for (const memberId of [org.bob.id, org.admin.id]) {
      const picked = await plane.models().pick({ ...CLAUDE, memberId });

      expect(picked.ok && picked.credential.id).toBe("shared.json");
    }
  });

  it("cannot take a name another credential holds, and an org admin chooses private with a flag", async () => {
    const org = await newOrg();

    await upload(org, org.admin, "taken.json");
    expect((await upload(org, org.alice, "taken.json")).status).toBe(400);

    await upload(org, org.alice, "mine.json");
    expect((await upload(org, org.bob, "mine.json")).status).toBe(400);

    expect((await upload(org, org.admin, "admin-own.json", "&private=true")).status).toBe(200);

    const entry = (await files(org, org.admin)).find((file) => file.name === "admin-own.json");

    expect(entry).toMatchObject({ private: true, owner: { member_id: org.admin.id } });
    expect(entry?.limited).toBeUndefined();
  });

  it("is chosen at the org's creation, and changed by org admins only", async () => {
    const off = await newOrg(false);
    const on = await newOrg(true);

    expect((await send(off, "/membership", off.admin)).body).toMatchObject({
      private_credentials: false,
    });
    expect((await send(on, "/membership", on.admin)).body).toMatchObject({
      private_credentials: true,
    });

    const refused = await send(on, "/membership", on.alice, "PATCH", {
      private_credentials: false,
    });

    expect(refused.status).toBe(403);
    expect((await send(on, "/me", on.alice)).body).toMatchObject({ private_credentials: true });
  });
});

describe("a member's private provider keys", () => {
  const group = (_name: string, key: string) => ({
    family: "claude" as const,
    revision: 0,
    group: { "base-url": "https://api.example.test/v1", keys: [{ "api-key": key }] },
  });

  const put = async (org: Org, who: Auth, body: Payload) =>
    await send(org, "/provider-keys/groups", who, "PUT", body);

  interface Listed {
    readonly families: Record<string, ReadonlyArray<{ readonly id: string }>>;
    readonly own?: Record<string, ReadonlyArray<{ readonly id: string }>>;
    readonly others?: ReadonlyArray<Record<string, unknown>>;
  }

  const list = async (org: Org, who: Auth): Promise<Listed> => {
    const reply = await send(org, "/provider-keys", who);

    expect(reply.status).toBe(200);

    return reply.body as Listed;
  };

  const SECRET = "sk-alice-secret-key-0001";

  it("belong to the member who added them: in full to them, existence only to an org admin", async () => {
    const org = await newOrg();

    expect((await put(org, org.alice, group("alice-ai", SECRET))).status).toBe(200);

    const alice = await list(org, org.alice);

    expect(alice.families["claude"]).toEqual([]);
    expect(alice.own?.["claude"]).toHaveLength(1);
    expect(JSON.stringify(alice)).not.toContain(SECRET);

    const bob = await list(org, org.bob);

    expect(bob.own?.["claude"]).toEqual([]);
    expect(bob.others).toBeUndefined();

    const admin = await list(org, org.admin);

    expect(admin.own?.["claude"]).toEqual([]);
    expect(admin.others).toHaveLength(1);
    expect(Object.keys(admin.others?.[0] ?? {}).toSorted()).toEqual(
      ["family", "id", "label", "limited", "owner", "private", "provider", "revision"].toSorted(),
    );
    expect(admin.others?.[0]).toMatchObject({
      family: "claude",
      owner: { member_id: org.alice.id, email: org.alice.email },
    });
    expect(JSON.stringify(admin)).not.toContain("api.example.test");
  });

  it("serve only their owner", async () => {
    const org = await newOrg();

    await put(org, org.alice, group("alice-ai", SECRET));

    const plane = controlPlane(org);
    const request = { providers: ["claude"], model: "claude-sonnet-4-5" };

    const owned = await plane.models().pick({ ...request, memberId: org.alice.id });

    expect(owned.ok && owned.credential.id).toMatch(/^claude:apikey:/);

    for (const memberId of [org.bob.id, org.admin.id, undefined]) {
      const refused = await plane.models().pick({
        ...request,
        ...(memberId === undefined ? {} : { memberId }),
      });

      expect(refused.ok).toBe(false);
    }
  });

  it("can be disabled and enabled by an org admin, who then cannot use them either", async () => {
    const org = await newOrg();

    await put(org, org.alice, group("alice-ai", SECRET));

    const plane = controlPlane(org);
    const request = { providers: ["claude"], model: "claude-sonnet-4-5", memberId: org.alice.id };
    const picked = await plane.models().pick(request);
    const id = picked.ok ? picked.credential.id : "";
    const adminViewer = { member: org.admin.id, admin: true };
    const authIndex = orgAuthIndexer(env, OrgId.make(org.id))(id);

    expect(id).toMatch(/^claude:apikey:/);
    expect(
      await plane.models().setCredentialDisabledByRef({ authIndex }, true, "admin", adminViewer),
    ).toEqual({ ok: true, via: "config:excluded-models" });
    expect((await plane.models().pick(request)).ok).toBe(false);

    // Another member's viewer cannot reach it at all.
    expect(
      await plane.models().setCredentialDisabledByRef({ authIndex }, false, "bob", {
        member: org.bob.id,
        admin: false,
      }),
    ).toEqual({ ok: false, error: "not_found" });

    expect(
      await plane.models().setCredentialDisabledByRef({ authIndex }, false, "admin", adminViewer),
    ).toEqual({ ok: true, via: "config:excluded-models" });
    expect((await plane.models().pick(request)).ok).toBe(true);
  });

  it("are edited by their owner at their revision, and by nobody else", async () => {
    const org = await newOrg();
    const added = await put(org, org.alice, group("alice-ai", SECRET));
    const { id, revision } = added.body as { id: string; revision: number };

    const edit = {
      family: "claude" as const,
      id,
      revision,
      group: {
        "base-url": "https://api.example.test/v2",
        keys: [{ "api-key": "sk-alice-secret-key-0002" }],
      },
    };

    // Another member's group answers like a deleted one: nothing tells it exists.
    expect((await put(org, org.bob, edit)).status).toBe(409);
    expect((await put(org, org.admin, edit)).status).toBe(409);
    expect((await put(org, org.alice, { ...edit, revision: revision + 1 })).status).toBe(409);
    expect((await put(org, org.alice, edit)).status).toBe(200);
  });

  it("are removed by their owner or an org admin, not by another member", async () => {
    const org = await newOrg();
    const added = await put(org, org.alice, group("alice-ai", SECRET));
    const { id, revision } = added.body as { id: string; revision: number };
    const removal = { family: "claude", id, revision, private: true };

    expect((await send(org, "/provider-keys/groups", org.bob, "DELETE", removal)).status).toBe(409);
    expect((await send(org, "/provider-keys/groups", org.admin, "DELETE", removal)).status).toBe(
      200,
    );
    expect((await list(org, org.alice)).own?.["claude"]).toEqual([]);

    const again = await put(org, org.alice, group("alice-ai", "sk-alice-secret-key-0003"));
    const second = again.body as { id: string; revision: number };

    expect(
      (
        await send(org, "/provider-keys/groups", org.alice, "DELETE", {
          family: "claude",
          id: second.id,
          revision: second.revision,
        })
      ).status,
    ).toBe(200);
  });

  it("are refused where the org does not allow private credentials, and switched off when it stops", async () => {
    const off = await newOrg(false);
    const refused = await put(off, off.alice, group("alice-ai", SECRET));

    expect(refused.status).toBe(403);
    expect(errorOf(refused)).toBe("private_credentials_unavailable");

    const on = await newOrg();

    await put(on, on.alice, group("alice-ai", SECRET));
    expect(
      (
        await controlPlane(on)
          .models()
          .pick({
            providers: ["claude"],
            model: "claude-sonnet-4-5",
            memberId: on.alice.id,
          })
      ).ok,
    ).toBe(true);
    await send(on, "/membership", on.admin, "PATCH", { private_credentials: false });

    const request = { providers: ["claude"], model: "claude-sonnet-4-5", memberId: on.alice.id };

    expect((await controlPlane(on).models().pick(request)).ok).toBe(false);

    await send(on, "/membership", on.admin, "PATCH", { private_credentials: true });
    const back = await controlPlane(on).models().pick(request);

    expect(back.ok, JSON.stringify(back)).toBe(true);
  });

  it("stay out of the org's config document and shared groups", async () => {
    const org = await newOrg();

    await put(org, org.alice, group("alice-ai", SECRET));

    const snapshot = await controlPlane(org).models().getConfig();
    const entries = await controlPlane(org).models().configEntries();

    for (const text of [JSON.stringify(snapshot), JSON.stringify(entries)]) {
      expect(text).not.toContain("api.example.test");
      expect(text).not.toContain(SECRET);
    }

    expect((await list(org, org.admin)).families["claude"]).toEqual([]);
  });
});

describe("usage of a private credential", () => {
  const USAGE = "/observability/usage";

  const requestIds = (reply: { body: unknown }) =>
    (reply.body as { records: ReadonlyArray<{ request_id: string }> }).records
      .map((record) => record.request_id)
      .toSorted();

  it("is read by its owner alone: org-wide summaries, listings, series and the queue leave it out", async () => {
    const org = await newOrg();

    for (const [requestId, who, isPrivate] of [
      ["alice-private", org.alice, true],
      ["alice-shared", org.alice, false],
      ["bob-shared", org.bob, false],
    ] as const)
      await insertUsageRecord(
        env.USAGE,
        sampleRecord({
          requestId,
          orgId: OrgId.make(org.id),
          principalId: "user:" + who.email,
          memberId: who.id,
          ...(isPrivate ? { private: true } : {}),
        }),
      );

    // The owner reads theirs, flagged as private; nobody else does, an org admin included.
    const mine = await send(org, USAGE + "/records", org.alice);

    expect(requestIds(mine)).toEqual(["alice-private", "alice-shared"]);

    expect(
      (mine.body as { records: ReadonlyArray<{ request_id: string; private?: boolean }> }).records
        .filter((record) => record.private === true)
        .map((record) => record.request_id),
    ).toEqual(["alice-private"]);

    expect(requestIds(await send(org, USAGE + "/records", org.bob))).toEqual(["bob-shared"]);
    expect(requestIds(await send(org, USAGE + "/records", org.admin))).toEqual([
      "alice-shared",
      "bob-shared",
    ]);

    // Filtering by the owner does not reveal it either.
    expect(
      requestIds(await send(org, USAGE + "/records?member=" + org.alice.id, org.admin)),
    ).toEqual(["alice-shared"]);

    const total = async (who: Auth) =>
      (
        (await send(org, USAGE + "/summary?group_by=member", who)).body as {
          totals: { requests: number };
        }
      ).totals.requests;

    expect(await total(org.admin)).toBe(2);
    expect(await total(org.alice)).toBe(2);
    expect(await total(org.bob)).toBe(1);

    const seriesRequests = async (who: Auth) =>
      (
        (
          await send(
            org,
            USAGE + "/series?since=1699999000000&until=1700001000000&bucket=day&group_by=model",
            who,
          )
        ).body as {
          series: ReadonlyArray<{ points: ReadonlyArray<{ requests: number }> }>;
        }
      ).series.reduce(
        (sum, group) => sum + group.points.reduce((n, point) => n + point.requests, 0),
        0,
      );

    expect(await seriesRequests(org.admin)).toBe(2);
    expect(await seriesRequests(org.alice)).toBe(2);

    const queued = await send(org, USAGE + "/queue?count=100", org.platform);

    expect(
      (queued.body as ReadonlyArray<{ request_id: string }>).map((record) => record.request_id),
    ).not.toContain("alice-private");
  });
});
