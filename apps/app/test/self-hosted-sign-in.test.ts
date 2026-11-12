// A self-hosted Commissary (COMMISSARY_MODE unset) has none of Commissary Cloud's sign-in routes (src/hosted/routes.ts): Better
// Auth's API, the sign-in options and the sign-in page answer exactly like an unknown path.
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

const fetchWorker = (path: string, init?: RequestInit) =>
  exports.default.fetch(
    new Request(`https://commissary.test${path}`, { redirect: "manual", ...init }),
  );

const snapshot = async (response: Response) => ({
  status: response.status,
  headers: [...response.headers.entries()].filter(([name]) => name !== "x-cpa-trace-id"),
  body: await response.text(),
});

describe("self-hosted Commissary", () => {
  it("reaches no Better Auth route, sign-in options or sign-in page", async () => {
    const unknown = await snapshot(await fetchWorker("/nope"));
    expect(unknown.status).toBe(404);

    for (const [method, path] of [
      ["GET", "/api/auth/get-session"],
      ["POST", "/api/auth/sign-in/social"],
      ["POST", "/api/auth/sign-out"],
      ["POST", "/api/auth/sign-in/sso"],
      ["GET", "/api/auth/sso/callback/sso-org-1?code=x&state=y"],
      ["POST", "/api/auth/sso/saml2/sp/acs/sso-org-1"],
      ["GET", "/api/auth/sso/saml2/sp/metadata?providerId=sso-org-1"],
      ["GET", "/api/auth/callback/github?code=x&state=y"],
      ["POST", "/api/auth/sign-up/email"],
      ["GET", "/api/sign-in-options"],
      ["GET", "/sign-in"],
    ] as const) {
      const response = await fetchWorker(path, {
        method,
        headers: { "content-type": "application/json", origin: "https://commissary.test" },
        ...(method === "POST" ? { body: JSON.stringify({ provider: "github" }) } : {}),
      });

      expect(await snapshot(response), `${method} ${path}`).toEqual(unknown);
    }
  });

  it("has no per-org single sign-on settings: Access configures the identity providers", async () => {
    const response = await exports.default.fetch(
      new Request("http://localhost/v9/management/sso", { redirect: "manual" }),
    );

    expect(response.status).toBe(404);
  });
});
