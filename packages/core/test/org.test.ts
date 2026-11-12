// The pure org model (ADR 0021): org-scoped names keep global's names and name every other org back.
import { describe, expect, it } from "vite-plus/test";
import { GLOBAL_ORG, OrgId, orgOfScopedName, orgScopedName } from "../src/index.ts";

describe("org-scoped names", () => {
  it("keep global's names and give every other org its own, which name the org back", () => {
    const acme = OrgId.make("acme");
    expect(orgScopedName(GLOBAL_ORG, "ag:sc:x")).toBe("ag:sc:x");
    expect(orgScopedName(acme, "ag:sc:x")).toBe("org.acme.ag:sc:x");
    expect(orgOfScopedName("ag:sc:x")).toBe(GLOBAL_ORG);
    expect(orgOfScopedName("org.acme.ag:sc:x")).toBe(acme);
    expect(orgOfScopedName("org.global.x")).toBeUndefined();
    expect(orgOfScopedName("org.Bad_Org.x")).toBeUndefined();
    expect(orgOfScopedName("org.acme")).toBeUndefined();
  });
});
