// Upstream panel bookmarks (`/management.html#/...`, redirected to `/#/...`) mapped to the panel's pages
// (src/lib/legacy-hash.ts).
import { describe, expect, it } from "vite-plus/test";
import { legacyHashTarget } from "../src/lib/legacy-hash.ts";

describe("legacyHashTarget", () => {
  it("maps every upstream page to the page that replaced it", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["#/auth-files", "/accounts"],
      ["#/quota", "/accounts"],
      ["#/auth-files/oauth-excluded", "/models/rules"],
      ["#/auth-files/oauth-model-alias", "/models/rules"],
      ["#/oauth", "/accounts/connect"],
      ["#/ai-providers", "/keys"],
      ["#/ai-providers/claude/edit", "/keys"],
      ["#/quick-start", "/keys"],
      ["#/config", "/settings"],
      ["#/settings", "/settings"],
      ["#/api-keys", "/api-keys"],
      ["#/system", "/settings"],
    ];

    for (const [hash, target] of cases) expect(legacyHashTarget(hash), hash).toBe(target);
  });

  it("sends pages without a replacement to the overview", () => {
    for (const hash of ["#/", "#/dashboard", "#/logs", "#/plugins", "#/plugin-store", "#/nope"])
      expect(legacyHashTarget(hash), hash).toBe("/");
  });

  it("ignores case, trailing slashes, queries and nested fragments", () => {
    expect(legacyHashTarget("#/Auth-Files/")).toBe("/accounts");
    expect(legacyHashTarget("#/config?tab=source")).toBe("/settings");
    expect(legacyHashTarget("#/quota#top")).toBe("/accounts");
  });

  it("never answers another origin or a protocol-relative path (only fixed panel paths)", () => {
    for (const hash of [
      "#//evil.com",
      "#//evil.com/auth-files",
      "#/\\evil",
      "#/\\/evil.com",
      "#/%2F%2Fevil.com",
      "#/https://evil.com",
      "#/javascript:alert(1)",
    ])
      expect(legacyHashTarget(hash), hash).toBe("/");
  });

  it("matches whole path segments only", () => {
    expect(legacyHashTarget("#/auth-filesx")).toBe("/");
    expect(legacyHashTarget("#/configuration")).toBe("/");
  });

  it("leaves the panel's own fragments alone", () => {
    for (const hash of ["", "#", "#api-keys.claude.0", "#routing.strategy"])
      expect(legacyHashTarget(hash), hash).toBeUndefined();
  });
});
