// Fake HTTP servers served in workerd, for OpenAPI toolkits (#203), through the routing `fetch` of `fake-fetch.ts`
// (`serveFakeServers`): the documents the ControlPlane fetches and the calls it makes reach them. A fake records every
// request it gets, its body read as text.
import { routeFakeServer } from "./fake-fetch.ts";

export interface RecordedHttpRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: string;
}

export interface FakeHttpServer {
  /** The server's origin. */
  readonly origin: string;
  readonly requests: Array<RecordedHttpRequest>;
}

/** A fake server at `origin` (a unique origin per test keeps tests apart), answering each request with `answer`. */
export const fakeHttpServer = (
  origin: string,
  answer: (request: RecordedHttpRequest) => Response,
): FakeHttpServer => {
  const server: FakeHttpServer = { origin, requests: [] };

  routeFakeServer(origin, async (request) => {
    const recorded: RecordedHttpRequest = {
      method: request.method,
      url: new URL(request.url),
      headers: request.headers,
      body: request.body === null ? "" : await request.text(),
    };

    server.requests.push(recorded);

    return answer(recorded);
  });

  return server;
};
