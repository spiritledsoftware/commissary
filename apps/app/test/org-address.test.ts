// Org addressing (ADR 0021): `/v9/management/orgs/<slug>/...` and `/o/<slug>/...` name the org of a management request.
// The pure parts: parsing the address, classifying the paths, and the cross-site rules for the scoped spellings.
import { describe, expect, it } from "vite-plus/test";
import { crossSiteRejection } from "../src/access/csrf.ts";
import {
  classifyPath,
  isPanelPagePath,
  normalizedPath,
  parseOrgAddress,
  scopedUrl,
} from "../src/management/zones.ts";

describe("parseOrgAddress", () => {
  it.each([
    ["/v9/management/orgs/acme/config", "acme", "/v9/management/config"],
    ["/v9/management/orgs/acme/credentials/x%2Fy", "acme", "/v9/management/credentials/x%2Fy"],
    ["/v9/management/orgs/a1-b/me", "a1-b", "/v9/management/me"],
    // The prefix is matched as the router matches it: case-insensitively, skipping duplicate slashes.
    ["//V9/Management/Orgs/Acme//config", "acme", "/v9/management/config"],
    ["/v9/management/%6Frgs/acme/config", "acme", "/v9/management/config"],
    ["/o/acme", "acme", "/"],
    ["/o/acme/", "acme", "/"],
    ["/o/acme/accounts", "acme", "/accounts"],
    ["/o/acme/Settings/x", "acme", "/Settings/x"],
    ["/O/Acme/keys", "acme", "/keys"],
  ])("reads %s as org %s, path %s", (pathname, slug, path) => {
    expect(parseOrgAddress(pathname)).toEqual({ slug, path });
  });

  it.each([
    "/",
    "/accounts",
    "/v9/management/config",
    // Platform-level routes: the org list and one org's record.
    "/v9/management/orgs",
    "/v9/management/orgs/",
    "/v9/management/orgs/acme",
    "/v9/management/orgs/acme/",
    // No orgs inside an org, and no slug that is not one.
    "/v9/management/orgs/acme/orgs",
    "/v9/management/orgs/acme/orgs/beta/config",
    "/v9/management/orgs/Bad_Slug/config",
    "/v9/management/orgs/-a/config",
    "/v1/orgs/acme/config",
    // Not panel pages.
    "/o",
    "/o/",
    "/o/acme/assets/index.js",
    "/o/acme/nope",
    "/o/Bad_Slug/accounts",
    "/o/acme/v9/management/config",
  ])("does not read %s as an org address", (pathname) => {
    expect(parseOrgAddress(pathname)).toBeUndefined();
  });
});

describe("scopedUrl", () => {
  it("rewrites the path and keeps the query", () => {
    expect(scopedUrl("/v9/management/orgs/acme/config?x=1&y=2")).toEqual({
      slug: "acme",
      url: "/v9/management/config?x=1&y=2",
    });
    expect(scopedUrl("/o/acme/accounts")?.url).toBe("/accounts");
    expect(scopedUrl("https://commissary.test/o/acme/keys?z=1")).toEqual({
      slug: "acme",
      url: "/keys?z=1",
    });
  });

  it("is undefined for an unscoped URL", () => {
    expect(scopedUrl("/v9/management/config?x=1")).toBeUndefined();
    expect(scopedUrl("/v9/management/orgs?x=1")).toBeUndefined();
    expect(scopedUrl("/healthz")).toBeUndefined();
  });
});

describe("zones", () => {
  it.each([
    "/v9/management/orgs",
    "/v9/management/orgs/acme/config",
    "/o/acme",
    "/o/acme/accounts",
    "/o/acme/assets/x.js",
    "/o/anything/else",
    "/o/",
    "/%6f/acme/accounts",
  ])("%s is in the management zone", (path) => {
    expect(classifyPath(`https://x.test${path}`)).toBe("management");
  });

  it("does not take other paths that start with o", () => {
    expect(classifyPath("https://x.test/o")).toBe("public");
    expect(classifyPath("https://x.test/openai/v1/models")).toBe("protected");
    expect(classifyPath("https://x.test/organisation")).toBe("public");
  });

  it.each(["/o/acme", "/o/acme/", "/o/acme/accounts", "/o/acme/settings/x"])(
    "%s is a panel page",
    (path) => {
      expect(isPanelPagePath(normalizedPath(`https://x.test${path}`) ?? "")).toBe(true);
    },
  );

  it.each(["/o/acme/assets/x.js", "/v9/management/orgs/acme/config", "/v9/management/orgs"])(
    "%s is not a panel page",
    (path) => {
      expect(isPanelPagePath(normalizedPath(`https://x.test${path}`) ?? "")).toBe(false);
    },
  );
});

describe("cross-site rules for scoped spellings", () => {
  const ORIGIN = "https://commissary.test";
  const crossSite = { "sec-fetch-site": "cross-site" };
  const navigate = { ...crossSite, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };

  const check = (method: string, path: string, headers: Record<string, string>) =>
    crossSiteRejection(method, headers, `${ORIGIN}${path}`, "management");

  it("lets a link from another site open a scoped panel page, but not its API", () => {
    expect(check("GET", "/o/acme/accounts", navigate)).toBeUndefined();
    expect(check("GET", "/o/acme", navigate)).toBeUndefined();
    expect(check("GET", "/v9/management/orgs/acme/config", navigate)).toMatchObject({
      status: 403,
    });
    expect(check("GET", "/v9/management/orgs", navigate)).toMatchObject({ status: 403 });
    expect(check("GET", "/o/acme/assets/x.js", navigate)).toMatchObject({ status: 403 });
    expect(check("POST", "/o/acme/accounts", navigate)).toMatchObject({ status: 403 });
  });

  it("refuses scoped writes from other sites", () => {
    expect(check("POST", "/v9/management/orgs", { origin: "https://evil.test" })).toMatchObject({
      status: 403,
    });
    expect(check("PUT", "/v9/management/orgs/acme/config", crossSite)).toMatchObject({
      status: 403,
    });
  });

  it("applies the content type rules of the unscoped path to the scoped one", () => {
    const form = { "content-type": "multipart/form-data; boundary=x" };
    const yaml = { "content-type": "application/yaml" };

    expect(check("POST", "/v9/management/orgs/acme/credentials", form)).toBeUndefined();
    expect(check("POST", "/v9/management/orgs/acme/oauth/import", form)).toBeUndefined();
    expect(check("POST", "/v9/management/orgs/acme/settings/import", yaml)).toBeUndefined();
    expect(check("POST", "/v9/management/orgs/acme/settings", form)).toMatchObject({ status: 415 });
    expect(check("PATCH", "/v9/management/orgs/acme/settings", yaml)).toMatchObject({
      status: 415,
    });
    // The org list takes JSON only.
    expect(check("POST", "/v9/management/orgs", form)).toMatchObject({ status: 415 });
    expect(
      check("POST", "/v9/management/orgs", { "content-type": "application/json" }),
    ).toBeUndefined();
  });
});
