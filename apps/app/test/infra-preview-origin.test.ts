// A Commissary Cloud preview's app origin, derived before the app Worker exists (infra/preview-origin.ts).
import { describe, expect, it } from "vite-plus/test";
import { previewAppName, previewOrigin } from "../../../infra/preview-origin.ts";

describe("a Cloud preview's app origin", () => {
  it("is the app Worker's explicit name under the API Worker's workers.dev subdomain", () => {
    expect(previewAppName("pr-172")).toBe("commissary-app-pr-172");
    expect(
      previewOrigin("https://commissary-api-pr-172.acme.workers.dev", previewAppName("pr-172")),
    ).toEqual({
      appOrigin: "https://commissary-app-pr-172.acme.workers.dev",
      accountDomain: "acme.workers.dev",
    });
  });

  it("fails the deploy without a workers.dev URL to derive it from", () => {
    expect(() => previewOrigin(undefined, "app")).toThrow("has no workers.dev URL");

    for (const url of [
      "https://api.commissary.example.com",
      "https://workers.dev",
      "https://acme.workers.dev",
      "https://a.b.acme.workers.dev",
    ])
      expect(() => previewOrigin(url, "app"), url).toThrow("is no workers.dev URL");
  });
});
