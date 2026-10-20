// The outbound guard around a library's own `fetch` calls (#200: the OAuth provider's CIMD and JWKS fetches): inside
// `withOutboundGuard` every hop is checked and redirects are followed by the guard; outside it `fetch` is untouched.
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_OUTBOUND_REDIRECTS,
  OUTBOUND_REFUSED_MESSAGE,
  type OutboundPolicy,
  withOutboundGuard,
} from "../src/index.ts";

const POLICY: OutboundPolicy = { ownHosts: ["app.commissary.test"], localDevelopment: false };

const original = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = original;
});

interface Sent {
  readonly url: string;
  readonly redirect: string;
}

/** Replaces the global `fetch` with a fake that answers `answer(url)` and records each request. */
const fakeFetch = (answer: (url: URL) => Response) => {
  const sent: Array<Sent> = [];

  globalThis.fetch = async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init);

    sent.push({ url: request.url, redirect: init?.redirect ?? request.redirect });

    return answer(new URL(request.url));
  };

  return sent;
};

const redirectTo = (location: string, status = 302) =>
  new Response(null, { status, headers: { location } });

describe("withOutboundGuard", () => {
  it("lets a public HTTPS address through, and follows its redirects itself", async () => {
    const sent = fakeFetch((url) =>
      url.pathname === "/start" ? redirectTo("/doc") : Response.json({ ok: true }),
    );

    const response = await withOutboundGuard(POLICY, () =>
      fetch("https://client.example.com/start", { headers: { accept: "application/json" } }),
    );

    expect(await response.json()).toEqual({ ok: true });
    expect(sent).toEqual([
      { url: "https://client.example.com/start", redirect: "manual" },
      { url: "https://client.example.com/doc", redirect: "manual" },
    ]);
  });

  it("refuses an address the guard refuses, and a redirect onto one, before it is fetched", async () => {
    const sent = fakeFetch((url) =>
      url.hostname === "client.example.com" ? redirectTo("https://10.0.0.1/doc") : new Response(),
    );

    for (const target of [
      "http://client.example.com/doc",
      "https://169.254.169.254/latest",
      "https://app.commissary.test/doc",
      "https://client.example.com/doc",
    ])
      await expect(withOutboundGuard(POLICY, () => fetch(target))).rejects.toThrow(
        OUTBOUND_REFUSED_MESSAGE,
      );

    expect(sent.map((request) => request.url)).toEqual(["https://client.example.com/doc"]);
  });

  it("leaves a redirect to a caller that asked for it, in `init` or on its `Request`, checking the first hop", async () => {
    const sent = fakeFetch(() => redirectTo("https://10.0.0.1/doc"));

    for (const call of [
      () => fetch("https://client.example.com/doc", { redirect: "manual" }),
      () => fetch(new Request("https://client.example.com/doc", { redirect: "manual" })),
    ]) {
      const response = await withOutboundGuard(POLICY, call);

      expect(response.status).toBe(302);
    }

    expect(sent).toEqual([
      { url: "https://client.example.com/doc", redirect: "manual" },
      { url: "https://client.example.com/doc", redirect: "manual" },
    ]);

    await expect(
      withOutboundGuard(POLICY, () =>
        fetch(new Request("https://10.0.0.1/doc", { redirect: "manual" })),
      ),
    ).rejects.toThrow(OUTBOUND_REFUSED_MESSAGE);
  });

  it(`follows at most ${MAX_OUTBOUND_REDIRECTS} redirects`, async () => {
    fakeFetch((url) => redirectTo(`/hop/${Number(url.pathname.split("/").at(-1) ?? 0) + 1}`));

    await expect(
      withOutboundGuard(POLICY, () => fetch("https://client.example.com/hop/0")),
    ).rejects.toThrow(OUTBOUND_REFUSED_MESSAGE);
  });

  it("leaves `fetch` alone outside it, also while a guarded call is in flight", async () => {
    let release = () => {};

    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const sent = fakeFetch(() => new Response("ok"));

    const guarded = withOutboundGuard(POLICY, async () => {
      await held;

      return await fetch("https://10.0.0.2/doc");
    });

    // Unguarded meanwhile: a private address is the caller's business here.
    expect(await (await fetch("https://10.0.0.1/doc")).text()).toBe("ok");
    release();
    await expect(guarded).rejects.toThrow(OUTBOUND_REFUSED_MESSAGE);
    expect(sent.map((request) => request.url)).toEqual(["https://10.0.0.1/doc"]);
  });

  it("guards a `fetch` that replaced the one it wrapped", async () => {
    fakeFetch(() => new Response("first"));
    await withOutboundGuard(POLICY, () => fetch("https://client.example.com/doc"));

    const sent = fakeFetch(() => new Response("second"));

    await expect(withOutboundGuard(POLICY, () => fetch("https://10.0.0.1/doc"))).rejects.toThrow(
      OUTBOUND_REFUSED_MESSAGE,
    );
    expect(sent).toEqual([]);
  });
});
