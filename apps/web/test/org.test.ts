// Which org the panel shows (src/lib/org.ts), and how its API calls are addressed (`scopedApiUrl`,
// @commissary/contract/api).
import { describe, expect, it } from "vite-plus/test";
import { scopedApiUrl } from "@commissary/contract/api";
import { orgPanelPath, orgSlugOfPath, panelBasepath } from "../src/lib/org.ts";

describe("orgSlugOfPath", () => {
  it.each([
    ["/o/acme", "acme"],
    ["/o/acme/", "acme"],
    ["/o/acme/accounts/claude-a.json", "acme"],
    ["/o/ACME/accounts", "acme"],
    ["/O/acme", "acme"],
  ])("reads the slug of %s", (path, slug) => {
    expect(orgSlugOfPath(path)).toBe(slug);
  });

  it("survives a bad percent-escape in the slug", () => {
    expect(orgSlugOfPath("/o/%E0%A4%A/accounts")).toBe("%e0%a4%a");
  });

  it.each(["/", "/accounts", "/o", "/o/", "/other/acme", "/x/o/acme"])(
    "finds none in %s",
    (path) => {
      expect(orgSlugOfPath(path)).toBeUndefined();
    },
  );
});

describe("panelBasepath and orgPanelPath", () => {
  it("is the org's prefix, or the root for an address without an org", () => {
    expect(panelBasepath("/o/acme/accounts")).toBe("/o/acme");
    expect(panelBasepath("/o/Acme")).toBe("/o/acme");
    expect(panelBasepath("/accounts")).toBe("/");
    expect(panelBasepath("/")).toBe("/");
  });

  it("builds the address of a page of an org", () => {
    expect(orgPanelPath("acme")).toBe("/o/acme/");
    expect(orgPanelPath("acme", "/")).toBe("/o/acme/");
    expect(orgPanelPath("acme", "/accounts")).toBe("/o/acme/accounts");
  });
});

describe("scopedApiUrl", () => {
  it("inserts the org after the management prefix, in paths and absolute URLs", () => {
    expect(scopedApiUrl("/v9/management/credentials", "acme")).toBe(
      "/v9/management/orgs/acme/credentials",
    );
    expect(scopedApiUrl("https://commissary.test/v9/management/config/routing?x=1", "acme")).toBe(
      "https://commissary.test/v9/management/orgs/acme/config/routing?x=1",
    );
    expect(scopedApiUrl("/v9/management/oauth/import?provider=vertex", "acme")).toBe(
      "/v9/management/orgs/acme/oauth/import?provider=vertex",
    );
  });

  it("addresses /me to the org, where it answers the caller's role in it", () => {
    expect(scopedApiUrl("/v9/management/me", "acme")).toBe("/v9/management/orgs/acme/me");
    expect(scopedApiUrl("/v9/management/me", undefined)).toBe("/v9/management/me");
  });

  it("leaves the platform-level routes alone", () => {
    for (const url of [
      "/v9/management/orgs",
      "/v9/management/orgs/acme",
      "https://commissary.test/v9/management/orgs?x=1",
    ])
      expect(scopedApiUrl(url, "acme")).toBe(url);
  });

  it("scopes routes whose name merely starts like a platform-level one", () => {
    expect(scopedApiUrl("/v9/management/orgsx", "acme")).toBe("/v9/management/orgs/acme/orgsx");
    expect(scopedApiUrl("/v9/management/media", "acme")).toBe("/v9/management/orgs/acme/media");
  });

  it("changes nothing without an org or for another API", () => {
    expect(scopedApiUrl("/v9/management/credentials", undefined)).toBe(
      "/v9/management/credentials",
    );
    expect(scopedApiUrl("/v1/models", "acme")).toBe("/v1/models");
  });

  it("encodes a slug", () => {
    expect(scopedApiUrl("/v9/management/config", "a b")).toBe("/v9/management/orgs/a%20b/config");
  });
});
