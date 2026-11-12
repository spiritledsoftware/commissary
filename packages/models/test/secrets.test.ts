// Stored secrets sealed with a data key per org (`@commissary/state`'s `secrets/`; the sealed value format and the
// stage's secrets keys are tested there) in the real ControlPlane Durable Object with its Models part, started from
// each state it can find in production (new, before encryption, after a rotation, under another key) by restarting it
// (`evictDurableObject`).
import { FULL_ACCESS } from "../src/credentials/ownership.ts";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { ControlPlane } from "./worker.ts";
import type { PickResult } from "../src/credentials/selection/types.ts";
import { OrgId } from "@commissary/core";
import { deploymentSecretsKeys, DEV_SECRETS_KEY, isSealed, openDataKey } from "@commissary/state";
import { storedText } from "@commissary/state/testing";
import { orgAuthIndexer } from "../src/management/auth-index.ts";
import { controlPlane } from "./support/control-plane.ts";
import {
  UNRELATED_SECRETS_KEY,
  asBeforeEncryption,
  restart,
  wrapDataKeyUnder,
  wrappedDataKey,
} from "./support/secrets.ts";
import { withModelsPart } from "./support/models-part.ts";

const newOrg = (): OrgId => OrgId.make(`secrets-${crypto.randomUUID().slice(0, 8)}`);

// Secrets an org stores: an auth file's tokens, and provider keys and a secret header in its config entries.
const ACCESS_TOKEN = "sk-ant-oat-plain-access-4f1d";

const REFRESH_TOKEN = "plain-refresh-token-9c2e";

const API_KEY = "sk-ant-api-plain-key-77ab";

const COMPAT_KEY = "sk-compat-plain-key-31cd";

const HEADER_SECRET = "Bearer plain-header-secret-58ef";

const SECRETS = [ACCESS_TOKEN, REFRESH_TOKEN, API_KEY, COMPAT_KEY, HEADER_SECRET];

const AUTH_FILE = {
  type: "claude",
  email: "me@x.com",
  access_token: ACCESS_TOKEN,
  refresh_token: REFRESH_TOKEN,
  expired: "2999-01-01T00:00:00Z",
};

const CONFIG = `
routing:
  strategy: fill-first
api-keys:
  claude:
    - base-url: https://api.anthropic.com
      headers:
        X-Upstream-Auth: "${HEADER_SECRET}"
      keys:
        - api-key: ${API_KEY}
  openai-compatibility:
    - name: acme
      base-url: https://api.acme.test/v1
      keys:
        - api-key: ${COMPAT_KEY}
`;

/** A ControlPlane of a new org holding an auth file and provider keys. */
const orgWithSecrets = async () => {
  const org = newOrg();
  const stub = controlPlane(org);

  await withModelsPart(stub, async (part) => {
    expect(await part.importAuthFile("claude-a.json", AUTH_FILE, {}, FULL_ACCESS)).toMatchObject({
      ok: true,
    });
    expect(await part.importConfig(CONFIG, "test")).toMatchObject({ ok: true });
  });

  return { org, stub };
};

/** What the org's secrets read as through the ControlPlane, with the auth index of every credential. */
const readThroughControlPlane = async (stub: ReturnType<typeof controlPlane>, org: OrgId) => {
  const index = orgAuthIndexer(env, org);

  return await withModelsPart(stub, async (part) => {
    const credentials = (await part.listCredentials(FULL_ACCESS)).map(({ id }) => ({
      id,
      index: index(id),
    }));

    const picked: PickResult = await part.pick({
      providers: ["claude"],
      model: "claude-sonnet-4-5",
    });

    return {
      credentials: credentials.toSorted((a, b) => a.id.localeCompare(b.id)),
      file: await part.getCredentialFile("claude-a.json", FULL_ACCESS),
      document: (await part.getConfig()).document,
      token: picked.ok ? picked.credential.metadata.access_token : picked.failure.code,
    };
  });
};

/**
 * Runs `body` against the ControlPlane instance once it started. Failing calls are checked here rather than over RPC:
 * the Workers test pool reports an exception thrown out of a Durable Object RPC method as an unhandled error.
 */
const inStartedControlPlane = (
  stub: ReturnType<typeof controlPlane>,
  body: (plane: ControlPlane) => Promise<void>,
) =>
  runInDurableObject(stub, async (plane) => {
    await plane.started;
    await body(plane);
  });

/** The outcome of a call, sync or async, as a promise. */
const outcomeOf = async <A>(call: () => A | Promise<A>): Promise<A> => call();

const expectNoPlaintext = (stored: string) => {
  for (const secret of SECRETS) expect(stored).not.toContain(secret);
};

describe("ControlPlane stored secrets", () => {
  it("stores no secret in plain text and reads every one back", async () => {
    const { org, stub } = await orgWithSecrets();
    const stored = await storedText(stub);

    expectNoPlaintext(stored);
    expect(await wrappedDataKey(stub)).toMatch(/^wk:v1:/);

    const read = await readThroughControlPlane(stub, org);
    expect(read.file).toEqual(AUTH_FILE);
    expect(read.token).toBe(ACCESS_TOKEN);

    for (const secret of [API_KEY, COMPAT_KEY, HEADER_SECRET])
      expect(read.document).toContain(secret);

    // After a restart the same rows open with the same data key.
    await restart(stub);
    expect(await readThroughControlPlane(stub, org)).toEqual(read);
    expect(await storedText(stub)).toBe(stored);
  });

  it("gives every org its own data key", async () => {
    const a = await orgWithSecrets();
    const b = await orgWithSecrets();

    // Org a's sealed auth file, stored under the same name in org b, does not open there.
    const sealed = await runInDurableObject(
      a.stub,
      (_instance, state) =>
        state.storage.sql
          .exec<{ metadata: string }>("SELECT metadata FROM credentials WHERE id = 'claude-a.json'")
          .one().metadata,
    );

    await runInDurableObject(b.stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE credentials SET metadata = ? WHERE id = 'claude-a.json'",
        sealed,
      );
    });
    await restart(b.stub);

    await inStartedControlPlane(b.stub, async (plane) => {
      await expect(
        outcomeOf(() => plane.models().getCredentialFile("claude-a.json", FULL_ACCESS)),
      ).rejects.toThrow(
        /credentials\/claude-a\.json: the sealed value does not open with the org's data key/,
      );
    });
    expect(await a.stub.models().getCredentialFile("claude-a.json", FULL_ACCESS)).toEqual(
      AUTH_FILE,
    );
  });

  it("does not start under another SECRETS_KEY, instead of reading garbage", async () => {
    const { org, stub } = await orgWithSecrets();

    await wrapDataKeyUnder(stub, org, UNRELATED_SECRETS_KEY);

    const refusal = new RegExp(
      `neither SECRETS_KEY nor SECRETS_KEY_PREVIOUS opens the data key of org ${org}`,
    );

    await inStartedControlPlane(stub, async (plane) => {
      await expect(outcomeOf(() => plane.models().listCredentials(FULL_ACCESS))).rejects.toThrow(
        refusal,
      );
      await expect(outcomeOf(() => plane.models().getConfig())).rejects.toThrow(refusal);
    });
    // Every later start fails the same way (nothing was rewritten under the wrong key).
    await restart(stub);
    await inStartedControlPlane(stub, async (plane) => {
      await expect(
        outcomeOf(() => plane.models().getCredentialFile("claude-a.json", FULL_ACCESS)),
      ).rejects.toThrow(refusal);
    });
  });

  it("does not start on a deployed stage without its SECRETS_KEY, or with the development key", async () => {
    const { stub } = await orgWithSecrets();

    await runInDurableObject(stub, async (_instance, state) => {
      for (const [SECRETS_KEY, refusal] of [
        ["", /SECRETS_KEY is not set or shorter than 32 characters/],
        [DEV_SECRETS_KEY, /SECRETS_KEY is refused because ACCESS_TEAM_DOMAIN\/ACCESS_AUD are set/],
      ] as const) {
        // A second instance over the same storage, with the bindings of a deployed stage.
        const refused = new ControlPlane(state, {
          ...env,
          ACCESS_TEAM_DOMAIN: "team",
          SECRETS_KEY,
        });

        await refused.started;
        await expect(
          outcomeOf(() => refused.models().listCredentials(FULL_ACCESS)),
        ).rejects.toThrow(refusal);
        await expect(outcomeOf(() => refused.models().getConfig())).rejects.toThrow(refusal);
      }
    });
  });

  it("stores the data key and seals the plain-text secrets in one transaction", async () => {
    const { org, stub } = await orgWithSecrets();

    // The state before encryption (plain-text values, no data key), then a first start whose sealing step fails
    // halfway: nothing of it may stay.
    const after = await runInDurableObject(stub, async (_instance, state) => {
      const { sql } = state.storage;

      sql.exec("UPDATE credentials SET metadata = ?", JSON.stringify(AUTH_FILE));
      sql.exec("DROP TABLE org_data_key");

      const failure = await openDataKey({
        sql,
        transaction: (body) => state.storage.transactionSync(body),
        org,
        keys: () => deploymentSecretsKeys(env),
        sealStored: (cipher) => {
          sql.exec("UPDATE credentials SET metadata = ?", cipher.seal("{}", "credentials/x"));
          throw new Error("sealing failed halfway");
        },
      }).then(
        () => "opened",
        (error: Error) => error.message,
      );

      return {
        failure,
        keys: sql.exec("SELECT COUNT(*) AS n FROM org_data_key").one()["n"],
        metadata: sql.exec<{ metadata: string }>("SELECT metadata FROM credentials").toArray(),
      };
    });

    expect(after.failure).toContain("sealing failed halfway");
    expect(after.keys).toBe(0);

    for (const { metadata } of after.metadata) expect(isSealed(metadata)).toBe(false);
  });

  it("wraps the data key again under SECRETS_KEY when SECRETS_KEY_PREVIOUS opens it, keeping every secret", async () => {
    const { org, stub } = await orgWithSecrets();
    const before = await readThroughControlPlane(stub, org);

    const sealedRows = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec("SELECT id, metadata FROM credentials").toArray(),
    );

    // The stage rotated: its data key was wrapped under what is now SECRETS_KEY_PREVIOUS.
    const wrappedBefore = await wrapDataKeyUnder(stub, org, env.SECRETS_KEY_PREVIOUS ?? "");

    expect(await readThroughControlPlane(stub, org)).toEqual(before);
    expect(await wrappedDataKey(stub)).not.toBe(wrappedBefore);

    // The data is not encrypted again, and the data key now opens under SECRETS_KEY alone.
    expect(
      await runInDurableObject(stub, async (_instance, state) => {
        await openDataKey({
          sql: state.storage.sql,
          transaction: (body) => state.storage.transactionSync(body),
          org,
          keys: () => ({ current: env.SECRETS_KEY }),
          sealStored: () => {
            throw new Error("no new data key expected");
          },
        });

        return state.storage.sql.exec("SELECT id, metadata FROM credentials").toArray();
      }),
    ).toEqual(sealedRows);
  });

  it("seals what a ControlPlane stored before encryption on its first start, keeping auth indexes", async () => {
    const { org, stub } = await orgWithSecrets();
    expect(
      await withModelsPart(stub, (part) =>
        part.importAuthFile("claude-b.json", { ...AUTH_FILE, email: "b@x.com" }, {}, FULL_ACCESS),
      ),
    ).toMatchObject({ ok: true });
    const before = await readThroughControlPlane(stub, org);

    let plain = "";

    await asBeforeEncryption(stub, org, (sql) => {
      // The state the previous code left: plain-text secrets and no data key.
      plain = JSON.stringify([
        sql.exec("SELECT metadata FROM credentials").toArray(),
        sql.exec("SELECT value FROM config_provider_keys").toArray(),
        sql.exec("SELECT value FROM config_key_groups").toArray(),
      ]);
    });

    for (const secret of SECRETS) expect(plain).toContain(secret);
    expect(await wrappedDataKey(stub)).toMatch(/^wk:v1:/);

    const after = await readThroughControlPlane(stub, org);
    expect(after).toEqual(before);
    expect(after.credentials.length).toBeGreaterThanOrEqual(4);
    expectNoPlaintext(await storedText(stub));

    // Idempotent: the next start finds the data key and seals nothing again.
    const stored = await storedText(stub);
    await restart(stub);
    expect(await readThroughControlPlane(stub, org)).toEqual(before);
    expect(await storedText(stub)).toBe(stored);
  });
});
