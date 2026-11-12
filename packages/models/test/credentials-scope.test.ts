// Every ControlPlane method that filters by ownership takes who it runs for (ADR 0023): a viewer, or `FULL_ACCESS` for
// the system. Leaving it out is a type error (the `@ts-expect-error` lines below stop compiling if a method gets its
// default back), and a member's viewer never reaches what the org or another member owns.
import { describe, expect, it } from "vite-plus/test";
import type { Viewer } from "@commissary/auth";
import { GLOBAL_ORG, OrgId } from "@commissary/core";
import { claudeFile, controlPlane } from "./support/control-plane.ts";
import { FULL_ACCESS } from "../src/credentials/ownership.ts";

const alice: Viewer = { member: "mem-alice", admin: false };

const bob: Viewer = { member: "mem-bob", admin: false };

const admin: Viewer = { member: "mem-admin", admin: true };

/** Never called: it only has to compile, and each line must fail to without its viewer. */
export const requiresAViewer = async () => {
  const stub = controlPlane(GLOBAL_ORG);
  const ref = { name: "a.json" };

  // @ts-expect-error a viewer is required
  await stub.listCredentials();
  // @ts-expect-error a viewer is required
  await stub.listModelSources();
  // @ts-expect-error a viewer is required
  await stub.providerKeysView();
  // @ts-expect-error a viewer is required
  await stub.listCredentialEntries();
  // @ts-expect-error a viewer is required
  await stub.removeCredential("a.json");
  // @ts-expect-error a viewer is required
  await stub.removeCredentials(["a.json"]);
  // @ts-expect-error a viewer is required
  await stub.setCredentialDisabled("a.json", true);
  // @ts-expect-error a viewer is required
  await stub.setCredentialDisabledByRef(ref, true, "by");
  // @ts-expect-error a viewer is required
  await stub.getCredentialFile("a.json");
  // @ts-expect-error a viewer is required
  await stub.patchCredentialFields(ref, {});
  // @ts-expect-error a viewer is required
  await stub.isConfigKey("a.json");
  // @ts-expect-error a viewer is required
  await stub.credentialIdOfAuthIndex("0123456789abcdef");
  // @ts-expect-error a viewer is required
  await stub.providerKeyProbeTarget("0123456789abcdef");
  // @ts-expect-error a viewer is required
  await stub.resetCredentialCooldown(ref);
  // @ts-expect-error a viewer is required
  await stub.refreshCredential(ref);
  // @ts-expect-error a viewer is required
  await stub.refreshAllCredentials();
  // @ts-expect-error a viewer is required
  await stub.batchCredentials("enable", ["a.json"]);
  // @ts-expect-error a viewer is required
  await stub.quotaProbeTarget(ref, {});
  // @ts-expect-error a viewer is required
  await stub.resetGrantTarget(ref);
  // @ts-expect-error a viewer is required
  await stub.quotaCheckTargets();
  // @ts-expect-error a viewer is required
  await stub.importAuthFile("a.json", "{}", {});
  // @ts-expect-error a viewer is required
  await stub.oauthStatus("state");
  // @ts-expect-error a viewer is required
  await stub.oauthCancel("state");
};

describe("a viewer's reach", () => {
  it("is limited to what it owns, what an org admin may see, or nothing", async () => {
    const org = OrgId.make(`scope-${crypto.randomUUID().slice(0, 8)}`);
    const stub = controlPlane(org);

    await stub.setMembershipSettings({ privateCredentials: true });
    await stub.models().importAuthFile("shared.json", JSON.stringify(claudeFile()), {}, admin);

    await stub
      .models()
      .importAuthFile(
        "alice.json",
        JSON.stringify(claudeFile({ email: "alice@x.com" })),
        {},
        alice,
      );

    const names = async (viewer: Viewer | typeof FULL_ACCESS) =>
      (await stub.models().listCredentials(viewer)).map((entry) => entry.id).toSorted();

    expect(await names(FULL_ACCESS)).toEqual(["alice.json", "shared.json"]);
    expect(await names(alice)).toEqual(["alice.json"]);
    expect(await names(bob)).toEqual([]);
    expect(await names(admin)).toEqual(["alice.json", "shared.json"]);

    // Another member removes or disables nothing of hers.
    expect(await stub.models().removeCredential("alice.json", bob)).toEqual({ removed: false });
    expect(await stub.models().setCredentialDisabled("alice.json", true, bob)).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(await stub.models().removeCredentials(["alice.json"], bob)).toEqual([]);

    // Nor does a plain member reach the org's shared credential.
    expect(await stub.models().removeCredential("shared.json", alice)).toEqual({ removed: false });

    // Model sources carry the owner: the registry reads them all as the system and narrows them itself.
    const sources = async (viewer: Viewer | typeof FULL_ACCESS) =>
      (await stub.models().listModelSources(viewer)).map((source) => source.id).toSorted();

    expect(await sources(FULL_ACCESS)).toEqual(["alice.json", "shared.json"]);
    expect(await sources(bob)).toEqual([]);
    expect(await sources(alice)).toEqual(["alice.json"]);

    expect(await stub.models().removeCredential("alice.json", alice)).toEqual({ removed: true });
  });
});
