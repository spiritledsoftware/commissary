// The default upstream connector: `fetch` with `Upgrade: websocket`, URL scheme conversion, handshake rejections.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Frames } from "./support/upstream-message.ts";
import { Effect, Queue } from "effect";
import {
  fetchConnector,
  HandshakeError,
  websocketUrl,
} from "../src/executor/websocket/connector.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("websocketUrl", () => {
  it("maps http(s) to ws(s) and keeps ws(s)", () => {
    expect(websocketUrl("https://chatgpt.com/backend-api/codex/responses")).toBe(
      "wss://chatgpt.com/backend-api/codex/responses",
    );
    expect(websocketUrl("http://localhost:8080/v1/responses")).toBe(
      "ws://localhost:8080/v1/responses",
    );
    expect(websocketUrl("wss://api.x.ai/v1/responses")).toBe("wss://api.x.ai/v1/responses");
    expect(() => websocketUrl("ftp://x/y")).toThrow(/unsupported/);
  });
});

describe("fetchConnector", () => {
  it("dials through fetch with the upgrade header and wraps the accepted socket", async () => {
    const seen: Array<{ url: string; headers: Headers }> = [];
    let upstream: WebSocket | undefined;
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
      seen.push({ url, headers: new Headers(init.headers) });
      const pair = new WebSocketPair();
      upstream = pair[1];
      upstream.accept();
      upstream.addEventListener("message", (event) => upstream?.send(`echo:${String(event.data)}`));

      return Promise.resolve(
        new Response(null, { status: 101, webSocket: pair[0], headers: { "x-upstream": "1" } }),
      );
    });

    const socket = await Effect.runPromise(
      fetchConnector().connect({
        url: "wss://upstream.test/v1/responses",
        headers: { authorization: "Bearer t" },
      }),
    );

    expect(seen[0]?.url).toBe("https://upstream.test/v1/responses");
    expect(seen[0]?.headers.get("upgrade")).toBe("websocket");
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer t");
    expect(socket.headers.get("x-upstream")).toBe("1");

    await Effect.runPromise(socket.send("hello"));
    expect(await Effect.runPromise(Queue.take(socket.messages))).toEqual(
      Frames.text({ data: "echo:hello" }),
    );
    upstream?.close(1000, "bye");
    expect(await Effect.runPromise(Queue.take(socket.messages))).toMatchObject(
      Frames.close({ code: 1000, reason: "bye" }),
    );
    expect(socket.isOpen()).toBe(false);
  });

  it("reports a rejected upgrade with its status, headers and body", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response('{"error":"nope"}', { status: 426, headers: { "x-reason": "upgrade" } }),
      ),
    );

    const error = await Effect.runPromise(
      Effect.flip(fetchConnector().connect({ url: "ws://upstream.test/x", headers: {} })),
    );

    expect(error).toBeInstanceOf(HandshakeError);
    expect(error).toMatchObject({
      status: 426,
      body: '{"error":"nope"}',
      headers: { "x-reason": "upgrade" },
    });
  });

  it("reports a failed dial as a status-0 handshake error", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new Error("dns failure")));

    const error = await Effect.runPromise(
      Effect.flip(fetchConnector().connect({ url: "wss://x.test/y", headers: {} })),
    );

    expect(error).toMatchObject({ status: 0, message: "dns failure" });
  });
});
