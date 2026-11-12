// The default grant (ADR 0023): a ControlPlane writes "everyone, every shared credential, every model" the first time
// it is constructed, once, and does not make it again after an org admin removed it.
import { describe, expect, it } from "vite-plus/test";
import { OrgId } from "@commissary/core";
import { claudeFile, controlPlane } from "./support/control-plane.ts";
import { DEFAULT_GRANT } from "../src/grants/grant.ts";
import { FULL_ACCESS } from "../src/credentials/ownership.ts";
import { restart } from "./support/secrets.ts";
import { withModelsPart } from "./support/models-part.ts";

const freshOrg = () => OrgId.make(`grants-${crypto.randomUUID().slice(0, 8)}`);

type Stub = ReturnType<typeof controlPlane>;

/** A new org with one shared account. */
const newOrg = async (): Promise<Stub> => {
  const stub = controlPlane(freshOrg());

  await withModelsPart(stub, (part) =>
    part.importAuthFile("new-a.json", claudeFile(), {}, FULL_ACCESS),
  );

  return stub;
};

const picks = async (stub: Stub, member: string | undefined, model = "claude-opus-4-1") =>
  (
    await stub.models().pick({
      providers: ["claude"],
      model,
      ...(member === undefined ? {} : { memberId: member }),
    })
  ).ok;

describe("a new org", () => {
  it("starts with the default grant, so its members reach what its admins add", async () => {
    const stub = await newOrg();

    const { grants } = await stub.models().grantEntries();

    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject(DEFAULT_GRANT);
    expect(await picks(stub, "member-1")).toBe(true);
    expect(await picks(stub, "member-2", "claude-sonnet-4-5")).toBe(true);
    expect(await picks(stub, undefined)).toBe(true);
  });

  it("is seeded once: restarting changes neither the grant nor its revision", async () => {
    const stub = await newOrg();

    const first = await withModelsPart(stub, (part) => part.grantEntries());

    for (let restarts = 0; restarts < 2; restarts += 1) {
      await restart(stub);

      expect(await withModelsPart(stub, (part) => part.grantEntries())).toEqual(first);
    }
  });

  it("does not bring back a default grant an org admin removed", async () => {
    const stub = await newOrg();

    const [initial] = (await withModelsPart(stub, (part) => part.grantEntries())).grants;

    expect(initial).toBeDefined();

    const removed = await withModelsPart(stub, (part) =>
      part.writeGrant(
        { id: initial?.id ?? "", revision: initial?.revision ?? 0, value: null },
        "admin-1",
      ),
    );

    expect(removed.ok).toBe(true);

    await restart(stub);

    expect((await stub.models().grantEntries()).grants).toEqual([]);
    expect(await picks(stub, "member-1")).toBe(false);
  });
});
