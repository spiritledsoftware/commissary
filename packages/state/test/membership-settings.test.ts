// The org's membership settings for private toolkits (#198, ADR 0038), apart from the one for private credentials but
// with its defaults: on for `global`, off for a new org, and, for an org from before the setting, what private
// credentials were (so the private toolkits it served stay served); and the one for private agents (#226), which
// follows private toolkits. Reached through the ControlPlane's storage and a restart (`evictDurableObject`).
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { GLOBAL_ORG, OrgId } from "@commissary/core";
import { controlPlaneOf } from "../src/index.ts";

const freshOrg = () => OrgId.make(`settings-${crypto.randomUUID().slice(0, 8)}`);

describe("the private toolkits setting", () => {
  it("starts as private credentials do: on for global, off for a new org", async () => {
    expect(await controlPlaneOf(env, freshOrg()).membershipSettings()).toMatchObject({
      privateCredentials: false,
      privateToolkits: false,
    });
    expect(await controlPlaneOf(env, GLOBAL_ORG).membershipSettings()).toMatchObject({
      privateCredentials: true,
      privateToolkits: true,
    });
  });

  it("takes an org's private credentials setting when the org is from before it, and is apart afterwards", async () => {
    for (const privateCredentials of [true, false]) {
      const stub = controlPlaneOf(env, freshOrg());

      await stub.setMembershipSettings({ privateCredentials });

      // The membership row as it was before the setting: no column.
      await runInDurableObject(stub, async (instance, state) => {
        await instance.started;
        state.storage.sql.exec("ALTER TABLE membership DROP COLUMN private_toolkits");
      });

      await evictDurableObject(stub);

      expect(await stub.membershipSettings()).toMatchObject({
        privateCredentials,
        privateToolkits: privateCredentials,
      });

      await stub.setMembershipSettings({ privateToolkits: !privateCredentials });
      await evictDurableObject(stub);

      expect(await stub.membershipSettings()).toMatchObject({
        privateCredentials,
        privateToolkits: !privateCredentials,
      });
    }
  });
});

// The setting for private agents (#226, ADR 0040): on for `global`, off for a new org unless chosen, and, for an org
// from before the setting, what private toolkits were (private agents follow private toolkits).
describe("the private agents setting", () => {
  it("is on for global and off for a new org", async () => {
    expect(await controlPlaneOf(env, freshOrg()).membershipSettings()).toMatchObject({
      privateAgents: false,
    });
    expect(await controlPlaneOf(env, GLOBAL_ORG).membershipSettings()).toMatchObject({
      privateAgents: true,
    });
  });

  it("takes an org's private toolkits setting when the org is from before it, and is apart afterwards", async () => {
    for (const privateToolkits of [true, false]) {
      const stub = controlPlaneOf(env, freshOrg());

      await stub.setMembershipSettings({ privateCredentials: !privateToolkits, privateToolkits });

      // The membership row as it was before the setting: no column.
      await runInDurableObject(stub, async (instance, state) => {
        await instance.started;
        state.storage.sql.exec("ALTER TABLE membership DROP COLUMN private_agents");
      });

      await evictDurableObject(stub);

      expect(await stub.membershipSettings()).toMatchObject({
        privateCredentials: !privateToolkits,
        privateToolkits,
        privateAgents: privateToolkits,
      });

      await stub.setMembershipSettings({ privateAgents: !privateToolkits });
      await evictDurableObject(stub);

      expect(await stub.membershipSettings()).toMatchObject({
        privateToolkits,
        privateAgents: !privateToolkits,
      });
    }
  });

  it("stays on for global when the org is from before it, whatever its private toolkits", async () => {
    const stub = controlPlaneOf(env, GLOBAL_ORG);
    const before = await stub.membershipSettings();

    try {
      await stub.setMembershipSettings({ privateToolkits: false });

      await runInDurableObject(stub, async (instance, state) => {
        await instance.started;
        state.storage.sql.exec("ALTER TABLE membership DROP COLUMN private_agents");
      });

      await evictDurableObject(stub);

      expect(await stub.membershipSettings()).toMatchObject({
        privateToolkits: false,
        privateAgents: true,
      });
    } finally {
      await stub.setMembershipSettings({
        privateToolkits: before.privateToolkits,
        privateAgents: before.privateAgents,
      });
    }
  });
});
