// CLIProxyAPI 7795de19 (codex_sse_scanner_test.go): data lines of one event are joined only while its JSON is open.
import { describe, expect, it } from "vitest";
import { CodexSseAssembler } from "../../src/executor/codex/sse-assembler.ts";

const feed = (lines: string[], maxBytes?: number): string[] => {
  const assembler = new CodexSseAssembler(maxBytes);

  return [...lines.flatMap((line) => assembler.push(line)), ...assembler.end()];
};

describe("CodexSseAssembler", () => {
  it("delivers complete, empty and [DONE] data lines untouched, with no lookahead", () => {
    const lines = ['data: {"a":1}', "data: [DONE]", "data:", ": keepalive", "event: x", ""];

    expect(feed(lines)).toEqual(lines);
  });

  it("joins a split event onto one compact data line, ending at the closing bracket", () => {
    expect(
      feed([
        "event: response.completed",
        'data: {"type":"response.completed",',
        'data: "output": [ {"x": 1} ]}',
        "",
      ]),
    ).toEqual([
      "event: response.completed",
      'data: {"type":"response.completed","output":[{"x":1}]}',
      "",
    ]);
  });

  it("keeps a line that follows the closed event as its own event", () => {
    expect(feed(['data: {"a":', "data: 1}", 'data: {"b":2}'])).toEqual([
      'data: {"a":1}',
      'data: {"b":2}',
    ]);
  });

  it("delivers other lines at once, before the held event's data", () => {
    expect(feed(['data: {"a":', ": comment", "data: 1}"])).toEqual([": comment", 'data: {"a":1}']);
  });

  it("delivers an event that never becomes valid JSON as the held lines, so it still fails downstream", () => {
    const lines = ['data: {"status":"comp', 'data: leted"}'];

    expect(feed(lines)).toEqual([lines.join("\n")]);
  });

  it("releases a half-collected event at a blank line and at the end of the stream", () => {
    expect(feed(['data: {"a":', ""])).toEqual(['data: {"a":', ""]);
    expect(feed(['data: {"a":'])).toEqual(['data: {"a":']);
  });

  it("stops collecting past the byte limit and reads the line on its own", () => {
    expect(feed(['data: {"a":', 'data: "bbbbbbbbbb"}'], 20)).toEqual([
      'data: {"a":',
      'data: "bbbbbbbbbb"}',
    ]);
  });
});
