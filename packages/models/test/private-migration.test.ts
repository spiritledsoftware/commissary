// The upgrade to shared and private credentials (ADR 0023): each test starts from the storage a ControlPlane had before
// ownership (no `owner` columns, no `private_credentials` column, no private key tables), restarts it so its constructor
// migrates, and checks that everything that existed is shared and still works. A second restart changes nothing.
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { GLOBAL_ORG, OrgId } from "@commissary/core";
import { controlPlane } from "./support/control-plane.ts";
import { storedText } from "@commissary/state/testing";
import { CredentialStore } from "../src/credentials/store.ts";
import { FULL_ACCESS } from "../src/credentials/ownership.ts";
import { orgDataKey, restart } from "./support/secrets.ts";
import { SqliteSessionTable } from "../src/oauth/session-store.ts";
import { withModelsPart } from "./support/models-part.ts";

const freshOrg = () => OrgId.make(`pre-${crypto.randomUUID().slice(0, 8)}`);

const columns = (state: DurableObjectState, table: string) =>
  state.storage.sql
    .exec<{ name: string }>(`PRAGMA table_info(${table})`)
    .toArray()
    .map((column) => column.name);

describe("accounts stored before ownership", () => {
  it("are shared after the upgrade, still listed and usable, and the upgrade is idempotent", async () => {
    const org = freshOrg();
    const stub = controlPlane(org);

    // Store two accounts, then take the storage back to before the owner column existed.
    await runInDurableObject(stub, async (instance, state) => {
      await instance.started;
      const store = new CredentialStore(state.storage.sql, await orgDataKey(state, org));

      for (const name of ["old-a.json", "old-b.json"])
        store.upsert(
          name,
          "claude",
          { type: "claude", email: `${name}@example.com`, access_token: "tok", disabled: false },
          { mergeExisting: false },
        );

      state.storage.sql.exec("ALTER TABLE credentials DROP COLUMN owner");
      expect(columns(state, "credentials")).not.toContain("owner");
    });

    const checkShared = async () => {
      await restart(stub);

      const listed = await withModelsPart(stub, (part) => part.listCredentials(FULL_ACCESS));

      expect(listed.map((entry) => entry.id).toSorted()).toEqual(["old-a.json", "old-b.json"]);

      await runInDurableObject(stub, (_instance, state) => {
        expect(columns(state, "credentials")).toContain("owner");
        expect(
          state.storage.sql
            .exec<{ owner: string | null }>("SELECT owner FROM credentials")
            .toArray()
            .map((row) => row.owner),
        ).toEqual([null, null]);
      });

      // Shared means: an org admin manages it in full, a plain member does not see it.
      expect(
        await withModelsPart(stub, (part) =>
          part.credentialAccess("old-a.json", { member: "m-1", admin: true }),
        ),
      ).toEqual({
        access: "full",
        private: false,
      });
      expect(
        await withModelsPart(stub, (part) =>
          part.credentialAccess("old-a.json", { member: "m-2", admin: false }),
        ),
      ).toEqual({
        access: "none",
        private: false,
      });
    };

    await checkShared();
    await checkShared();
  });
});

describe("OAuth logins stored before ownership", () => {
  it("finish as shared credentials", async () => {
    const stub = controlPlane(freshOrg());

    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("DROP TABLE oauth_sessions");
      sql.exec(
        `CREATE TABLE oauth_sessions (
           state TEXT PRIMARY KEY, provider TEXT NOT NULL, flow TEXT NOT NULL, status TEXT NOT NULL,
           completed INTEGER NOT NULL, expires_at INTEGER NOT NULL, deadline_at INTEGER NOT NULL,
           next_poll_at INTEGER NOT NULL, interval_ms INTEGER NOT NULL, busy_until INTEGER NOT NULL,
           data TEXT NOT NULL
         )`,
      );
      sql.exec(
        `INSERT INTO oauth_sessions VALUES ('s-1', 'claude', 'callback', 'wait', 0, 9e15, 9e15, 0, 0, 0, '{}')`,
      );

      new SqliteSessionTable(sql);

      const table = new SqliteSessionTable(sql);

      expect(columns(state, "oauth_sessions")).toContain("owner");
      expect(table.get("s-1")).toMatchObject({ state: "s-1", provider: "claude" });
      expect(table.get("s-1")?.owner).toBeUndefined();
    });
  });
});

describe("the org setting for private credentials", () => {
  const before = async (org: OrgId) => {
    // The membership row as it was before the setting: no column (nor the later private toolkits one).
    const stub = controlPlane(org);

    await runInDurableObject(stub, async (instance, state) => {
      await instance.started;
      state.storage.sql.exec("ALTER TABLE membership DROP COLUMN private_credentials");
      state.storage.sql.exec("ALTER TABLE membership DROP COLUMN private_toolkits");
    });

    await restart(stub);

    return stub;
  };

  it("is on for global, whose members keep what they could do", async () => {
    const stub = await before(GLOBAL_ORG);

    expect(await stub.membershipSettings()).toEqual({
      autoJoin: true,
      privateCredentials: true,
      privateToolkits: true,
      accessClients: true,
    });

    await restart(stub);

    expect(await stub.membershipSettings()).toEqual({
      autoJoin: true,
      privateCredentials: true,
      privateToolkits: true,
      accessClients: true,
    });
  });

  it("is off for every other org until an org admin turns it on", async () => {
    const stub = await before(freshOrg());

    expect(await stub.membershipSettings()).toEqual({
      autoJoin: false,
      privateCredentials: false,
      privateToolkits: false,
      accessClients: false,
    });

    await restart(stub);

    expect(await stub.membershipSettings()).toEqual({
      autoJoin: false,
      privateCredentials: false,
      privateToolkits: false,
      accessClients: false,
    });
  });
});

describe("private provider keys", () => {
  it("start from no private key tables, and keep a key sealed in storage", async () => {
    const org = freshOrg();
    const stub = controlPlane(org);

    await runInDurableObject(stub, async (instance, state) => {
      await instance.started;
      state.storage.sql.exec("DROP TABLE private_key_groups");
      state.storage.sql.exec("DROP TABLE private_key_changes");
    });

    await restart(stub);

    await stub.setMembershipSettings({ privateCredentials: true });

    const written = await withModelsPart(stub, (part) =>
      part.writePrivateKeyGroup(
        {
          family: "claude",
          revision: 0,
          group: {
            "base-url": "https://api.example.test/v1",
            keys: [{ "api-key": "sk-ant-secret-private-key" }],
          },
        },
        "member-1",
        { member: "member-1", admin: false },
      ),
    );

    expect(written.ok).toBe(true);

    await restart(stub);

    const text = await storedText(stub);

    expect(text).toContain("private_key_groups");
    expect(text).not.toContain("sk-ant-secret-private-key");
  });
});
