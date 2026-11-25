// Where a Copilot credential may send inference requests (internal/auth/copilot/client.go `TrustedAPI`, `Token.API`).
import { describe, expect, it } from "vite-plus/test";
import {
  COPILOT_DEFAULT_API,
  copilotApiBase,
  isTrustedCopilotApi,
} from "../../src/oauth/flows/copilot.ts";

describe("isTrustedCopilotApi", () => {
  it.each([
    "https://api.githubcopilot.com",
    "https://api.individual.githubcopilot.com",
    "https://api.business.githubcopilot.com/",
    "https://api.enterprise.githubcopilot.com",
  ])("trusts %s", (url) => {
    expect(isTrustedCopilotApi(url)).toBe(true);
  });

  it.each([
    "http://api.githubcopilot.com",
    "https://api.githubcopilot.com:8443",
    "https://user@api.githubcopilot.com",
    "https://api.githubcopilot.com/v1",
    "https://api.githubcopilot.com?x=1",
    "https://api.githubcopilot.com#x",
    "https://evil.githubcopilot.com",
    "https://api.githubcopilot.com.evil.com",
    "not a url",
  ])("refuses %s", (url) => {
    expect(isTrustedCopilotApi(url)).toBe(false);
  });
});

describe("copilotApiBase", () => {
  it("takes the token's endpoint, without a trailing slash", () => {
    expect(
      copilotApiBase({ token: "t", endpoints: { api: "https://api.business.githubcopilot.com/" } }),
    ).toBe("https://api.business.githubcopilot.com");
  });

  it("falls back to the token's proxy endpoint, then the individual API", () => {
    expect(copilotApiBase({ token: "tid=1;proxy-ep=proxy.enterprise.githubcopilot.com;x=2" })).toBe(
      "https://api.enterprise.githubcopilot.com",
    );
    expect(copilotApiBase({ token: "tid=1" })).toBe(COPILOT_DEFAULT_API);
  });

  it("refuses an untrusted endpoint instead of falling back", () => {
    expect(copilotApiBase({ token: "t", endpoints: { api: "https://example.com" } })).toBe(
      undefined,
    );
    expect(copilotApiBase({ token: "proxy-ep=proxy.example.com" })).toBe(undefined);
  });
});
