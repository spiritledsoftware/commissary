// The session date pin through the Claude executor (CLIProxyAPI 7604d3df): the cloaked `currentDate` is anchored once per
// (org, caller scope, session) and kept for 7 days, across credential switches and idle gaps. Memory stores with an
// injected clock; the store's own behaviour (TTL, refresh cadence, scopes, orgs, concurrency) is in
// session-state-stores.test.ts.
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { fixedBackend, type SessionStateBackend, SessionStateError } from "@commissary/state";
import type { Json, JsonObject } from "@commissary/json";
import { currentDateReminder } from "../src/executor/claude/cloaking.ts";
import { makeMemoryContinuityStore } from "../src/executor/claude/continuity.ts";
import {
  type DatePinStore,
  makeMemoryDatePinStore,
  makeSessionStateDatePinStore,
} from "../src/executor/claude/date-pin.ts";
import { makeClaudeExecutor } from "../src/executor/claude/executor.ts";
import type { CredentialSnapshot } from "../src/executor/picker.ts";
import { credential, execute, harness, json, options } from "./support/executor-run.ts";

const SESSION = "claude:date-pin-session";

const OK = () =>
  Response.json({
    id: "msg_1",
    type: "message",
    model: "claude-opus-4-8",
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    usage: { input_tokens: 1, output_tokens: 1 },
  });

const oauth = (
  id = "claude-oauth-1",
  attributes: Record<string, string> = {},
): CredentialSnapshot =>
  credential("claude", {
    id,
    kind: "oauth",
    attributes,
    metadata: { access_token: `sk-ant-oat01-${id}` },
  });

/** An empty `sessionId` is a request without a caller session. */
const messagesOptions = (sessionId = SESSION) =>
  options({
    sourceFormat: "claude",
    metadata: {
      ...options().metadata,
      requestPath: "/v1/messages",
      ...(sessionId === "" ? {} : { sessionId }),
    },
  });

const body = (content: Json = "Hello there", extra: JsonObject = {}): JsonObject => ({
  model: "claude-opus-4-8",
  max_tokens: 16,
  messages: [{ role: "user", content }],
  ...extra,
});

const T0 = Date.parse("2026-10-05T10:00:00Z");

const HOUR = 60 * 60 * 1000;

interface Rig {
  readonly clock: { now: number };
  readonly send: (
    payload?: JsonObject,
    cred?: CredentialSnapshot,
    opts?: ReturnType<typeof messagesOptions>,
  ) => Promise<JsonObject>;
}

const rig = (datePin?: (now: () => number) => DatePinStore): Rig => {
  const clock = { now: T0 };
  const now = () => clock.now;

  const executor = makeClaudeExecutor({
    continuity: makeMemoryContinuityStore(now),
    datePin: datePin === undefined ? makeMemoryDatePinStore(now) : datePin(now),
    now: () => new Date(clock.now),
  });

  return {
    clock,
    send: async (payload = body(), cred = oauth(), opts = messagesOptions()) => {
      const h = await harness(cred, OK);
      await execute(executor, h, { model: "claude-opus-4-8", payload: json(payload) }, opts);

      return JSON.parse(h.calls[0]?.text ?? "{}") as JsonObject;
    },
  };
};

const textOf = (block: JsonObject | undefined): string =>
  typeof block?.text === "string" ? block.text : "";

const reminder = (date: string): string => currentDateReminder(date);

const identity = (sent: JsonObject): string[] => {
  const text = textOf((sent.system as JsonObject[])[0]);

  return [/cc_version=[^;]+;/.exec(text)?.[0] ?? "", /cc_prompt_id=[^;]+;/.exec(text)?.[0] ?? ""];
};

const DATE = /Today's date is (\d{4}-\d{2}-\d{2})\./;

const dateOf = (sent: JsonObject): string | undefined => DATE.exec(JSON.stringify(sent))?.[1];

const firstUserBlocks = (sent: JsonObject): JsonObject[] =>
  ((sent.messages as JsonObject[]).find((message) => message.role === "user")?.content ??
    []) as JsonObject[];

describe("the date survives what expires the continuity entry", () => {
  it("keeps the date across a credential switch while the local date changes", async () => {
    const r = rig();
    expect(dateOf(await r.send(body(), oauth("claude-oauth-1")))).toBe("2026-10-05");
    r.clock.now = Date.parse("2026-10-06T10:00:00Z");
    expect(dateOf(await r.send(body(), oauth("claude-oauth-2")))).toBe("2026-10-05");
  });

  it("keeps the date across a 2 h idle gap that crosses midnight", async () => {
    const r = rig();
    r.clock.now = Date.parse("2026-10-05T23:00:00Z");
    expect(dateOf(await r.send())).toBe("2026-10-05");
    r.clock.now += 2 * HOUR;
    expect(dateOf(await r.send())).toBe("2026-10-05");
  });

  it("anchors another session on the current date", async () => {
    const r = rig();
    expect(dateOf(await r.send())).toBe("2026-10-05");
    r.clock.now = Date.parse("2026-10-06T10:00:00Z");
    expect(dateOf(await r.send(body(), oauth(), messagesOptions("claude:other-session")))).toBe(
      "2026-10-06",
    );
  });
});

describe("a date reminder the caller sends", () => {
  it("seeds the first anchor, and a later caller date does not change it", async () => {
    const r = rig();

    const first = await r.send(
      body([
        { type: "text", text: reminder("2026-10-01") },
        { type: "text", text: "Hello there" },
      ]),
    );

    expect(dateOf(first)).toBe("2026-10-01");
    r.clock.now = Date.parse("2026-10-06T10:00:00Z");

    const second = await r.send(
      body([
        { type: "text", text: reminder("2026-10-03") },
        { type: "text", text: "Hello again" },
      ]),
    );

    expect(dateOf(second)).toBe("2026-10-01");
  });

  it("seeds it from a string-form reminder too", async () => {
    const r = rig();
    expect(dateOf(await r.send(body(`${reminder("2026-10-02")}Hello there`)))).toBe("2026-10-02");
  });

  it("ignores a reminder whose date is not a real date", async () => {
    const r = rig();
    expect(dateOf(await r.send(body(`${reminder("2026-02-30")}Hello there`)))).toBe("2026-10-05");
  });

  it("strips a leading string-form reminder, keeping the user text and exactly one date reminder", async () => {
    const r = rig();
    const sent = await r.send(body(`${reminder("2026-10-05")}Hello there`));
    const blocks = firstUserBlocks(sent);
    const texts = blocks.map(textOf);

    expect(texts.filter((text) => text.startsWith("<system-reminder>"))).toHaveLength(1);
    expect(texts).toContain("Hello there");
    expect(JSON.stringify(sent).match(/# currentDate/g)).toHaveLength(1);
  });

  it("does not change the billing fingerprint or the prompt id", async () => {
    const plain = await rig().send(body("Hello there"));
    const withReminder = await rig().send(body(`${reminder("2026-10-05")}Hello there`));

    expect(identity(withReminder)).toEqual(identity(plain));
    expect(identity(plain)[0]).toMatch(/^cc_version=/);
    expect(identity(plain)[1]).toMatch(/^cc_prompt_id=/);
  });
});

describe("when the backend fails", () => {
  it("uses the local date and the request succeeds", async () => {
    const failing: SessionStateBackend = {
      run: () => Effect.fail(new SessionStateError({ message: "unreachable" })),
    };

    const r = rig(() => makeSessionStateDatePinStore(fixedBackend(failing)));
    expect(dateOf(await r.send())).toBe("2026-10-05");
    r.clock.now = Date.parse("2026-10-06T10:00:00Z");
    expect(dateOf(await r.send())).toBe("2026-10-06");
  });
});

describe("requests that take no part in the pin", () => {
  const counting = () => {
    const inner = makeMemoryDatePinStore();
    const calls = { count: 0 };

    const store: DatePinStore = {
      resolve: (...args) => {
        calls.count += 1;

        return inner.resolve(...args);
      },
    };

    return { store, calls };
  };

  const none = async (
    payload: JsonObject,
    cred: CredentialSnapshot,
    opts: ReturnType<typeof messagesOptions>,
  ): Promise<number> => {
    const { store, calls } = counting();
    const r = rig(() => store);
    await r.send(payload, cred, opts);

    return calls.count;
  };

  it("asks the store once for an ordinary cloaked request with a session", async () => {
    expect(await none(body(), oauth(), messagesOptions())).toBe(1);
  });

  it("makes no store call at the minimal level", async () => {
    expect(
      await none(body(), oauth("claude-oauth-1", { cloak_level: "minimal" }), messagesOptions()),
    ).toBe(0);
  });

  it("makes no store call for a probe", async () => {
    expect(await none(body("quota", { max_tokens: 1 }), oauth(), messagesOptions())).toBe(0);
  });

  it("makes no store call for a title helper", async () => {
    const helper = body("Fix the login bug", {
      system: [{ type: "text", text: "You are naming a coding session. Return a short title." }],
      output_config: {
        format: {
          type: "json_schema",
          schema: { type: "object", properties: { title: { type: "string" } } },
        },
      },
    });

    expect(await none(helper, oauth(), messagesOptions())).toBe(0);
  });

  it("makes no store call without a session", async () => {
    expect(await none(body(), oauth(), messagesOptions(""))).toBe(0);
  });
});
