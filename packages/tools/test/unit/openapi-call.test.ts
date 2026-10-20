// A call of an OpenAPI tool (`src/openapi/request.ts` and the shared HTTP-call module `src/http/call.ts`, #203)
// against a stub upstream: the request has the right method, path, query, headers, cookies and body, the credential
// goes where each security scheme says, and the answer becomes a tool result (JSON pretty-printed, errors `isError`,
// oversize answers cut, binary described, redirects to another origin not followed).
import { assert, describe, it } from "@effect/vitest";
import { Effect, Predicate, Result, type Schema } from "effect";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http";
import type { UpstreamSecret } from "../../src/toolkits/secret.ts";
import { callHttp, MAX_ANSWER_BYTES } from "../../src/http/call.ts";
import { operationCall } from "../../src/openapi/request.ts";
import { openApiToolList } from "../../src/openapi/tools.ts";
import petstore from "../fixtures/openapi/petstore-3.0.yaml?raw";
import widgets from "../fixtures/openapi/widgets-3.1.json?raw";

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

/** A stub upstream: records each request and answers it with `answer`. */
const upstream = (answer: (sent: Sent) => Response = () => Response.json({ ok: true })) => {
  const sent: Array<Sent> = [];

  const client = HttpClient.make((request, url) => {
    const recorded = {
      method: request.method,
      url,
      headers: request.headers,
      body: bodyText(request),
    };

    sent.push(recorded);

    return Effect.succeed(HttpClientResponse.fromWeb(request, answer(recorded)));
  });

  return { sent, client };
};

const operationOf = (document: string, name: string) => {
  const list = openApiToolList(document, undefined);

  if (Result.isFailure(list)) throw new Error(list.failure);
  const operation = list.success.tools.find((tool) => tool.name === name)?.operation;

  if (operation === undefined) throw new Error(`no operation ${name}`);

  return operation;
};

/** Calls the operation `name` of `document` with `args` and `secret` against `stub`. */
const call = (
  stub: ReturnType<typeof upstream>,
  document: string,
  name: string,
  args: Schema.JsonObject,
  secret: UpstreamSecret = { kind: "none" },
  baseUrl?: string,
) =>
  Effect.gen(function* () {
    const operation = operationOf(document, name);
    const request = operationCall(operation, baseUrl, args);

    if (Result.isFailure(request)) return yield* Effect.die(request.failure);

    const { result } = yield* callHttp(request.success, secret, operation.security).pipe(
      Effect.provideService(HttpClient.HttpClient, stub.client),
    );

    return result;
  });

const textOf = (result: Schema.JsonObject): string => {
  // SAFETY: a tool result of callHttp has one text content.
  const [content] = result["content"] as ReadonlyArray<{ readonly text: string }>;

  return content?.text ?? "";
};

describe("the request an operation makes", () => {
  it.effect("puts query, header and path parameters where they go", () =>
    Effect.gen(function* () {
      const stub = upstream();

      yield* call(stub, petstore, "listPets", {
        limit: 5,
        tags: ["a", "b"],
        "X-Request-Id": "req-1",
      });

      const [sent] = stub.sent;

      assert.strictEqual(sent?.method, "GET");
      assert.strictEqual(
        `${sent?.url.origin}${sent?.url.pathname}`,
        "https://petstore.example.com/v1/pets",
      );
      assert.deepStrictEqual(
        [...(sent?.url.searchParams ?? [])],
        [
          ["limit", "5"],
          ["tags", "a,b"],
        ],
      );
      assert.strictEqual(sent?.headers["x-request-id"], "req-1");
      assert.strictEqual(sent?.headers["user-agent"], "commissary");
    }),
  );

  it.effect(
    "sends the header and cookie parameters of an operation named by its method and path",
    () =>
      Effect.gen(function* () {
        const stub = upstream();

        yield* call(
          stub,
          widgets,
          "GET /widgets/{id}/history",
          { id: "w1", "X-Trace": "0123456789abcdef", session: "s 1" },
          { kind: "bearer", token: "bt" },
        );

        const [sent] = stub.sent;

        assert.strictEqual(
          sent?.url.toString(),
          "https://eu.widgets.example.com/api/widgets/w1/history",
        );
        assert.strictEqual(sent?.headers["x-trace"], "0123456789abcdef");
        assert.strictEqual(sent?.headers["cookie"], "session=s%201");
        assert.strictEqual(sent?.headers["authorization"], "Bearer bt");
      }),
  );

  it.effect("sends a path parameter, a cookie and a JSON body", () =>
    Effect.gen(function* () {
      const stub = upstream();

      yield* call(stub, petstore, "updatePet", {
        petId: 7,
        session: "s 1",
        body: { name: "Rex", tag: null },
      });

      const [sent] = stub.sent;

      assert.strictEqual(sent?.method, "PATCH");
      assert.strictEqual(sent?.url.pathname, "/v1/pets/7");
      assert.strictEqual(sent?.headers["cookie"], "session=s%201");
      assert.strictEqual(sent?.headers["content-type"], "application/json");
      assert.deepStrictEqual(JSON.parse(sent?.body ?? ""), { name: "Rex", tag: null });
    }),
  );

  it.effect(
    "encodes a form body's nested values in brackets, and a deepObject query parameter",
    () =>
      Effect.gen(function* () {
        const stub = upstream();

        yield* call(stub, widgets, "createWidget", {
          body: { name: "w", size: 3, metadata: { color: "red" } },
        });
        yield* call(stub, widgets, "listWidgets", { filter_name_: "big", page: { size: 10 } });

        const [form, list] = stub.sent;

        assert.strictEqual(form?.url.toString(), "https://eu.widgets.example.com/api/widgets");
        assert.strictEqual(form?.headers["content-type"], "application/x-www-form-urlencoded");
        assert.deepStrictEqual(
          [...new URLSearchParams(form?.body ?? "")],
          [
            ["name", "w"],
            ["size", "3"],
            ["metadata[color]", "red"],
          ],
        );
        assert.deepStrictEqual(
          [...(list?.url.searchParams ?? [])],
          [
            ["filter[name]", "big"],
            ["page[size]", "10"],
          ],
        );
      }),
  );

  it("is refused before anything is sent when a required argument is missing, or there is no server", () => {
    assert.deepStrictEqual(
      operationCall(operationOf(petstore, "showPetById"), undefined, {}),
      Result.fail("the argument petId is required"),
    );

    const relative = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Relative", version: "1" },
      paths: { "/ping": { get: { operationId: "ping" } } },
    });

    assert.isTrue(Result.isFailure(operationCall(operationOf(relative, "ping"), undefined, {})));
    // A base URL, an org admin's, goes before the path.
    assert.deepStrictEqual(
      Result.map(
        operationCall(operationOf(relative, "ping"), "https://api.example.com/v2/", {}),
        (request) => request.url,
      ),
      Result.succeed("https://api.example.com/v2/ping"),
    );
  });
});

describe("the credential, as the document's security schemes say", () => {
  it.effect("an API key in a header: a header key of its name, or any token", () =>
    Effect.gen(function* () {
      const stub = upstream();

      yield* call(
        stub,
        petstore,
        "showPetById",
        { petId: 1 },
        {
          kind: "header",
          name: "x-api-key",
          value: "k1",
        },
      );
      yield* call(stub, petstore, "showPetById", { petId: 1 }, { kind: "bearer", token: "k2" });

      assert.deepStrictEqual(
        stub.sent.map((sent) => [sent.headers["x-api-key"], sent.headers["authorization"]]),
        [
          ["k1", undefined],
          ["k2", undefined],
        ],
      );
    }),
  );

  it.effect(
    "an API key in the query or a cookie, HTTP basic and bearer, and an OAuth 2 token",
    () =>
      Effect.gen(function* () {
        const stub = upstream();

        yield* call(
          stub,
          widgets,
          "getWidget",
          { id: "a/b", query_id: "q" },
          {
            kind: "query",
            name: "key",
            value: "qk",
          },
        );
        yield* call(stub, widgets, "archiveWidget", { id: "w1" }, { kind: "bearer", token: "ck" });
        yield* call(
          stub,
          widgets,
          "createWidget",
          { body: { name: "w" } },
          {
            kind: "basic",
            username: "ann",
            password: "pw",
          },
        );
        yield* call(stub, widgets, "listWidgets", {}, { kind: "bearer", token: "bt" });
        yield* call(stub, widgets, "replaceWidget", { id: "w1" }, { kind: "bearer", token: "ot" });

        const [query, cookie, basic, bearer, oauth] = stub.sent;

        assert.strictEqual(query?.url.pathname, "/api/widgets/a%2Fb");
        assert.deepStrictEqual(
          [...(query?.url.searchParams ?? [])],
          [
            ["id", "q"],
            ["key", "qk"],
          ],
        );
        assert.strictEqual(cookie?.method, "POST");
        assert.strictEqual(cookie?.headers["cookie"], "sid=ck");
        assert.strictEqual(cookie?.headers["authorization"], undefined);
        assert.strictEqual(basic?.headers["authorization"], `Basic ${btoa("ann:pw")}`);
        assert.strictEqual(bearer?.headers["authorization"], "Bearer bt");
        assert.strictEqual(oauth?.headers["authorization"], "Bearer ot");
        assert.strictEqual(oauth?.method, "PUT");
      }),
  );

  it.effect(
    "none for an operation that asks for none; as connected for a document with no schemes",
    () =>
      Effect.gen(function* () {
        const stub = upstream(() => new Response(null, { status: 200 }));

        const plain = JSON.stringify({
          openapi: "3.1.0",
          info: { title: "Plain", version: "1" },
          servers: [{ url: "https://plain.example.com" }],
          paths: { "/ping": { get: { operationId: "ping" } } },
        });

        const result = yield* call(stub, widgets, "status", {}, { kind: "bearer", token: "bt" });

        yield* call(stub, plain, "ping", {}, { kind: "header", name: "X-Token", value: "pt" });

        const [status, ping] = stub.sent;

        assert.strictEqual(status?.method, "HEAD");
        assert.strictEqual(status?.headers["authorization"], undefined);
        assert.strictEqual(textOf(result), "HTTP 200: no content");
        assert.strictEqual(ping?.headers["x-token"], "pt");
      }),
  );
});

describe("the answer", () => {
  it.effect("is JSON pretty-printed as text", () =>
    Effect.gen(function* () {
      const stub = upstream(() => Response.json({ id: 1, name: "Rex" }));
      const result = yield* call(stub, petstore, "showPetById", { petId: 1 });

      assert.deepStrictEqual(result, {
        content: [{ type: "text", text: '{\n  "id": 1,\n  "name": "Rex"\n}' }],
      });
    }),
  );

  it.effect("is an error with the status and the body for a 4xx or 5xx", () =>
    Effect.gen(function* () {
      const stub = upstream(() => new Response("no such pet", { status: 404 }));
      const result = yield* call(stub, petstore, "showPetById", { petId: 9 });

      assert.deepStrictEqual(result, {
        content: [{ type: "text", text: "HTTP 404\n\nno such pet" }],
        isError: true,
      });
    }),
  );

  it.effect("is cut when it is too large, and says so", () =>
    Effect.gen(function* () {
      const stub = upstream(
        () =>
          new Response("x".repeat(MAX_ANSWER_BYTES * 3), {
            headers: {
              "content-type": "text/plain",
              "content-length": String(MAX_ANSWER_BYTES * 3),
            },
          }),
      );

      const text = textOf(yield* call(stub, petstore, "showPetById", { petId: 1 }));

      assert.isTrue(text.startsWith("x".repeat(MAX_ANSWER_BYTES)));
      assert.isFalse(text.startsWith("x".repeat(MAX_ANSWER_BYTES + 1)));
      assert.include(
        text,
        `[Commissary cut this answer at ${MAX_ANSWER_BYTES} bytes of ${MAX_ANSWER_BYTES * 3}.`,
      );
    }),
  );

  it.effect("is described, not inlined, when it is binary", () =>
    Effect.gen(function* () {
      const stub = upstream(
        () =>
          new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
            headers: { "content-type": "image/png", "content-length": "4" },
          }),
      );

      const text = textOf(yield* call(stub, petstore, "showPetById", { petId: 1 }));

      assert.strictEqual(
        text,
        "The answer is binary (image/png, 4 bytes); Commissary does not show it.",
      );
    }),
  );

  it.effect(
    "follows a redirect on its origin, and not one to another origin, where the key would go",
    () =>
      Effect.gen(function* () {
        // The first hop redirects on its origin, the second to another origin, with a credential in its query.
        const hops = new Map([
          ["/v1/pets/1", { status: 302, location: "/v1/pets/one" }],
          [
            "/v1/pets/one",
            { status: 307, location: "https://elsewhere.example.com/x?code=sign-in-code#frag" },
          ],
        ]);

        const stub = upstream((sent) => {
          const hop = hops.get(sent.url.pathname);

          return hop === undefined
            ? Response.json({})
            : new Response(null, { status: hop.status, headers: { location: hop.location } });
        });

        const result = yield* call(
          stub,
          petstore,
          "showPetById",
          { petId: 1 },
          {
            kind: "header",
            name: "X-API-Key",
            value: "secret",
          },
        );

        assert.deepStrictEqual(
          stub.sent.map((sent) => sent.url.toString()),
          ["https://petstore.example.com/v1/pets/1", "https://petstore.example.com/v1/pets/one"],
        );
        // The result names where the redirect led, without its query.
        assert.strictEqual(
          textOf(result),
          "HTTP 307, redirected to https://elsewhere.example.com/x: no content",
        );
        assert.notInclude(textOf(result), "sign-in-code");
      }),
  );
});
