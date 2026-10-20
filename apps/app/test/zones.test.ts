// The path zones of the panel page and the client API aliases (`src/management/zones.ts`), which decide the Access
// gate's treatment of a request.
import { describe, expect, it } from "vitest";
import {
  classifyPath,
  isPanelPagePath,
  LEGACY_PANEL_PATH,
  mcpAddress,
  mcpOrgSlug,
} from "../src/management/zones.ts";

describe("access classification of the panel page", () => {
  it("keeps the legacy panel path (a redirect to /) in the management zone", () => {
    expect(classifyPath(`https://x.test${LEGACY_PANEL_PATH}`)).toBe("management");
    expect(classifyPath("https://x.test/management.html")).toBe("management");
    expect(classifyPath("https://x.test//Management.HTML")).toBe("management");
    expect(classifyPath("https://x.test/%6danagement.html")).toBe("management");
    expect(classifyPath("https://x.test/other.html")).toBe("public");
  });

  it("protects the unprefixed client API aliases like their /v1 routes", () => {
    for (const path of [
      "/chat/completions",
      "/completions",
      "/responses",
      "/responses/compact",
      "/%72esponses",
      "//Chat/Completions",
    ])
      expect(classifyPath(`https://x.test${path}`)).toBe("protected");
  });

  it("puts the MCP endpoint of global and of an org, however spelt, in a zone of its own, never a panel page", () => {
    for (const path of [
      "/mcp",
      "/mcp/",
      "//MCP",
      "/%6dcp?toolkits=a",
      "/o/acme/mcp",
      "/O/Acme/MCP/",
      "//o//acme//mcp?toolkits=a",
    ]) {
      expect(classifyPath(`https://x.test${path}`), path).toBe("mcp");
      expect(isPanelPagePath(path), path).toBe(false);
    }

    expect(mcpAddress("https://x.test/mcp")).toEqual({ segment: undefined });
    expect(mcpAddress("https://x.test/O/Acme/mcp/")).toEqual({ segment: "acme" });

    for (const path of ["/mcp/x", "/mcpx"])
      expect(classifyPath(`https://x.test${path}`), path).toBe("protected");

    for (const path of ["/o/acme/mcp/x", "/o/acme/mcpx", "/o/acme/x/mcp", "/o/mcp"])
      expect(mcpAddress(`https://x.test${path}`), path).toBeUndefined();
  });

  it("classifies /o/<any segment>/mcp as the MCP endpoint, whose gate refuses one that is no slug", () => {
    for (const path of ["/o/-bad-/mcp", "/o/-bad-/mcp/", "/o/Not_A_Slug/mcp", "/o/%2Dbad%2D/mcp"])
      expect(classifyPath(`https://x.test${path}`), path).toBe("mcp");

    expect(mcpOrgSlug({ segment: undefined })).toEqual({ slug: undefined });
    expect(mcpOrgSlug({ segment: "acme" })).toEqual({ slug: "acme" });

    for (const segment of ["-bad-", "not_a_slug", "a".repeat(64)])
      expect(mcpOrgSlug({ segment }), segment).toBe("invalid");
  });

  it("names the pages a cross-site navigation may open (not the API, not the bundle)", () => {
    for (const path of ["/", "/accounts", "/accounts/connect", "/settings", LEGACY_PANEL_PATH])
      expect(isPanelPagePath(path), path).toBe(true);

    for (const path of [
      "/v9/management/config",
      "/assets/index.js",
      "/assets",
      "/management.htm",
      "/healthz",
    ])
      expect(isPanelPagePath(path), path).toBe(false);
  });
});
