// The outbound guard around an HttpClient: every hop of a redirect is checked, with a small hop limit.
import { Context, Effect, Exit, Option } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  type HttpClientError,
} from "effect/http";
import { describe, expect, it } from "vitest";
import {
  CurrentOutboundPolicy,
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
}

/** A fake upstream: `answer` maps each URL to a response; every request it receives is recorded. */
const upstream = (answer: (url: URL) => Response) => {
  const sent: Array<Sent> = [];

  const client = HttpClient.make((request, url, _signal, fiber) => {
    sent.push({
      method: request.method,
      url: url.href,
      redirect: Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit)?.redirect,
      authorization: request.headers["authorization"],
    });

    return Effect.succeed(HttpClientResponse.fromWeb(request, answer(url)));
  });

  return { sent, client: guardHttpClient(client) };
};

const redirect = (location: string, status = 302) =>
  new Response(null, { status, headers: { location } });

const run = <A>(effect: Effect.Effect<A, HttpClientError.HttpClientError>) =>
  Effect.runPromiseExit(effect);

const failureOf = <A>(exit: Exit.Exit<A, HttpClientError.HttpClientError>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Exit.findErrorOption(exit)) : undefined;

describe("guardHttpClient", () => {
  it("sends a public https: request with redirects handled by the guard", async () => {
    const { sent, client } = upstream(() => new Response("ok"));

    const exit = await run(client.get("https://api.example.com/v1/models"));

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(sent).toEqual([
      {
        method: "GET",
        url: "https://api.example.com/v1/models",
        redirect: "manual",
        authorization: undefined,
      },
    ]);
  });

  it("refuses a refused first hop without sending anything", async () => {
    const { sent, client } = upstream(() => new Response("ok"));

    const exit = await run(client.get("http://api.example.com/v1/models"));

    expect(sent).toEqual([]);
    expect(outboundRefusalOf(failureOf(exit))?.reason).toBe("scheme");
    expect(outboundRefusalOf(failureOf(exit))?.message).toBe(OUTBOUND_REFUSED_MESSAGE);
  });

  it("follows a redirect to a public address, checking it", async () => {
    const { sent, client } = upstream((url) =>
      url.hostname === "old.example.com"
        ? redirect("https://new.example.com/v1/models")
        : new Response("moved here"),
    );

    const exit = await run(
      client.get("https://old.example.com/v1/models").pipe(Effect.flatMap((r) => r.text)),
    );

    expect(Exit.isSuccess(exit) && exit.value).toBe("moved here");
    expect(sent.map((request) => request.url)).toEqual([
      "https://old.example.com/v1/models",
      "https://new.example.com/v1/models",
    ]);
  });

  it("refuses a redirect to a refused address and never sends it", async () => {
    const { sent, client } = upstream(() => redirect("http://169.254.169.254/latest/meta-data/"));

    const exit = await run(client.get("https://api.example.com/v1"));

    expect(sent.map((request) => request.url)).toEqual(["https://api.example.com/v1"]);
    expect(outboundRefusalOf(failureOf(exit))?.reason).toBe("scheme");
  });

  it("refuses a relative redirect onto an own host", async () => {
    const { client } = upstream((url) =>
      url.hostname === "api.example.com" ? redirect("https://app.example.com/") : new Response(),
    );

    const exit = await run(
      client
        .get("https://api.example.com/v1")
        .pipe(
          Effect.provideService(
            CurrentOutboundPolicy,
            outboundPolicy({ hosts: ["app.example.com"] }),
          ),
        ),
    );

    expect(outboundRefusalOf(failureOf(exit))?.reason).toBe("own_host");
  });

  it("refuses more than the hop limit", async () => {
    let hop = 0;

    const { sent, client } = upstream(() => {
      hop += 1;

      return redirect(`/hop/${hop}`);
    });

    const exit = await run(client.get("https://api.example.com/start"));

    expect(outboundRefusalOf(failureOf(exit))?.reason).toBe("too_many_redirects");
    expect(sent).toHaveLength(MAX_OUTBOUND_REDIRECTS + 1);
  });

  it("turns a redirected POST into a GET (302, 303) and keeps it for 307", async () => {
    const answers = new Map([
      ["/a", redirect("/b", 302)],
      ["/b", redirect("/c", 307)],
    ]);

    const { sent, client } = upstream((url) => answers.get(url.pathname) ?? new Response("done"));

    await run(
      client.execute(
        HttpClientRequest.post("https://api.example.com/a").pipe(HttpClientRequest.bodyText("{}")),
      ),
    );

    expect(sent.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      "POST /a",
      "GET /b",
      "GET /c",
    ]);
  });

  it("drops the Authorization header on a redirect to another origin", async () => {
    const { sent, client } = upstream((url) =>
      url.hostname === "api.example.com"
        ? redirect("https://cdn.example.net/file")
        : new Response("file"),
    );

    await run(
      client.execute(
        HttpClientRequest.get("https://api.example.com/file").pipe(
          HttpClientRequest.bearerToken("secret"),
        ),
      ),
    );

    expect(sent.map((request) => request.authorization)).toEqual(["Bearer secret", undefined]);
  });

  it("leaves a caller's own manual redirects to the caller, checking the first hop only", async () => {
    const { sent, client } = upstream(() => redirect("http://10.0.0.1/"));

    const exit = await run(
      client
        .get("https://api.example.com/v1")
        .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" })),
    );

    expect(Exit.isSuccess(exit) && exit.value.status).toBe(302);
    expect(sent).toHaveLength(1);
  });
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
