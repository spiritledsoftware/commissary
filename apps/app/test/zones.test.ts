// The path zones of the panel page and the client API aliases (`src/management/zones.ts`), which decide the Access
// gate's treatment of a request.
import { describe, expect, it } from "vitest";
import { classifyPath, isPanelPagePath, LEGACY_PANEL_PATH } from "../src/management/zones.ts";

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

  it("puts the MCP endpoint, however spelt, in a zone of its own, and the paths under it in the client API's", () => {
    for (const path of ["/mcp", "/mcp/", "//MCP", "/%6dcp?toolkits=a"])
      expect(classifyPath(`https://x.test${path}`), path).toBe("mcp");

    for (const path of ["/mcp/x", "/mcpx"])
      expect(classifyPath(`https://x.test${path}`), path).toBe("protected");
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
