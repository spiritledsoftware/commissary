// The published-route providers and their prefixes (f89d408e).
import { describe, expect, it } from "vite-plus/test";
import {
  publishedProvider,
  sourceNativeId,
  stripPublishedPrefix,
} from "../../src/registry/published-routes.ts";

describe("published routes", () => {
  it("knows Copilot and Devin only", () => {
    expect(publishedProvider(" Copilot ")).toBe("copilot");
    expect(publishedProvider("devin")).toBe("devin");
    expect(publishedProvider("claude")).toBeUndefined();
    expect(publishedProvider("toString")).toBeUndefined();
  });

  it("strips a provider's own namespace, case-insensitively", () => {
    expect(stripPublishedPrefix("devin", "DEVIN/swe-2")).toBe("swe-2");
    expect(stripPublishedPrefix("copilot", "copilot/gpt-6-sol")).toBe("gpt-6-sol");
    expect(stripPublishedPrefix("copilot", "devin/swe-2")).toBe("devin/swe-2");
  });

  it("gives a source's native id, and leaves other ids alone", () => {
    expect(sourceNativeId("copilot/gpt-6-sol")).toBe("gpt-6-sol");
    expect(sourceNativeId("devin/swe-2")).toBe("swe-2");
    expect(sourceNativeId("team/gpt-6-sol")).toBe("team/gpt-6-sol");
    expect(sourceNativeId("gpt-6-sol")).toBe("gpt-6-sol");
  });
});
