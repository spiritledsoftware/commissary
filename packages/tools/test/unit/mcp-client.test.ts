// The MCP client's limits (`src/mcp/client.ts`), against a stub HttpClient: a redirect to another origin is not
// followed, so the credential never reaches it; an answer above 4 MiB and a list of more than 50 pages are refused; a
// listing that takes too long fails at its budget (driven by TestClock).
import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Option, Predicate } from "effect";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { listUpstreamTools, type McpError } from "../../src/mcp/client.ts";

const SOURCE = "https://mcp.example.com/mcp";

const SECRET = { kind: "bearer", token: "mcp-secret" } as const;

interface Sent {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly rpc: string | undefined;
}

/** The JSON-RPC method and id a request carries. */
const rpcOf = (request: HttpClientRequest.HttpClientRequest) => {
  if (!Predicate.isTagged(request.body, "Uint8Array")) return undefined;

  // SAFETY: the client sends a JSON-RPC message as its JSON body.
  return JSON.parse(new TextDecoder().decode(request.body.body)) as {
    readonly method: string;
    readonly id?: number;
  };
};

/** A JSON-RPC result the stub answers. */
type RpcResult = Readonly<Record<string, unknown>>;

const reply = (id: number | undefined, result: RpcResult, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    headers: { "content-type": "application/json", ...headers },
  });

/** A 2025 server: `initialize` opens a session; `tools/list` is what `list` answers for the cursor. */
const legacyServer =
  (list: (cursor: string | undefined, id: number | undefined) => Response) =>
  (rpc: { readonly method: string; readonly id?: number; readonly params?: unknown }) => {
    if (rpc.method === "initialize")
      return reply(rpc.id, { protocolVersion: "2025-11-25" }, { "mcp-session-id": "s1" });

    if (rpc.method.startsWith("notifications/")) return new Response(null, { status: 202 });

    // SAFETY: the client's `tools/list` params are `{ cursor? }`.
    const params = rpc.params as { readonly cursor?: string } | undefined;

    return list(params?.cursor, rpc.id);
  };

/** A stub HttpClient answering each request with `answer`, recording what was sent. */
const stub = (
  answer: (
    rpc: { readonly method: string; readonly id?: number; readonly params?: unknown },
    url: URL,
  ) => Response,
) => {
  const sent: Array<Sent> = [];

  const client = HttpClient.make((request, url) => {
    const rpc = rpcOf(request);

    sent.push({
      url: url.href,
      authorization: request.headers["authorization"],
      rpc: rpc?.method,
    });

    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        rpc === undefined ? new Response(null, { status: 200 }) : answer(rpc, url),
      ),
    );
  });

  return { sent, client };
};

const failureOf = <A>(exit: Exit.Exit<A, McpError>): McpError | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Exit.findErrorOption(exit)) : undefined;

describe("listUpstreamTools", () => {
  it.effect(
    "does not follow a 307 or 308 to another origin, so the credential stays with the source's",
    () =>
      Effect.gen(function* () {
        for (const status of [307, 308]) {
          const { sent, client } = stub(
            () =>
              new Response(null, {
                status,
                headers: { location: "https://elsewhere.example/mcp" },
              }),
          );

          const exit = yield* listUpstreamTools(SOURCE, SECRET).pipe(
            Effect.provideService(HttpClient.HttpClient, client),
            Effect.exit,
          );

          assert.strictEqual(failureOf(exit)?.reason, "http");
          assert.strictEqual(failureOf(exit)?.status, status);
          assert.isTrue(sent.length > 0);
          assert.isTrue(
            sent.every((request) => new URL(request.url).origin === new URL(SOURCE).origin),
          );
        }
      }),
  );

  it.effect("follows a 307 on the source's origin, signed in on every hop", () =>
    Effect.gen(function* () {
      const { sent, client } = stub((rpc, url) =>
        url.pathname === "/mcp"
          ? new Response(null, { status: 307, headers: { location: "/v2/mcp" } })
          : legacyServer((_cursor, id) => reply(id, { tools: [{ name: "t" }] }))(rpc),
      );

      const tools = yield* listUpstreamTools(SOURCE, SECRET).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );

      assert.deepStrictEqual(
        tools.map((tool) => tool.name),
        ["t"],
      );
      assert.isTrue(sent.every((request) => request.authorization === "Bearer mcp-secret"));
    }),
  );

  it.effect(
    "falls back to the stateless revision only when initialize is refused as that revision refuses it",
    () =>
      Effect.gen(function* () {
        const stateless = stub((rpc, url) =>
          rpc.method === "initialize"
            ? new Response("unsupported protocol version", { status: 400 })
            : url.pathname === "/mcp"
              ? reply(rpc.id, { tools: [{ name: "t" }] })
              : new Response(null, { status: 404 }),
        );

        const tools = yield* listUpstreamTools(SOURCE, SECRET).pipe(
          Effect.provideService(HttpClient.HttpClient, stateless.client),
        );

        assert.deepStrictEqual(
          tools.map((tool) => tool.name),
          ["t"],
        );

        // A 404 is no revision's refusal: it is reported as it is, and nothing else is tried.
        const missing = stub(() => new Response("not found", { status: 404 }));

        const exit = yield* listUpstreamTools(SOURCE, SECRET).pipe(
          Effect.provideService(HttpClient.HttpClient, missing.client),
          Effect.exit,
        );

        assert.strictEqual(failureOf(exit)?.status, 404);
        assert.deepStrictEqual(
          missing.sent.map((request) => request.rpc),
          ["initialize"],
        );
      }),
  );

  it.effect("refuses an answer above 4 MiB as too large", () =>
    Effect.gen(function* () {
      const { client } = stub(
        legacyServer(
          (_cursor, id) =>
            new Response(
              `{"jsonrpc":"2.0","id":${id},"result":{"tools":[]},"pad":"${"x".repeat(4 * 1024 * 1024)}"}`,
              { headers: { "content-type": "application/json" } },
            ),
        ),
      );

      const exit = yield* listUpstreamTools(SOURCE, SECRET).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.exit,
      );

      assert.strictEqual(failureOf(exit)?.reason, "too_large");
    }),
  );

  it.effect("refuses a list of more than 50 pages", () =>
    Effect.gen(function* () {
      const { sent, client } = stub(
        legacyServer((cursor, id) =>
          reply(id, {
            tools: [{ name: `t${cursor ?? 0}` }],
            nextCursor: `${Number(cursor ?? 0) + 1}`,
          }),
        ),
      );

      const exit = yield* listUpstreamTools(SOURCE, SECRET).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.exit,
      );

      assert.strictEqual(failureOf(exit)?.reason, "too_large");
      assert.strictEqual(sent.filter((request) => request.rpc === "tools/list").length, 50);
    }),
  );

  it.effect("fails a listing that outlasts its budget", () =>
    Effect.gen(function* () {
      const client = HttpClient.make(() => Effect.never);

      const fiber = yield* listUpstreamTools(SOURCE, SECRET, "20 seconds").pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.exit,
        Effect.forkChild,
      );

      yield* TestClock.adjust("19 seconds");
      assert.isUndefined(fiber.pollUnsafe());

      yield* TestClock.adjust("1 second");
      const failure = failureOf(yield* Fiber.join(fiber));

      assert.strictEqual(failure?.reason, "unreachable");
      assert.strictEqual(failure?.message, "the MCP server did not answer in time");
    }),
  );

  it.effect("gives an interactive listing 60 seconds by default", () =>
    Effect.gen(function* () {
      const client = HttpClient.make(() => Effect.never);

      const fiber = yield* listUpstreamTools(SOURCE, SECRET).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.exit,
        Effect.forkChild,
      );

      yield* TestClock.adjust("59 seconds");
      assert.isUndefined(fiber.pollUnsafe());

      yield* TestClock.adjust("1 second");
      assert.strictEqual(failureOf(yield* Fiber.join(fiber))?.reason, "unreachable");
    }),
  );
});
