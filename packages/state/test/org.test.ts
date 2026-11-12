// The ControlPlane stubs of an org (ADR 0021, `org.ts`): an org's ControlPlane is named by the org id, and an object
// with any other name has no org, so it never serves `global`'s state by default.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { orgOfControlPlane } from "../src/index.ts";

describe("orgOfControlPlane", () => {
  it("a ControlPlane not named by an org id has no org (its constructor throws)", () => {
    expect(() => orgOfControlPlane(env.CONTROL_PLANE.newUniqueId())).toThrow(
      /not named by an org id/,
    );
    expect(() => orgOfControlPlane(env.CONTROL_PLANE.idFromName("Not_An_Org"))).toThrow();
    expect(orgOfControlPlane(env.CONTROL_PLANE.idFromName("acme"))).toBe("acme");
  });
});
