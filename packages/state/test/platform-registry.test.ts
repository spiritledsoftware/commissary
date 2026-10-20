// The Platform registry (ADR 0021): the deployment's orgs and the index of who belongs to which, in the `Platform`
// Durable Object. Each test uses an object of its own (`getByName`), so none sees another's orgs.
import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { DEFAULT_ORG_SLUG, GLOBAL_ORG, newOrgId } from "@commissary/core";
import { DEFAULT_USAGE_RETENTION_DAYS, PLATFORM_NAME, platformOf } from "../src/index.ts";

const fresh = () => env.PLATFORM.getByName(`registry-${crypto.randomUUID()}`);

const NOW = 1_700_000_000_000;

describe("seed", () => {
  it("lists the org global with the slug default on first start", async () => {
    const platform = fresh();

    expect(await platform.listOrgs()).toEqual([
      {
        id: GLOBAL_ORG,
        slug: DEFAULT_ORG_SLUG,
        name: "Default",
        createdAt: expect.any(Number),
        usageRetentionDays: null,
        // Agent runs' default applies to global too (#228, ADR 0040).
        runRetentionDays: 30,
      },
    ]);
    expect((await platform.getOrgBySlug("default"))?.id).toBe(GLOBAL_ORG);
    expect((await platform.getOrgById("global"))?.slug).toBe("default");
  });

  it("keeps a renamed global when the object restarts", async () => {
    const platform = fresh();
    expect((await platform.updateOrg("default", { slug: "home", name: "Home" })).ok).toBe(true);

    // A restart runs the constructor again over the stored tables.
    await evictDurableObject(platform);
    const listed = await platform.listOrgs();

    expect(listed.map((org) => [org.id, org.slug, org.name])).toEqual([
      [GLOBAL_ORG, "home", "Home"],
    ]);
  });

  it("has a singleton the Worker reaches by name", async () => {
    expect(PLATFORM_NAME).toBe("platform");
    expect((await platformOf(env).listOrgs()).some((org) => org.id === GLOBAL_ORG)).toBe(true);
  });
});

describe("orgs", () => {
  it("creates an org under the id the caller prepared", async () => {
    const platform = fresh();
    const id = newOrgId();
    const created = await platform.createOrg({ slug: "prepared", name: "Prepared", id }, NOW);

    if (!created.ok) throw new Error(created.message);
    expect(created.org.id).toBe(id);
    expect((await platform.getOrgById(id))?.slug).toBe("prepared");
  });

  it("creates an org under a fresh id and refuses a slug in use", async () => {
    const platform = fresh();
    const created = await platform.createOrg({ slug: "acme", name: "  Acme Inc  " }, NOW);

    if (!created.ok) throw new Error(created.message);
    expect(created.org).toMatchObject({ slug: "acme", name: "Acme Inc", createdAt: NOW });
    expect(created.org.id).toMatch(/^org-[0-9a-f]{16}$/);
    expect(created.org.id).not.toBe(GLOBAL_ORG);

    const again = await platform.createOrg({ slug: "acme", name: "Other" }, NOW);
    expect(again).toMatchObject({ ok: false, error: "slug_taken" });
    // The slug of the seeded org is taken too.
    expect(await platform.createOrg({ slug: "default", name: "X" }, NOW)).toMatchObject({
      ok: false,
      error: "slug_taken",
    });

    expect((await platform.listOrgs()).map((org) => org.slug)).toEqual(["default", "acme"]);
    expect((await platform.getOrgBySlug("acme"))?.id).toBe(created.org.id);
  });

  it.each(["", "Acme", "-acme", "acme-", "a_b", "a b", "a/b", "a.b", "x".repeat(64)])(
    "refuses the slug %j",
    async (slug) => {
      expect(await fresh().createOrg({ slug, name: "Acme" }, NOW)).toMatchObject({
        ok: false,
        error: "invalid_slug",
      });
    },
  );

  it.each(["", "   ", "bad\nname", "x".repeat(101)])("refuses the name %j", async (name) => {
    expect(await fresh().createOrg({ slug: "acme", name }, NOW)).toMatchObject({
      ok: false,
      error: "invalid_name",
    });
  });

  it("renames the name and the slug, keeping the id, and keeps slugs unique", async () => {
    const platform = fresh();
    const acme = await platform.createOrg({ slug: "acme", name: "Acme" }, NOW);
    const beta = await platform.createOrg({ slug: "beta", name: "Beta" }, NOW + 1);

    if (!acme.ok || !beta.ok) throw new Error("setup");

    const renamed = await platform.updateOrg("acme", { slug: "acme-inc", name: "Acme Inc" });
    expect(renamed).toMatchObject({ ok: true, org: { id: acme.org.id, slug: "acme-inc" } });
    expect(await platform.getOrgBySlug("acme")).toBeUndefined();
    expect((await platform.getOrgBySlug("acme-inc"))?.name).toBe("Acme Inc");

    expect(await platform.updateOrg("beta", { slug: "acme-inc" })).toMatchObject({
      ok: false,
      error: "slug_taken",
    });
    // Keeping its own slug is not a clash; only the name changes.
    expect(await platform.updateOrg("beta", { slug: "beta", name: "Beta Ltd" })).toMatchObject({
      ok: true,
      org: { name: "Beta Ltd" },
    });
    expect(await platform.updateOrg("nobody", { name: "X" })).toMatchObject({
      ok: false,
      error: "not_found",
    });
    expect(await platform.updateOrg("beta", { slug: "Bad Slug" })).toMatchObject({
      ok: false,
      error: "invalid_slug",
    });
    expect(await platform.updateOrg("beta", { name: " " })).toMatchObject({
      ok: false,
      error: "invalid_name",
    });

    // The freed slug can be taken again, by an org with an id of its own.
    const reused = await platform.createOrg({ slug: "acme", name: "New Acme" }, NOW + 2);

    if (!reused.ok) throw new Error(reused.message);
    expect(reused.org.id).not.toBe(acme.org.id);
  });
});

describe("membership index", () => {
  const setup = async () => {
    const platform = fresh();
    const acme = await platform.createOrg({ slug: "acme", name: "Acme" }, NOW);
    const beta = await platform.createOrg({ slug: "beta", name: "Beta" }, NOW + 1);

    if (!acme.ok || !beta.ok) throw new Error("setup");

    return { platform, acme: acme.org, beta: beta.org };
  };

  it("finds the orgs of a person and the org of a service token", async () => {
    const { platform, acme, beta } = await setup();

    expect(
      await platform.replaceOrgIndex(acme.id, {
        emails: [" Alice@Example.com ", "bob@example.com", "alice@example.com"],
        serviceTokens: ["ci.access"],
      }),
    ).toEqual({ ok: true, members: 2, serviceTokens: 1, conflicts: [] });

    await platform.replaceOrgIndex(beta.id, { emails: ["ALICE@example.com"], serviceTokens: [] });

    expect((await platform.orgsOfEmail("alice@EXAMPLE.com")).map((org) => org.slug)).toEqual([
      "acme",
      "beta",
    ]);
    expect((await platform.orgsOfEmail("bob@example.com")).map((org) => org.slug)).toEqual([
      "acme",
    ]);
    expect(await platform.orgsOfEmail("nobody@example.com")).toEqual([]);
    expect((await platform.orgOfServiceToken("ci.access"))?.id).toBe(acme.id);
    expect(await platform.orgOfServiceToken("other.access")).toBeUndefined();
  });

  it("repairs an org's rows from its own lists, leaving other orgs alone", async () => {
    const { platform, acme, beta } = await setup();

    await platform.replaceOrgIndex(acme.id, {
      emails: ["alice@example.com", "stale@example.com"],
      serviceTokens: ["old.access"],
    });
    await platform.replaceOrgIndex(beta.id, { emails: ["alice@example.com"], serviceTokens: [] });

    // The ControlPlane of acme says stale left and the token changed.
    await platform.replaceOrgIndex(acme.id, {
      emails: ["alice@example.com"],
      serviceTokens: ["new.access"],
    });

    expect(await platform.orgsOfEmail("stale@example.com")).toEqual([]);
    expect(await platform.orgOfServiceToken("old.access")).toBeUndefined();
    expect((await platform.orgOfServiceToken("new.access"))?.id).toBe(acme.id);
    expect((await platform.orgsOfEmail("alice@example.com")).map((org) => org.slug)).toEqual([
      "acme",
      "beta",
    ]);
  });

  it("keeps a service token with the org that holds it and reports the clash", async () => {
    const { platform, acme, beta } = await setup();

    await platform.replaceOrgIndex(acme.id, { emails: [], serviceTokens: ["shared.access"] });

    expect(
      await platform.replaceOrgIndex(beta.id, { emails: [], serviceTokens: ["shared.access"] }),
    ).toEqual({ ok: true, members: 0, serviceTokens: 0, conflicts: ["shared.access"] });
    expect((await platform.orgOfServiceToken("shared.access"))?.id).toBe(acme.id);
    // Repairing the same org again is no clash with itself.
    expect(
      await platform.replaceOrgIndex(acme.id, { emails: [], serviceTokens: ["shared.access"] }),
    ).toMatchObject({ ok: true, serviceTokens: 1, conflicts: [] });
  });

  it("refuses to index an org the registry does not list", async () => {
    expect(
      await fresh().replaceOrgIndex("ghost", { emails: ["a@b.c"], serviceTokens: [] }),
    ).toEqual({ ok: false, error: "not_found" });
  });
});

describe("usage retention", () => {
  it("gives a new org 90 days and `global` none", async () => {
    const platform = fresh();

    expect((await platform.listOrgs()).map((org) => [org.slug, org.usageRetentionDays])).toEqual([
      ["default", null],
    ]);

    const created = await platform.createOrg({ slug: "fresh", name: "Fresh" }, NOW);

    if (!created.ok) throw new Error(created.message);
    expect(DEFAULT_USAGE_RETENTION_DAYS).toBe(90);
    expect(created.org.usageRetentionDays).toBe(90);

    // Restarting changes nothing.
    await evictDurableObject(platform);
    expect((await platform.listOrgs()).map((org) => [org.slug, org.usageRetentionDays])).toEqual([
      ["default", null],
      ["fresh", 90],
    ]);
  });

  it("sets and clears the period of an org, refusing anything but whole days", async () => {
    const platform = fresh();
    const created = await platform.createOrg({ slug: "acme", name: "Acme" }, NOW);

    if (!created.ok) throw new Error(created.message);

    expect(await platform.setUsageRetention(created.org.id, 30)).toMatchObject({
      ok: true,
      org: { usageRetentionDays: 30 },
    });
    expect((await platform.getOrgById(created.org.id))?.usageRetentionDays).toBe(30);
    expect(await platform.setUsageRetention(created.org.id, null)).toMatchObject({
      ok: true,
      org: { usageRetentionDays: null },
    });

    for (const days of [0, -1, 1.5, 3651, Number.NaN])
      expect(await platform.setUsageRetention(created.org.id, days)).toMatchObject({
        ok: false,
        error: "invalid_retention",
      });

    expect(await platform.setUsageRetention("org-ghost", 30)).toMatchObject({
      ok: false,
      error: "not_found",
    });
  });

  it("sets the agent runs' period beside the usage records', 30 days for a new org (#228)", async () => {
    const platform = fresh();
    const created = await platform.createOrg({ slug: "runs-kept", name: "Runs" }, NOW);

    if (!created.ok) throw new Error(created.message);
    expect(created.org).toMatchObject({ usageRetentionDays: 90, runRetentionDays: 30 });

    expect(await platform.setRetention(created.org.id, { runDays: 7 })).toMatchObject({
      ok: true,
      org: { usageRetentionDays: 90, runRetentionDays: 7 },
    });
    expect(
      await platform.setRetention(created.org.id, { usageDays: null, runDays: null }),
    ).toMatchObject({ ok: true, org: { usageRetentionDays: null, runRetentionDays: null } });

    // Nothing changes unless every period named is valid.
    expect(
      await platform.setRetention(created.org.id, { usageDays: 10, runDays: 0 }),
    ).toMatchObject({ ok: false, error: "invalid_retention" });
    expect(await platform.getOrgById(created.org.id)).toMatchObject({
      usageRetentionDays: null,
      runRetentionDays: null,
    });
  });
});

describe("removal", () => {
  const setup = async () => {
    const platform = fresh();
    const acme = await platform.createOrg({ slug: "acme", name: "Acme" }, NOW);
    const beta = await platform.createOrg({ slug: "beta", name: "Beta" }, NOW + 1);

    if (!acme.ok || !beta.ok) throw new Error("setup");
    await platform.replaceOrgIndex(acme.org.id, {
      emails: ["alice@example.com", "bob@example.com"],
      serviceTokens: ["acme.access"],
    });
    await platform.replaceOrgIndex(beta.org.id, {
      emails: ["alice@example.com"],
      serviceTokens: ["beta.access"],
    });

    return { platform, acme: acme.org, beta: beta.org };
  };

  it("removes an org with its index rows, frees its slug and leaves the other orgs alone", async () => {
    const { platform, acme, beta } = await setup();

    expect(await platform.deleteOrg(acme.id)).toEqual({ ok: true });

    expect(await platform.getOrgById(acme.id)).toBeUndefined();
    expect(await platform.getOrgBySlug("acme")).toBeUndefined();
    expect(await platform.orgOfServiceToken("acme.access")).toBeUndefined();
    expect((await platform.orgsOfEmail("alice@example.com")).map((org) => org.slug)).toEqual([
      "beta",
    ]);
    expect(await platform.orgsOfEmail("bob@example.com")).toEqual([]);
    expect((await platform.orgOfServiceToken("beta.access"))?.id).toBe(beta.id);

    // Its rows are gone from the tables, not hidden.
    await runInDurableObject(platform, (_instance, state) => {
      const count = (sql: string) => state.storage.sql.exec<{ n: number }>(sql, acme.id).one().n;

      expect(count("SELECT COUNT(*) AS n FROM orgs WHERE id = ?")).toBe(0);
      expect(count("SELECT COUNT(*) AS n FROM org_members WHERE org_id = ?")).toBe(0);
      expect(count("SELECT COUNT(*) AS n FROM org_service_tokens WHERE org_id = ?")).toBe(0);
    });

    // The slug can be taken again, by an org with an id of its own.
    const reused = await platform.createOrg({ slug: "acme", name: "Acme again" }, NOW + 2);

    if (!reused.ok) throw new Error(reused.message);
    expect(reused.org.id).not.toBe(acme.id);
  });

  it("never removes global, and answers not_found for an org it does not list", async () => {
    const { platform } = await setup();

    expect(await platform.deleteOrg(GLOBAL_ORG)).toMatchObject({ ok: false, error: "global" });
    expect((await platform.getOrgById(GLOBAL_ORG))?.slug).toBe("default");
    expect(await platform.deleteOrg("org-ghost")).toMatchObject({ ok: false, error: "not_found" });
  });

  it("removes a person from the index of every org", async () => {
    const { platform } = await setup();

    expect(await platform.removePerson(" Alice@Example.com ")).toBe(2);
    expect(await platform.orgsOfEmail("alice@example.com")).toEqual([]);
    expect((await platform.orgsOfEmail("bob@example.com")).map((org) => org.slug)).toEqual([
      "acme",
    ]);
    expect(await platform.removePerson("alice@example.com")).toBe(0);
  });
});

describe("single sign-on domains", () => {
  const setup = async () => {
    const platform = fresh();
    const acme = await platform.createOrg({ slug: "acme", name: "Acme" }, NOW);
    const beta = await platform.createOrg({ slug: "beta", name: "Beta" }, NOW + 1);

    if (!acme.ok || !beta.ok) throw new Error("setup");

    return { platform, acme: acme.org, beta: beta.org };
  };

  it("gives a verified domain to one org only, until that org releases it", async () => {
    const { platform, acme, beta } = await setup();

    expect(await platform.ssoDomain("acme.com")).toBeUndefined();
    expect(await platform.claimSsoDomain("acme.com", acme.id)).toEqual({ ok: true });
    // Claiming again is harmless for the holder, refused for anyone else.
    expect(await platform.claimSsoDomain("acme.com", acme.id)).toEqual({ ok: true });
    expect(await platform.claimSsoDomain("acme.com", beta.id)).toMatchObject({
      ok: false,
      error: "domain_taken",
    });
    expect(await platform.ssoDomain("acme.com")).toEqual({ org: acme.id, requireSso: false });

    // Only the holder releases it.
    await platform.releaseSsoDomain("acme.com", beta.id);
    expect((await platform.ssoDomain("acme.com"))?.org).toBe(acme.id);
    await platform.releaseSsoDomain("acme.com", acme.id);
    expect(await platform.ssoDomain("acme.com")).toBeUndefined();
    expect(await platform.claimSsoDomain("acme.com", beta.id)).toEqual({ ok: true });
  });

  it("refuses a claim for an org it does not list", async () => {
    const { platform } = await setup();

    expect(await platform.claimSsoDomain("ghost.com", "org-ghost")).toMatchObject({
      ok: false,
      error: "not_found",
    });
  });

  it("records whether the holder requires single sign-on for the domain", async () => {
    const { platform, acme, beta } = await setup();

    await platform.claimSsoDomain("acme.com", acme.id);
    expect(await platform.setSsoDomainRequired("acme.com", beta.id, true)).toBe(false);
    expect(await platform.setSsoDomainRequired("acme.com", acme.id, true)).toBe(true);
    expect(await platform.ssoDomain("acme.com")).toEqual({ org: acme.id, requireSso: true });
    expect(await platform.setSsoDomainRequired("acme.com", acme.id, false)).toBe(true);
    expect((await platform.ssoDomain("acme.com"))?.requireSso).toBe(false);
    expect(await platform.setSsoDomainRequired("other.com", acme.id, true)).toBe(false);
  });

  it("frees the domains of a deleted org", async () => {
    const { platform, acme, beta } = await setup();

    await platform.claimSsoDomain("acme.com", acme.id);
    await platform.claimSsoDomain("beta.com", beta.id);
    expect(await platform.deleteOrg(acme.id)).toEqual({ ok: true });

    expect(await platform.ssoDomain("acme.com")).toBeUndefined();
    expect((await platform.ssoDomain("beta.com"))?.org).toBe(beta.id);
  });

  it("adds its table to a registry stored before single sign-on", async () => {
    const platform = fresh();

    await platform.listOrgs();
    await runInDurableObject(platform, (_instance, state) => {
      state.storage.sql.exec("DROP TABLE sso_domains");
    });
    await evictDurableObject(platform);

    expect(await platform.claimSsoDomain("acme.com", GLOBAL_ORG)).toEqual({ ok: true });
    expect((await platform.ssoDomain("acme.com"))?.org).toBe(GLOBAL_ORG);
  });
});

describe("leases", () => {
  it("are held by one taker at a time and given back with their token", async () => {
    const platform = fresh();
    const first = await platform.takeLease("catalog_refresh", "cron");

    if (!first.ok) throw new Error("the first refresh takes the lease");

    const second = await platform.takeLease("catalog_refresh", "panel");
    expect(second).toMatchObject({ ok: false, held: { source: "cron" } });

    await platform.releaseLease("not-the-token");
    expect((await platform.takeLease("catalog_refresh", "panel")).ok).toBe(false);

    await platform.releaseLease(first.lease.token);
    expect((await platform.takeLease("catalog_refresh", "panel")).ok).toBe(true);
  });
});
