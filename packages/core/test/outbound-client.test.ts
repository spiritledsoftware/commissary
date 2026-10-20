// The outbound guard around an HttpClient: every hop of a redirect is checked, with a small hop limit; and a caller that
// follows same-origin redirects only (`executeSameOriginRedirects`), so a credential never reaches another origin.
import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Exit, Match, Option, Stream } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  type HttpClientError,
} from "effect/http";
import {
  CurrentOutboundPolicy,
  executeSameOriginRedirects,
  guardHttpClient,
  MAX_OUTBOUND_REDIRECTS,
  outboundPolicy,
  outboundRefusalOf,
  OUTBOUND_REFUSED_MESSAGE,
} from "../src/index.ts";

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly redirect: string | undefined;
  readonly authorization: string | undefined;
  readonly body: string;
}

const bodyOf = (request: HttpClientRequest.HttpClientRequest): string =>
  Match.value(request.body).pipe(
    Match.tag("Uint8Array", (body) => new TextDecoder().decode(body.body)),
    Match.tag("Stream", () => "<stream>"),
    Match.orElse(() => ""),
  );

/** A fake upstream: `answer` maps each URL to a response; every request it receives is recorded. */
const upstream = (answer: (url: URL) => Response) => {
  const sent: Array<Sent> = [];

  const client = HttpClient.make((request, url, _signal, fiber) => {
    sent.push({
      method: request.method,
      url: url.href,
      redirect: Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit)?.redirect,
      authorization: request.headers["authorization"],
      body: bodyOf(request),
    });

    return Effect.succeed(HttpClientResponse.fromWeb(request, answer(url)));
  });

  return { sent, client: guardHttpClient(client) };
};

const redirect = (location: string, status = 302) =>
  new Response(null, { status, headers: { location } });

/** The guard's refusal a failed request carries, if any. */
const refusalOf = <A>(exit: Exit.Exit<A, HttpClientError.HttpClientError>) =>
  outboundRefusalOf(
    Exit.isFailure(exit) ? Option.getOrUndefined(Exit.findErrorOption(exit)) : undefined,
  );

/** `path` answers a redirect to `/next` with `status`; `/next` answers 200. */
const redirectOnce = (status: number) =>
  upstream((url) => (url.pathname === "/next" ? new Response("done") : redirect("/next", status)));

const sentLines = (sent: ReadonlyArray<Sent>) =>
  sent.map((request) => `${request.method} ${new URL(request.url).pathname} ${request.body}`);

describe("guardHttpClient", () => {
  it.effect("sends a public https: request with redirects handled by the guard", () =>
    Effect.gen(function* () {
      const { sent, client } = upstream(() => new Response("ok"));

      yield* client.get("https://api.example.com/v1/models");

      expect(sent).toEqual([
        {
          method: "GET",
          url: "https://api.example.com/v1/models",
          redirect: "manual",
          authorization: undefined,
          body: "",
        },
      ]);
    }),
  );

  it.effect("refuses a refused first hop without sending anything", () =>
    Effect.gen(function* () {
      const { sent, client } = upstream(() => new Response("ok"));

      const exit = yield* Effect.exit(client.get("http://api.example.com/v1/models"));

      expect(sent).toEqual([]);
      expect(refusalOf(exit)?.reason).toBe("scheme");
      expect(refusalOf(exit)?.message).toBe(OUTBOUND_REFUSED_MESSAGE);
    }),
  );

  it.effect("follows a redirect to a public address, checking it", () =>
    Effect.gen(function* () {
      const { sent, client } = upstream((url) =>
        url.hostname === "old.example.com"
          ? redirect("https://new.example.com/v1/models")
          : new Response("moved here"),
      );

      const text = yield* client
        .get("https://old.example.com/v1/models")
        .pipe(Effect.flatMap((response) => response.text));

      expect(text).toBe("moved here");
      expect(sent.map((request) => request.url)).toEqual([
        "https://old.example.com/v1/models",
        "https://new.example.com/v1/models",
      ]);
    }),
  );

  it.effect("refuses a redirect to a refused address and never sends it", () =>
    Effect.gen(function* () {
      const { sent, client } = upstream(() =>
        redirect("https://169.254.169.254/latest/meta-data/"),
      );

      const exit = yield* Effect.exit(client.get("https://api.example.com/v1"));

      expect(sent.map((request) => request.url)).toEqual(["https://api.example.com/v1"]);
      expect(refusalOf(exit)?.reason).toBe("address");
    }),
  );

  it.effect("refuses a relative redirect onto an own host", () =>
    Effect.gen(function* () {
      const { client } = upstream((url) =>
        url.hostname === "api.example.com" ? redirect("https://app.example.com/") : new Response(),
      );

      const exit = yield* Effect.exit(
        client
          .get("https://api.example.com/v1")
          .pipe(
            Effect.provideService(
              CurrentOutboundPolicy,
              outboundPolicy({ hosts: ["app.example.com"] }),
            ),
          ),
      );

      expect(refusalOf(exit)?.reason).toBe("own_host");
    }),
  );

  it.effect("refuses more than the hop limit", () =>
    Effect.gen(function* () {
      let hop = 0;

      const { sent, client } = upstream(() => {
        hop += 1;

        return redirect(`/hop/${hop}`);
      });

      const exit = yield* Effect.exit(client.get("https://api.example.com/start"));

      expect(refusalOf(exit)?.reason).toBe("too_many_redirects");
      expect(sent).toHaveLength(MAX_OUTBOUND_REDIRECTS + 1);
    }),
  );

  it.effect("cancels every redirect hop's body without reading it, the refused last hop too", () =>
    Effect.gen(function* () {
      let pulls = 0;
      let cancels = 0;

      // A hop whose body never arrives: reading it would stall the request.
      const stalledBody = () =>
        new ReadableStream<Uint8Array>(
          {
            pull: () => {
              pulls += 1;

              return new Promise<void>(() => {});
            },
            cancel: () => {
              cancels += 1;
            },
          },
          { highWaterMark: 0 },
        );

      let hop = 0;

      const { client } = upstream(() => {
        hop += 1;

        return new Response(stalledBody(), { status: 302, headers: { location: `/hop/${hop}` } });
      });

      const exit = yield* Effect.exit(client.get("https://api.example.com/start"));

      expect(refusalOf(exit)?.reason).toBe("too_many_redirects");
      expect(pulls).toBe(0);
      expect(cancels).toBe(MAX_OUTBOUND_REDIRECTS + 1);
    }),
  );

  it.effect("turns a PUT answered 303 into a bodiless GET", () =>
    Effect.gen(function* () {
      const { sent, client } = redirectOnce(303);

      yield* client.execute(
        HttpClientRequest.put("https://api.example.com/a").pipe(HttpClientRequest.bodyText("{}")),
      );

      expect(sentLines(sent)).toEqual(["PUT /a {}", "GET /next "]);
    }),
  );

  it.effect("keeps a POST and its body on 307", () =>
    Effect.gen(function* () {
      const { sent, client } = redirectOnce(307);

      yield* client.execute(
        HttpClientRequest.post("https://api.example.com/a").pipe(
          HttpClientRequest.bodyText('{"q":1}'),
        ),
      );

      expect(sentLines(sent)).toEqual(['POST /a {"q":1}', 'POST /next {"q":1}']);
    }),
  );

  it.effect("does not follow a 307 that would have to send a streamed body again", () =>
    Effect.gen(function* () {
      const { sent, client } = redirectOnce(307);

      const response = yield* client.execute(
        HttpClientRequest.post("https://api.example.com/a").pipe(
          HttpClientRequest.bodyStream(Stream.make(new TextEncoder().encode("{}"))),
        ),
      );

      expect(response.status).toBe(307);
      expect(sentLines(sent)).toEqual(["POST /a <stream>"]);
    }),
  );

  it.effect("drops the Authorization header on a redirect to another origin", () =>
    Effect.gen(function* () {
      const { sent, client } = upstream((url) =>
        url.hostname === "api.example.com"
          ? redirect("https://cdn.example.net/file")
          : new Response("file"),
      );

      yield* client.execute(
        HttpClientRequest.get("https://api.example.com/file").pipe(
          HttpClientRequest.bearerToken("secret"),
        ),
      );

      expect(sent.map((request) => request.authorization)).toEqual(["Bearer secret", undefined]);
    }),
  );

  it.effect(
    "leaves a caller's own manual redirects to the caller, checking the first hop only",
    () =>
      Effect.gen(function* () {
        const { sent, client } = upstream(() => redirect("http://10.0.0.1/"));

        const response = yield* client
          .get("https://api.example.com/v1")
          .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));

        expect(response.status).toBe(302);
        expect(sent).toHaveLength(1);
      }),
  );
});

describe("executeSameOriginRedirects", () => {
  it.effect("follows redirects on the request's origin and answers one to another origin", () =>
    Effect.gen(function* () {
      const { sent, client } = upstream((url) =>
        url.pathname === "/a" ? redirect("/b") : redirect("https://other.example.com/c?code=1"),
      );

      const response = yield* executeSameOriginRedirects(
        client,
        HttpClientRequest.get("https://api.example.com/a").pipe(
          HttpClientRequest.setHeader("x-api-key", "secret"),
        ),
      );

      expect(response.status).toBe(302);
      expect(response.headers["location"]).toBe("https://other.example.com/c?code=1");
      // Each hop its own request, with the caller's manual redirects, never to the other origin.
      expect(sent.map((request) => [request.url, request.redirect])).toEqual([
        ["https://api.example.com/a", "manual"],
        ["https://api.example.com/b", "manual"],
      ]);
    }),
  );

  it.effect("answers the redirect past the hop limit, and checks each hop", () =>
    Effect.gen(function* () {
      let hop = 0;

      const { sent, client } = upstream(() => {
        hop += 1;

        return redirect(`/hop/${hop}`);
      });

      const response = yield* executeSameOriginRedirects(
        client,
        HttpClientRequest.get("https://api.example.com/start"),
      );

      expect(response.status).toBe(302);
      expect(sent).toHaveLength(MAX_OUTBOUND_REDIRECTS + 1);

      const refused = yield* Effect.exit(
        executeSameOriginRedirects(client, HttpClientRequest.get("https://10.0.0.1/start")),
      );

      expect(refusalOf(refused)?.reason).toBe("address");
    }),
  );
});

describe("outboundPolicy", () => {
  it("collects own hosts from hosts, origins and comma separated lists", () => {
    expect(
      outboundPolicy({
        hosts: ["example.com, app.example.com", "https://auth.example.com", undefined, ""],
        requestUrl: "https://api.example.com/v1/models",
      }),
    ).toEqual({
      ownHosts: ["example.com", "app.example.com", "auth.example.com", "api.example.com"],
      localDevelopment: false,
    });
  });

  it("refuses every Worker of the account on a workers.dev request host", () => {
    expect(
      outboundPolicy({ hosts: [], requestUrl: "https://commissary-api-pr-7.acct.workers.dev/v1" })
        .ownHosts,
    ).toEqual(["commissary-api-pr-7.acct.workers.dev", "*.acct.workers.dev"]);
  });

  it("is local development when the request came to a loopback host, which is then no own host", () => {
    expect(outboundPolicy({ hosts: [], requestUrl: "http://localhost:1339/v1" })).toEqual({
      ownHosts: [],
      localDevelopment: true,
    });
    expect(outboundPolicy({ hosts: [] }).localDevelopment).toBe(false);
  });
});
