/**
 * The outbound guard (ADR 0044) for a library that fetches through the global `fetch` itself and takes no `fetch` of
 * ours: Cloudflare's `@cloudflare/workers-oauth-provider` (#200), which fetches an MCP client's Client ID Metadata
 * Document (CIMD) and the JWKS that document names. {@link withOutboundGuard} runs such a call with every `fetch` it
 * makes behind the guard: each hop checked by {@link checkOutboundUrl}, redirects followed by the guard (at most
 * {@link MAX_OUTBOUND_REDIRECTS}), as `guardHttpClient` does for Commissary's own requests.
 *
 * How: the global `fetch` is wrapped once (again whenever something replaced the wrapper, such as a test's stub), and
 * the wrapper guards only the calls made inside a {@link withOutboundGuard} (an `AsyncLocalStorage` scope, so a request
 * served at the same time in the same isolate is untouched). Outside one it calls the `fetch` it wrapped as it is.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { Result } from "effect";
import { checkOutboundUrl, OUTBOUND_REFUSED_MESSAGE, type OutboundPolicy } from "./check.ts";
import { MAX_OUTBOUND_REDIRECTS } from "./client.ts";

type Fetch = typeof globalThis.fetch;

/** The policy of the guarded call in progress, if any. */
const guardedCall = new AsyncLocalStorage<OutboundPolicy>();

/** Marks the wrapper, with the `fetch` it wraps. */
const WRAPPED = Symbol.for("@commissary/core/outbound/wrapped-fetch");

const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** A refusal, as `fetch` fails on a network error: the caller sees a `TypeError` with the guard's message. */
const refused = (reason: string, host: string): TypeError =>
  new TypeError(OUTBOUND_REFUSED_MESSAGE, { cause: { reason, host } });

const check = (url: string, policy: OutboundPolicy): void => {
  const checked = checkOutboundUrl(url, policy);

  if (Result.isFailure(checked)) throw refused(checked.failure.reason, checked.failure.host);
};

/**
 * `input` fetched with `inner` behind the guard: a redirect is followed only for a request without a body (or turned
 * into a GET by a 303, or by a 301/302 of a POST, as `fetch` does), every hop checked; `Authorization` and cookies are
 * dropped on a change of origin. A caller that asked for `redirect: "manual"` or `"error"` (in `init`, or on the
 * `Request` it passed) keeps it: only the first hop is checked.
 */
const guardedFetch = async (
  inner: Fetch,
  policy: OutboundPolicy,
  input: Parameters<Fetch>[0],
  init: Parameters<Fetch>[1],
): Promise<Response> => {
  const first = new Request(input, init);

  check(first.url, policy);

  if (first.redirect !== "follow") return await inner(first);

  let url = first.url;
  let method = first.method;
  const headers = new Headers(first.headers);
  let body: RequestInit["body"] = first.body;

  for (let hop = 0; ; hop += 1) {
    const response = await inner(url, {
      ...init,
      method,
      headers,
      body,
      redirect: "manual",
      ...(body === null ? {} : { duplex: "half" }),
    });

    const location = response.headers.get("location");

    if (!REDIRECTS.has(response.status) || location === null) return response;

    const target = new URL(location, url);

    if (hop >= MAX_OUTBOUND_REDIRECTS) {
      await response.body?.cancel();

      throw refused("too_many_redirects", new URL(url).hostname);
    }

    const toGet =
      response.status === 303
        ? method !== "GET" && method !== "HEAD"
        : (response.status === 301 || response.status === 302) && method === "POST";

    // A 307/308 would have to send a body again, which a stream cannot be: answered as it is.
    if (!toGet && body !== null) return response;

    await response.body?.cancel();
    check(target.href, policy);

    if (toGet) {
      method = "GET";
      body = null;
    }

    if (target.origin !== new URL(url).origin)
      for (const name of ["authorization", "proxy-authorization", "cookie"]) headers.delete(name);

    url = target.href;
  }
};

/** The wrapper of `inner`: guarded inside a {@link withOutboundGuard}, `inner` itself outside one. */
const wrap = (inner: Fetch): Fetch =>
  Object.assign(
    (input: Parameters<Fetch>[0], init?: Parameters<Fetch>[1]): Promise<Response> => {
      const policy = guardedCall.getStore();

      return policy === undefined ? inner(input, init) : guardedFetch(inner, policy, input, init);
    },
    { [WRAPPED]: inner },
  );

/**
 * Runs `run` with every global `fetch` it makes, directly or through a library, behind the outbound guard of `policy`
 * (see the module comment). A refused hop fails that `fetch` with a `TypeError` whose message is
 * {@link OUTBOUND_REFUSED_MESSAGE}, as a network error would.
 */
export const withOutboundGuard = <A>(policy: OutboundPolicy, run: () => Promise<A>): Promise<A> => {
  const current = globalThis.fetch;

  if (!(WRAPPED in current)) globalThis.fetch = wrap(current);

  return guardedCall.run(policy, run);
};
