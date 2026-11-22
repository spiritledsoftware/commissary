// Which paths the API Worker serves (src/http/client-api.ts, ADR 0030, ADR 0052): the client API, and the hub API
// beside it, which is not the client API (no client gate, no CORS).
import { describe, expect, it } from "vite-plus/test";
import {
  API_WORKER_PREFIXES,
  CLIENT_API_PREFIXES,
  HUB_API_PREFIX,
  isClientApiPath,
  isHubApiPath,
  normalizedPath,
} from "../src/http/client-api.ts";

const path = (url: string): string => normalizedPath(`https://api.example.com${url}`) ?? "";

describe("the hub API's paths", () => {
  it("are under /v0/management, whatever the spelling", () => {
    expect(HUB_API_PREFIX).toBe("/v0/management");

    for (const url of [
      "/v0/management/auth-files",
      "/v0/management/api-call",
      "/v0/management/reset-quota",
      "/V0/Management/auth-files",
      "//v0//management/api-call",
      "/%76%30/management/auth-files",
      "/v0/management",
      "/v0/management/unknown",
    ])
      expect(isHubApiPath(path(url)), url).toBe(true);

    for (const url of ["/v0", "/v0/models", "/v9/management/config", "/v1/models", "/"])
      expect(isHubApiPath(path(url)), url).toBe(false);
  });

  it("are not the client API", () => {
    expect(isClientApiPath(path("/v0/management/auth-files"))).toBe(false);
  });

  it("join the client API's prefixes among the API Worker's, last", () => {
    expect(API_WORKER_PREFIXES).toEqual([...CLIENT_API_PREFIXES, HUB_API_PREFIX]);
  });
});
