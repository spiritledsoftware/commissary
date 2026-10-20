// The routing `fetch` every fake upstream server of Tools' tests shares (fake MCP servers `mcp-server.ts`, fake HTTP
// servers `http-server.ts`): the test replaces the isolate's `fetch` with one that hands each request to the fake of its
// origin, `599` for an origin no fake serves. The ControlPlane runs in the test's isolate, so its builds and calls
// reach the fakes. A unique origin per fake keeps tests apart.
import { afterAll, beforeAll } from "vitest";

const routes = new Map<string, (request: Request) => Promise<Response>>();

const realFetch = globalThis.fetch;

/** Routes the requests to `origin` to `handle`, in place of the fake that served it before. */
export const routeFakeServer = (
  origin: string,
  handle: (request: Request) => Promise<Response>,
): void => {
  routes.set(origin, handle);
};

/** Installs the routing `fetch` for the file's tests (FetchHttpClient resolves `globalThis.fetch` once). */
export const serveFakeServers = (): void => {
  beforeAll(() => {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const handle = routes.get(new URL(request.url).origin);

      return handle === undefined
        ? new Response("no such server", { status: 599 })
        : await handle(request);
    };
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
  });
};
