// The panel on Commissary Cloud (src/management/web-panel.ts): its page names the auth host (ADR 0030) for the sign-in
// page and the sign-out to call, and its policy lets it call that host and load the Turnstile widget.
import { env } from "cloudflare:workers";
import { afterAll, describe, expect, it } from "vitest";
import { makeWebHandler } from "../../src/http/app.ts";
import { AUTH_ORIGIN_META } from "@commissary/contract/sign-in";
import { hostedPanelCsp, PANEL_CSP } from "../../src/management/web-panel.ts";
import { requestContext } from "../../src/worker-env.ts";
import { AUTH_ORIGIN, ORIGIN } from "./support.ts";

const INDEX_HTML =
  '<!doctype html><html><head><script type="module" src="/assets/index-abc.js"></script></head><body></body></html>';

// SAFETY: the panel reads only `fetch` of its assets binding.
const ASSETS = {
  fetch: async () => new Response(INDEX_HTML, { headers: { "content-type": "text/html" } }),
} as unknown as Fetcher;

// SAFETY: serving the panel's page schedules no background work.
const ctx = {} as unknown as ExecutionContext;

const { handler, dispose } = makeWebHandler();

afterAll(dispose);

/** The sign-in page, served with `bindings` over the test Worker's. */
const signInPage = (bindings: Partial<Env>) =>
  handler(new Request(`${ORIGIN}/sign-in`), requestContext({ ...env, ASSETS, ...bindings }, ctx));

describe("the panel on Commissary Cloud", () => {
  it("names the auth host in its page and lets the page call it", async () => {
    const response = await signInPage({});

    expect(response.status).toBe(200);
    const csp = response.headers.get("content-security-policy") ?? "";

    expect(csp).toBe(hostedPanelCsp(AUTH_ORIGIN));
    expect(csp).toContain(`connect-src 'self' ${AUTH_ORIGIN}`);
    expect(csp).toContain("frame-src https://live.browser.run https://challenges.cloudflare.com");
    expect(await response.text()).toContain(
      `<meta name="${AUTH_ORIGIN_META}" content="${AUTH_ORIGIN}">`,
    );
  });

  it("names no auth host while AUTH_ORIGIN is not an origin", async () => {
    const response = await signInPage({ AUTH_ORIGIN: "auth.commissary.test" });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(hostedPanelCsp(undefined));
    expect(response.headers.get("content-security-policy")).not.toBe(PANEL_CSP);
    expect(await response.text()).toBe(INDEX_HTML);
  });
});
