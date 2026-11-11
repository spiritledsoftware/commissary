// Antigravity function responses per turn (ticket C8; upstream 234217d0): excess functionResponse parts of a turn are
// discarded instead of leaking into the next turn's group. Go test:
// TestFixCLIToolResponse_MoreResponsesThanCallsDoesNotCorruptNextTurn (antigravity_gemini_request_test.go).
import { describe, expect, it } from "vitest";
import { asString, get, type Json } from "@commissary/json";
import { validateGeminiFunctionCallPairing } from "../src/signature/gemini.ts";
import { builtinTranslators } from "../src/translator/builtin.ts";

const convert = (contents: Json[]): Json =>
  builtinTranslators.translateRequest(
    "gemini",
    "antigravity",
    { format: "gemini", model: "gemini-3.8-flash", stream: false, body: { contents } },
    undefined,
  ).body;

const call = (id: string, name: string, args: Json): Json => ({ functionCall: { id, name, args } });

const response = (id: string, name: string, output: string): Json => ({
  functionResponse: { id, name, response: { output } },
});

const ids = (out: Json, index: number): string[] =>
  (get(out, `request.contents.${index}.parts`) as Json[]).map((part) =>
    asString(get(part, "functionResponse.id")),
  );

describe("Gemini -> Antigravity: more responses than calls", () => {
  it("keeps an orphan response out of the next turn", () => {
    const out = convert([
      { role: "user", parts: [{ text: "Inspect the project structure" }] },
      {
        role: "model",
        parts: [
          call("call_210083", "glob", { pattern: "src/**" }),
          call("call_210092", "grep_search", { query: "header" }),
          call("call_210101", "web_fetch", { url: "https://example.com" }),
        ],
      },
      {
        role: "user",
        parts: [
          response("call_210083", "glob", "a"),
          response("call_210092", "grep_search", "b"),
          response("call_210101", "web_fetch", "c"),
          response("call_203720", "glob", "orphan"),
        ],
      },
      {
        role: "model",
        parts: [
          call("call_153280", "glob", { pattern: "src/components/**" }),
          call("call_153283", "glob", { pattern: "src/i18n/**" }),
        ],
      },
      {
        role: "user",
        parts: [response("call_153280", "glob", "d"), response("call_153283", "glob", "e")],
      },
    ]);

    expect(validateGeminiFunctionCallPairing(out)).toBeUndefined();
    expect(ids(out, 2)).toEqual(["call_210083", "call_210092", "call_210101"]);
    expect(ids(out, 4)).toEqual(["call_153280", "call_153283"]);
  });

  it("picks the responses of a group by call id when extras exist", () => {
    const out = convert([
      { role: "user", parts: [{ text: "go" }] },
      {
        role: "model",
        parts: [call("a", "glob", { pattern: "1" }), call("b", "glob", { pattern: "2" })],
      },
      {
        role: "user",
        parts: [
          response("orphan", "glob", "x"),
          response("b", "glob", "B"),
          response("a", "glob", "A"),
        ],
      },
    ]);

    expect(ids(out, 2)).toEqual(["a", "b"]);
  });

  it("falls back to the call name, then to order, for responses without a matching id", () => {
    const out = convert([
      { role: "user", parts: [{ text: "go" }] },
      {
        role: "model",
        parts: [
          call("a", "glob", { pattern: "1" }),
          { functionCall: { id: "", name: "grep", args: {} } },
        ],
      },
      {
        role: "user",
        parts: [
          response("stray", "other", "x"),
          { functionResponse: { name: "grep", response: { output: "G" } } },
          response("a", "glob", "A"),
        ],
      },
    ]);

    const parts = get(out, "request.contents.2.parts") as Json[];

    expect(parts.map((part) => get(part, "functionResponse.name"))).toEqual(["glob", "grep"]);
    expect(get(parts[0], "functionResponse.id")).toBe("a");
  });
});
