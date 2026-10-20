// The org's membership settings for private toolkits (#198, ADR 0038), apart from the one for private credentials but
// with its defaults: on for `global`, off for a new org, and, for an org from before the setting, what private
// credentials were (so the private toolkits it served stay served). Reached through the ControlPlane's storage and a
// restart (`evictDurableObject`).
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
