// A fake remote MCP server (Streamable HTTP) served in workerd: the test replaces the isolate's `fetch` with one that
// routes each request to the fake of its origin. The ControlPlane runs in the test's isolate, so its builds and calls
// reach the fakes. A fake speaks the 2025 handshake (a session after `initialize`, which it may forget) or,
// `stateless`, the 2026-07-28 revision only; it answers JSON or SSE, pages its tool list, answers `tools/call` with
// its `call` handler, and refuses requests its `authorized` check refuses.
import { afterAll, beforeAll } from "vitest";

export interface FakeTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly annotations?: Record<string, unknown>;
}

export interface RecordedMcpRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  /** The JSON-RPC method, for a POST. */
  readonly rpc?: string;
  /** The JSON-RPC params, for a POST. */
  readonly params?: Record<string, unknown>;
}

export interface FakeMcpServer {
  /** The server's MCP endpoint. */
  readonly url: string;
  /** What `tools/list` lists; change it between builds to add or drop tools. */
  tools: ReadonlyArray<FakeTool>;
  readonly requests: Array<RecordedMcpRequest>;
  /** Whether it speaks only the stateless revision; change it between calls to switch eras. */
  stateless: boolean;
  /** Forgets every session it opened: a request in one of them is answered `404`, as a 2025 server does. */
  forgetSessions(): void;
}

export interface FakeMcpOptions {
  readonly tools?: ReadonlyArray<FakeTool>;
  /** Whether a request may list tools; every request by default. */
  readonly authorized?: (request: Request) => boolean;
  /** Speaks only the stateless 2026-07-28 revision: `initialize` is refused (`FakeMcpServer.stateless` switches). */
  readonly stateless?: boolean;
  /** Answers with SSE streams instead of JSON. */
  readonly sse?: boolean;
  /** Tools per page of `tools/list`; all on one page by default. */
  readonly pageSize?: number;
  /**
   * What `tools/call` answers for the upstream tool `name`: a result, or a whole response; by default a text result that
   * echoes the name and the arguments. A handler that throws makes the request fail, as an unreachable server does.
   */
  readonly call?: (
    name: string,
    args: Record<string, unknown> | undefined,
    request: Request,
  ) => Record<string, unknown> | Response;
}

/** A JSON-RPC request id as the fake reads it. */
type RequestId = string | number | null | undefined;

/** A JSON-RPC result the fake answers. */
interface RpcResult {
  readonly [field: string]: unknown;
}

const rpcError = (id: RequestId, code: number, message: string) =>
  Response.json({ jsonrpc: "2.0", id, error: { code, message } });

const servers = new Map<string, (request: Request) => Promise<Response>>();

const realFetch = globalThis.fetch;

/** Installs the routing `fetch` for the file's tests (FetchHttpClient resolves `globalThis.fetch` once). */
export const serveFakeMcpServers = (): void => {
  beforeAll(() => {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const handle = servers.get(new URL(request.url).origin);

      return handle === undefined
        ? new Response("no such server", { status: 599 })
        : await handle(request);
    };
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
  });
};

/** A fake MCP server at `url` (a unique origin per test keeps tests apart). */
export const fakeMcpServer = (url: string, options: FakeMcpOptions = {}): FakeMcpServer => {
  const sessions = new Set<string>();
  let opened = 0;

  const server: FakeMcpServer = {
    url,
    tools: options.tools ?? [],
    requests: [],
    stateless: options.stateless === true,
    forgetSessions: () => sessions.clear(),
  };

  const reply = (id: RequestId, result: RpcResult, headers: Record<string, string> = {}) => {
    const message = JSON.stringify({ jsonrpc: "2.0", id, result });

    return options.sse === true
      ? new Response(`event: message\ndata: ${message}\n\n`, {
          headers: { "content-type": "text/event-stream", ...headers },
        })
      : new Response(message, { headers: { "content-type": "application/json", ...headers } });
  };

  servers.set(new URL(url).origin, async (request) => {
    const body =
      request.method === "POST"
        ? await request.json<{
            id?: RequestId;
            method: string;
            params?: {
              cursor?: string;
              name?: string;
              arguments?: Record<string, unknown>;
              [field: string]: unknown;
            };
          }>()
        : undefined;

    server.requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      ...(body === undefined ? {} : { rpc: body.method }),
      ...(body?.params === undefined ? {} : { params: body.params }),
    });

    if (new URL(request.url).pathname !== new URL(url).pathname)
      return new Response("not found", { status: 404 });

    if (options.authorized !== undefined && !options.authorized(request))
      return new Response("unauthorized", { status: 401 });

    if (request.method === "DELETE") return new Response(null, { status: 200 });

    if (body === undefined) return new Response(null, { status: 405 });

    if (body.method === "initialize") {
      if (server.stateless)
        return rpcError(body.id, -32601, "initialize is not a method of this revision");

      opened += 1;
      const session = `fake-session-${opened}`;

      sessions.add(session);

      return reply(
        body.id,
        {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fake", version: "1" },
        },
        { "mcp-session-id": session },
      );
    }

    if (body.method.startsWith("notifications/")) return new Response(null, { status: 202 });

    if (body.method !== "tools/list" && body.method !== "tools/call")
      return rpcError(body.id, -32601, "unknown method");

    if (server.stateless) {
      if (request.headers.get("mcp-protocol-version") !== "2026-07-28")
        return new Response("unsupported protocol version", { status: 400 });
    } else {
      const session = request.headers.get("mcp-session-id");

      if (session === null) return new Response("no session", { status: 400 });

      if (!sessions.has(session)) return new Response("session not found", { status: 404 });
    }

    if (body.method === "tools/call") {
      const name = body.params?.name ?? "";
      const args = body.params?.arguments;

      const answered =
        options.call?.(name, args, request) ??
        ({
          content: [{ type: "text", text: JSON.stringify({ name, arguments: args ?? null }) }],
        } satisfies RpcResult);

      return answered instanceof Response ? answered : reply(body.id, answered);
    }

    const size = options.pageSize ?? server.tools.length;
    const start = Number(body.params?.cursor ?? 0);
    const page = server.tools.slice(start, start + Math.max(size, 1));

    const next =
      start + page.length < server.tools.length ? String(start + page.length) : undefined;

    return reply(body.id, {
      tools: page.map((tool) => ({ inputSchema: { type: "object" }, ...tool })),
      ...(next === undefined ? {} : { nextCursor: next }),
    });
  });

  return server;
};
