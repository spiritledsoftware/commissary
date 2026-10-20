// A call of a GraphQL tool (`src/graphql/request.ts` and the shared HTTP-call module `src/http/call.ts`, #204) against
// a stub endpoint: the request is one POST of a valid document with variables (the default selection, or the caller's,
// checked against the schema and refused before anything is sent when it does not check out; a root connection's page
// size LIST_CAP when the call names none), and the answer maps to a tool result: errors without data an error, partial
// data both. The schema a part keeps built for those checks (`SchemaCache`) is built once per toolkit and list.
import { assert, describe, it } from "@effect/vitest";
import { buildSchema, parse, validate } from "graphql";
import { Effect, Predicate, Result, type Schema } from "effect";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http";
import { callHttp } from "../../src/http/call.ts";
import { graphQLAnswer, graphQLCall, MAX_SELECTION_BYTES } from "../../src/graphql/request.ts";
import { graphQLToolList, LIST_CAP, SchemaCache, storedSchema } from "../../src/graphql/schema.ts";
import type { UpstreamSecret } from "../../src/toolkits/secret.ts";
import tracker from "../fixtures/graphql/tracker.graphql?raw";

const ENDPOINT = "https://tracker.example.com/graphql";

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: { readonly query: string; readonly variables: Schema.JsonObject };
}

/** A stub endpoint: records each request and answers it with `answer`. */
const upstream = (answer: () => Response = () => Response.json({ data: { ok: true } })) => {
  const sent: Array<Sent> = [];

  const client = HttpClient.make((request: HttpClientRequest.HttpClientRequest, url) => {
    const body = Predicate.isTagged(request.body, "Uint8Array")
      ? new TextDecoder().decode(request.body.body)
      : "{}";

    sent.push({
      method: request.method,
      url: url.toString(),
      headers: request.headers,
      // SAFETY: a GraphQL call's body is the JSON of its query and variables.
      body: JSON.parse(body) as Sent["body"],
    });

    return Effect.succeed(HttpClientResponse.fromWeb(request, answer()));
  });

  return { sent, client };
};

const list = graphQLToolList({ sdl: tracker });

if (Result.isFailure(list)) throw new Error(list.failure);

const { tools, schema: sdl } = list.success;

const operationOf = (name: string) => {
  const operation = tools.find((tool) => tool.name === name)?.graphql;

  if (operation === undefined) throw new Error(`no tool ${name}`);

  return operation;
};

/** Calls the tool `name` with `args` and `secret` against `stub`; a request that cannot be made fails with why. */
const call = (
  stub: ReturnType<typeof upstream>,
  name: string,
  args: Schema.JsonObject,
  secret: UpstreamSecret = { kind: "none" },
) =>
  Effect.gen(function* () {
    const request = graphQLCall(operationOf(name), ENDPOINT, args, () => storedSchema(sdl));

    if (Result.isFailure(request)) return yield* Effect.fail(request.failure);

    return yield* callHttp(request.success, secret, undefined, { reading: graphQLAnswer }).pipe(
      Effect.map(({ result }) => result),
      Effect.provideService(HttpClient.HttpClient, stub.client),
    );
  });

const textOf = (result: Schema.JsonObject): string => {
  // SAFETY: a tool result of callHttp has one text content.
  const [content] = result["content"] as ReadonlyArray<{ readonly text: string }>;

  return content?.text ?? "";
};

/** The validation errors of `document` against the fixture's schema. */
const errorsOf = (document: string) =>
  validate(buildSchema(tracker), parse(document)).map((error) => error.message);

describe("the request a GraphQL tool makes", () => {
  it.effect("is one POST of a valid document with the given arguments as variables", () =>
    Effect.gen(function* () {
      const stub = upstream();

      yield* call(
        stub,
        "query.issues",
        { project: "p1", first: 5 },
        { kind: "bearer", token: "t" },
      );

      const [sent] = stub.sent;

      assert.strictEqual(sent?.method, "POST");
      assert.strictEqual(sent?.url, ENDPOINT);
      assert.strictEqual(sent?.headers["authorization"], "Bearer t");
      assert.strictEqual(sent?.headers["content-type"], "application/json");
      assert.deepStrictEqual(sent?.body.variables, { project: "p1", first: 5 });
      assert.isTrue(
        sent?.body.query.startsWith(
          "query($project: ID!, $first: Int) {\n  issues(project: $project, first: $first) { pageInfo {",
        ),
      );
      assert.deepStrictEqual(errorsOf(sent?.body.query ?? ""), []);
    }),
  );

  it.effect("asks a root connection for LIST_CAP items when the call names no page size", () =>
    Effect.gen(function* () {
      const stub = upstream();

      yield* call(stub, "query.issues", { project: "p1" });

      const [sent] = stub.sent;

      assert.deepStrictEqual(sent?.body.variables, { project: "p1", first: LIST_CAP });
      assert.isTrue(
        sent?.body.query.startsWith(
          "query($project: ID!, $first: Int) {\n  issues(project: $project, first: $first) {",
        ),
      );
    }),
  );

  it.effect("selects a mutation's default selection, its input object one variable", () =>
    Effect.gen(function* () {
      const stub = upstream();
      const input = { project: "p1", title: "Broken", meta: { priority: 2 } };

      yield* call(stub, "mutation.createIssue", { input });

      const [sent] = stub.sent;

      assert.isTrue(
        sent?.body.query.startsWith(
          "mutation($input: CreateIssueInput!) {\n  createIssue(input: $input) { clientMutationId issue {",
        ),
      );
      assert.deepStrictEqual(sent?.body.variables, { input });
      assert.deepStrictEqual(errorsOf(sent?.body.query ?? ""), []);
    }),
  );

  it.effect("selects a scalar field without a selection set", () =>
    Effect.gen(function* () {
      const stub = upstream();

      yield* call(stub, "query.issueCount", {});

      assert.strictEqual(stub.sent[0]?.body.query, "query {\n  issueCount\n}");
    }),
  );

  it.effect("takes the caller's selection set, with or without its braces", () =>
    Effect.gen(function* () {
      const stub = upstream();

      yield* call(stub, "query.issue", { id: "i1", selection: "{ title author { login } }" });
      yield* call(stub, "query.issue", { id: "i1", selection: " title\n # a comment\n" });

      assert.deepStrictEqual(
        stub.sent.map((sent) => sent.body.query),
        [
          "query($id: ID!) {\n  issue(id: $id) { title author { login } }\n}",
          "query($id: ID!) {\n  issue(id: $id) { title\n # a comment\n}\n}",
        ],
      );
    }),
  );

  it.effect("is not made when a required argument or a good selection is missing", () =>
    Effect.gen(function* () {
      const stub = upstream();

      const refusals = yield* Effect.forEach(
        [
          [{}, "the call misses the required argument id"],
          [
            { id: "i1", selection: "{ title assignee }" },
            'the selection is not valid: Cannot query field "assignee" on type "Issue". Did you mean "assignees"?',
          ],
          [
            { id: "i1", selection: "{ author }" },
            'the selection is not valid: Field "author" of type "User" must have a selection of subfields. ' +
              'Did you mean "author { ... }"?',
          ],
          [
            { id: "i1", selection: '{ id } }\nmutation { closeIssue(id: "i1") { id } ' },
            "the selection is not one GraphQL selection set",
          ],
          [
            { id: "i1", selection: "{ id } other: viewer { id }" },
            "the selection is not one GraphQL selection set",
          ],
          [
            { id: "i1", selection: "@skip(if: true) { id }" },
            "the selection is not a GraphQL selection set",
          ],
          [{ id: "i1", selection: "{ id" }, "the selection is not a GraphQL selection set"],
          [{ id: "i1", selection: 5 }, "selection must be a GraphQL selection set, a string"],
          [
            { id: "i1", selection: `{ ${"id ".repeat(MAX_SELECTION_BYTES)} }` },
            `the selection is longer than ${MAX_SELECTION_BYTES} bytes`,
          ],
        ] as const,
        ([args, reason]) =>
          call(stub, "query.issue", args).pipe(
            Effect.flip,
            Effect.map((failure) => [failure, reason]),
          ),
      );

      for (const [failure, reason] of refusals) assert.strictEqual(failure, reason);
      assert.deepStrictEqual(stub.sent, []);
    }),
  );
});

/** A call of `query.issue` that the stub endpoint answers with `answer`. */
const answered = (answer: () => Response) => call(upstream(answer), "query.issue", { id: "i1" });

describe("a GraphQL answer", () => {
  it.effect("with data is a result holding it", () =>
    Effect.gen(function* () {
      const result = yield* answered(() => Response.json({ data: { issue: { id: "i1" } } }));

      assert.isUndefined(result["isError"]);
      assert.deepStrictEqual(JSON.parse(textOf(result)), { data: { issue: { id: "i1" } } });
    }),
  );

  it.effect("with errors and no data is an error result", () =>
    Effect.gen(function* () {
      const errors = [{ message: "Not found", path: ["issue"] }];

      for (const body of [{ errors }, { data: null, errors }]) {
        const result = yield* answered(() => Response.json(body));

        assert.strictEqual(result["isError"], true);
        assert.deepStrictEqual(JSON.parse(textOf(result)), body);
      }
    }),
  );

  it.effect("with partial data and errors is a result holding both", () =>
    Effect.gen(function* () {
      const body = {
        data: { issue: { id: "i1", author: null } },
        errors: [{ message: "Forbidden", path: ["issue", "author"] }],
      };

      const result = yield* answered(() => Response.json(body));

      assert.isUndefined(result["isError"]);
      assert.deepStrictEqual(JSON.parse(textOf(result)), body);
    }),
  );

  it.effect("with an HTTP error status is an error result, as any HTTP answer", () =>
    Effect.gen(function* () {
      const result = yield* answered(() =>
        Response.json(
          { errors: [{ message: "Syntax error" }] },
          { status: 400, headers: { "content-type": "application/graphql-response+json" } },
        ),
      );

      assert.strictEqual(result["isError"], true);
      assert.isTrue(textOf(result).startsWith("HTTP 400\n\n{"));
    }),
  );
});

describe("the schema a part keeps for selections", () => {
  it("is built once for a toolkit's list, again for another list or toolkit, and forgotten", () => {
    const cache = new SchemaCache();
    let reads = 0;

    const read = () => {
      reads += 1;

      return sdl;
    };

    const first = cache.schema("t1", 1, read);
    const again = cache.schema("t1", 1, read);

    assert.isTrue(Result.isSuccess(first) && Result.isSuccess(again));
    assert.strictEqual(Result.getOrThrow(first), Result.getOrThrow(again));
    assert.strictEqual(reads, 1);

    cache.schema("t1", 2, read);
    cache.schema("t2", 2, read);
    cache.schema("t1", 2, read);
    assert.strictEqual(reads, 4);

    cache.forget("t1");
    cache.schema("t1", 2, read);
    assert.strictEqual(reads, 5);

    assert.deepStrictEqual(
      cache.schema("t3", undefined, read),
      Result.fail("the toolkit has no schema to check the selection against: refresh it"),
    );
    assert.strictEqual(reads, 5);
  });
});
