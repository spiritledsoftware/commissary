// A call of a Discovery tool (`src/discovery/tools.ts` with `src/openapi/request.ts` and the shared HTTP-call module
// `src/http/call.ts`, #205) against a stub upstream: the URL is the method's path under rootUrl and servicePath, with a
// `{+name}` parameter's slashes kept but no `.` or `..` segment and its pattern matched; repeated query parameters
// repeat; the request body is JSON; and the credential is an API key in the `key` query parameter or an OAuth 2 token
// as a bearer token.
import { assert, describe, it } from "@effect/vitest";
import { Effect, Predicate, Result, type Schema } from "effect";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http";
import { discoveryToolList } from "../../src/discovery/tools.ts";
import { callHttp } from "../../src/http/call.ts";
import { operationCall } from "../../src/openapi/request.ts";
import type { UpstreamSecret } from "../../src/toolkits/secret.ts";
import gmail from "../fixtures/discovery/gmail-v1.json?raw";

interface Sent {
  readonly method: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
}

const bodyText = (request: HttpClientRequest.HttpClientRequest): string | undefined =>
  Predicate.isTagged(request.body, "Uint8Array")
    ? new TextDecoder().decode(request.body.body)
    : undefined;

/** A stub upstream: records each request and answers `{}`. */
const upstream = () => {
  const sent: Array<Sent> = [];

  const client = HttpClient.make((request, url) => {
    sent.push({ method: request.method, url, headers: request.headers, body: bodyText(request) });

    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({})));
  });

  return { sent, client };
};

/** The operation of the method `name` of `document`. */
const operationOf = (document: string, name: string) => {
  const list = discoveryToolList(document);

  if (Result.isFailure(list)) throw new Error(list.failure);
  const operation = list.success.tools.find((tool) => tool.name === name)?.operation;

  if (operation === undefined) throw new Error(`no tool ${name}`);

  return operation;
};

/** A document of one method, `example.operations.get`, whose path is `v1/{+name}` with `pattern`. */
const reservedDocument = (pattern?: string) =>
  JSON.stringify({
    kind: "discovery#restDescription",
    discoveryVersion: "v1",
    rootUrl: "https://example.googleapis.com/",
    servicePath: "",
    resources: {
      operations: {
        methods: {
          get: {
            id: "example.operations.get",
            httpMethod: "GET",
            path: "v1/{+name}",
            parameters: {
              name: {
                location: "path",
                type: "string",
                required: true,
                ...(pattern === undefined ? {} : { pattern }),
              },
            },
          },
        },
      },
    },
  });

/** Calls the method `name` of `document` with `args` and `secret` against `stub`, and answers what it sent. */
const call = (
  document: string,
  name: string,
  args: Schema.JsonObject,
  secret: UpstreamSecret = { kind: "none" },
) =>
  Effect.gen(function* () {
    const operation = operationOf(document, name);
    const request = operationCall(operation, undefined, args);

    if (Result.isFailure(request)) return yield* Effect.die(request.failure);
    const stub = upstream();

    yield* callHttp(request.success, secret, operation.security).pipe(
      Effect.provideService(HttpClient.HttpClient, stub.client),
    );

    const [sent] = stub.sent;

    return sent ?? (yield* Effect.die("nothing was sent"));
  });

describe("a Discovery tool's call", () => {
  it.effect(
    "builds the URL from rootUrl and the method's path, repeats a repeated parameter, and sends an API key as key",
    () =>
      Effect.gen(function* () {
        const sent = yield* call(
          gmail,
          "gmail.users.messages.list",
          { userId: "me", labelIds: ["INBOX", "UNREAD"], maxResults: 10, q: "from:a b" },
          { kind: "query", name: "key", value: "api-key" },
        );

        assert.strictEqual(sent.method, "GET");
        assert.strictEqual(
          `${sent.url.origin}${sent.url.pathname}`,
          "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        );
        assert.deepStrictEqual(
          [...sent.url.searchParams],
          [
            ["q", "from:a b"],
            ["maxResults", "10"],
            ["labelIds", "INBOX"],
            ["labelIds", "UNREAD"],
            ["key", "api-key"],
          ],
        );
        assert.isUndefined(sent.headers["authorization"]);
      }),
  );

  it.effect("sends the request body as JSON and an OAuth 2 token as a bearer token", () =>
    Effect.gen(function* () {
      const sent = yield* call(
        gmail,
        "gmail.users.messages.send",
        { userId: "me", body: { raw: "UmF3", threadId: "t1" } },
        { kind: "bearer", token: "ya29.token" },
      );

      assert.strictEqual(sent.method, "POST");
      assert.strictEqual(
        sent.url.toString(),
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      );
      assert.strictEqual(sent.headers["authorization"], "Bearer ya29.token");
      assert.strictEqual(sent.headers["content-type"], "application/json");
      assert.deepStrictEqual(JSON.parse(sent.body ?? ""), { raw: "UmF3", threadId: "t1" });
    }),
  );

  it.effect("puts an API key connected under another name in key", () =>
    Effect.gen(function* () {
      const sent = yield* call(
        gmail,
        "gmail.users.labels.list",
        { userId: "me" },
        { kind: "header", name: "x-goog-api-key", value: "api-key" },
      );

      assert.strictEqual(sent.url.searchParams.get("key"), "api-key");
      assert.isUndefined(sent.headers["x-goog-api-key"]);
    }),
  );

  it.effect("keeps a {+name} parameter's slashes, under servicePath", () =>
    Effect.gen(function* () {
      const document = JSON.stringify({
        kind: "discovery#restDescription",
        discoveryVersion: "v1",
        rootUrl: "https://example.googleapis.com/",
        servicePath: "",
        resources: {
          operations: {
            methods: {
              cancel: {
                id: "example.operations.cancel",
                httpMethod: "POST",
                path: "v1/{+name}:cancel",
                parameters: { name: { location: "path", type: "string", required: true } },
              },
            },
          },
        },
      });

      const sent = yield* call(document, "example.operations.cancel", {
        name: "projects/p 1/operations/o%2F1",
      });

      assert.strictEqual(
        sent.url.toString(),
        "https://example.googleapis.com/v1/projects/p%201/operations/o%2F1:cancel",
      );
    }),
  );

  it("refuses a {+name} value with a . or .. segment, %2e included, before anything is sent", () => {
    const operation = operationOf(reservedDocument(), "example.operations.get");

    for (const name of [
      "projects/p/../../v2/secrets",
      "..",
      "projects/./p",
      "projects/p/%2e%2E/x",
      "projects/p/%2E",
      "projects/p/.%2e",
    ])
      assert.deepStrictEqual(
        operationCall(operation, undefined, { name }),
        Result.fail("the argument name cannot be or hold a . or .. path segment"),
        name,
      );

    // Dots inside a segment are a name's own.
    assert.isTrue(
      Result.isSuccess(operationCall(operation, undefined, { name: "projects/p.v2/ops/..x" })),
    );
  });

  it("refuses a {+name} value its parameter's pattern does not match", () => {
    const operation = operationOf(
      reservedDocument("^projects/[^/]+/operations/[^/]+$"),
      "example.operations.get",
    );

    assert.deepStrictEqual(
      Result.map(
        operationCall(operation, undefined, { name: "projects/p/operations/o" }),
        (request) => request.url,
      ),
      Result.succeed("https://example.googleapis.com/v1/projects/p/operations/o"),
    );
    assert.deepStrictEqual(
      operationCall(operation, undefined, { name: "projects/p/secrets/s" }),
      Result.fail("the argument name does not match ^projects/[^/]+/operations/[^/]+$"),
    );
  });
});
