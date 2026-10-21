// A tool's stable id (src/lib/tool-id.ts, #209): `<toolkit id>:<upstream name>`, taken apart.
import { describe, expect, it } from "vitest";
import { toolkitIdOf, upstreamNameOf } from "../src/lib/tool-id.ts";

describe("a tool's stable id", () => {
  it("names its toolkit and the tool its source calls it", () => {
    expect(toolkitIdOf("tk_linear:create_issue")).toBe("tk_linear");
    expect(upstreamNameOf("tk_linear:create_issue")).toBe("create_issue");
  });

  it("keeps a colon inside the upstream name", () => {
    expect(upstreamNameOf("tk_1:ns:name")).toBe("ns:name");
    expect(toolkitIdOf("tk_1:ns:name")).toBe("tk_1");
  });
});
