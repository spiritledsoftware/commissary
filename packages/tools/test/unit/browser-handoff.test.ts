// How the MCP endpoint reaches the person a browser session's handoff asks for (#216): a client that declares URL
// elicitation is asked to open the session's page in the panel, any other gets the link in a tool result that is not
// an error, and every client gets the words alone when the panel's URL is not known; the retry's answer to the
// elicitation is read from its `inputResponses`.
import { describe, expect, it } from "vitest";
import { handoffAnswerOf, handoffResult, SESSION_PAGE } from "../../src/mcp/handoff.ts";

const ID = `bs_${"a".repeat(32)}`;

const LINK = `https://app.example.com/o/acme/tools/sessions/${ID}`;

const UNTIL = Date.UTC(2026, 9, 21, 12, 30);

const started = { name: "browser_ask_human", sessionId: ID, reason: "Sign in.", until: UNTIL };

describe("a started handoff's answer", () => {
  it("asks a client that takes URL elicitations to open the session's page", () => {
    expect(handoffResult({ ...started, link: LINK, elicitsUrls: true })).toEqual({
      resultType: "input_required",
      inputRequests: {
        handoff: {
          method: "elicitation/create",
          params: {
            mode: "url",
            url: LINK,
            message:
              `Act in your browser session ${ID} yourself. Sign in. Open its page, do it in the browser, then ` +
              `click Done (or Failed). What you type there is not shown to the agent.`,
          },
        },
      },
    });
  });

  it("gives any other client the link, and the call to make again to wait", () => {
    expect(handoffResult({ ...started, link: LINK, elicitsUrls: false })).toEqual({
      content: [
        {
          type: "text",
          text:
            `A person is asked to act in browser session ${ID} until 2026-10-21T12:30:00.000Z. Tell the session's ` +
            `member to open its page at ${LINK}, act in the browser there and click Done or Failed. Then call ` +
            `browser_ask_human again with the same sessionId: it waits for them, and answers how it ended, or, after ` +
            `a while, that they are not done yet (then call it again).`,
        },
      ],
      isError: false,
    });
  });

  it("ends the person's request with one full stop, whatever it ends with", () => {
    const messageOf = (reason: string) =>
      JSON.stringify(handoffResult({ ...started, reason, link: LINK, elicitsUrls: true }));

    expect(messageOf("Sign in")).toContain("yourself. Sign in. Open its page");
    expect(messageOf("Is it you?")).toContain("yourself. Is it you? Open its page");
    expect(messageOf("Sign in.")).not.toContain("..");
  });

  it("names the page in words, and elicits nothing, when the panel's URL is not known", () => {
    const answer = handoffResult({ ...started, link: SESSION_PAGE, elicitsUrls: true });

    expect(answer).not.toHaveProperty("resultType");
    expect(JSON.stringify(answer)).toContain(`open its page on ${SESSION_PAGE}`);
  });
});

describe("the answer to a handoff's elicitation", () => {
  it("is accept, or a decline for anything else, and none without one", () => {
    expect(handoffAnswerOf({ inputResponses: { handoff: { action: "accept" } } })).toBe("accept");
    expect(handoffAnswerOf({ inputResponses: { handoff: { action: "decline" } } })).toBe("decline");
    expect(handoffAnswerOf({ inputResponses: { handoff: {} } })).toBe("cancel");
    expect(handoffAnswerOf({ inputResponses: { approval: { action: "accept" } } })).toBeUndefined();
    expect(handoffAnswerOf({})).toBeUndefined();
  });
});
