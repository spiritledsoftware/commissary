/**
 * Responses framer: private `response.metadata` filtering and recovery of fragmented SSE frames. The cases are ported
 * from CLIProxyAPI ae65e26d (sdk/api/handlers/openai/openai_responses_framing_{metadata,recovery}_test.go), driven
 * through the framer the way `forwardResponsesStream` drives it: chunks, then the end-of-stream flush.
 */
import { describe, expect, it } from "vitest";
import { responsesFramer } from "../src/handlers/responses/framer.ts";

const COMPLETED = 'event: response.completed\ndata: {"type":"response.completed"}\n\n';

const run = (chunks: ReadonlyArray<string>, codexClient = false): string => {
  const framer = responsesFramer({ codexClient });
  let out = "";

  for (const chunk of chunks) out += framer.chunk(chunk);
  framer.closeError();

  return out + framer.done();
};

const expectCompletionKept = (chunks: ReadonlyArray<string>, extra: ReadonlyArray<string> = []) => {
  const got = run(chunks);
  expect(got, JSON.stringify(chunks)).not.toContain("response.metadata");
  expect(got, JSON.stringify(chunks)).not.toContain("event: error");
  expect(got, JSON.stringify(chunks)).toContain("response.completed");

  for (const part of extra) expect(got, JSON.stringify(chunks)).toContain(part);
};

describe("response.metadata filtering across fragmented frames", () => {
  const payload = '{"type":"response.metadata","metadata":{"marker":"private"}}';

  for (const [name, eol, codex] of [
    ["standard-lf", "\n", false],
    ["codex-lf", "\n", true],
    ["standard-crlf", "\r\n", false],
    ["codex-crlf", "\r\n", true],
  ] as const) {
    it(`handles a data field split after the colon (${name})`, () => {
      const prefix = `event: response.metadata${eol}data:`;
      const frame = `${prefix} ${payload}${eol}${eol}`;

      for (const split of [prefix.length, prefix.length + 1]) {
        const got = run([frame.slice(0, split), frame.slice(split), COMPLETED], codex);

        if (codex) expect(got).toContain(`${prefix} ${payload}`);
        else {
          expect(got).not.toContain("response.metadata");
          expect(got).not.toContain("private");
        }

        expect(got).toContain("response.completed");
      }
    });
  }

  it("does not let an empty metadata data field consume a fragmented completion", () => {
    for (let split = 1; split <= "event:".length; split++)
      expectCompletionKept([
        "event: response.metadata\ndata:",
        COMPLETED.slice(0, split),
        COMPLETED.slice(split),
      ]);
  });

  it("does not let an empty metadata data field consume a leading separator or field", () => {
    for (const prefix of [
      "\n",
      "\r\n",
      ": keepalive\n",
      "id: event-42\n",
      "retry: 1000\n",
      "x-extra: value\n",
    ])
      expectCompletionKept(["event: response.metadata\ndata:", prefix + COMPLETED]);
  });

  it("does not let an empty metadata data field consume a fragmented field", () => {
    for (const prefix of ["id: event-42\n", "retry: 1000\n", "x-extra: value\n"]) {
      const field = prefix + COMPLETED;

      for (let split = 1; split < prefix.indexOf(":") + 1; split++)
        expectCompletionKept([
          "event: response.metadata\ndata:",
          field.slice(0, split),
          field.slice(split),
        ]);
    }
  });

  it("does not let an empty metadata data field consume a data-only completion", () => {
    const completed = 'data: {"type":"response.completed"}\n\n';

    for (let split = 1; split <= "data:".length; split++)
      expectCompletionKept([
        "event: response.metadata\ndata:",
        completed.slice(0, split),
        completed.slice(split),
      ]);
  });

  it("keeps a data frame that arrives before its event line", () => {
    const created = 'data: {"response":{"id":"resp-1","status":"completed"}}';
    const completed = "event: response.completed\n\n";

    for (let split = 1; split <= "event:".length; split++)
      expectCompletionKept(
        [
          "event: response.metadata\ndata:",
          created,
          completed.slice(0, split),
          completed.slice(split),
        ],
        ["event: response.completed", "resp-1"],
      );

    expectCompletionKept(
      ["event: response.metadata\ndata:", `${created}\n${completed}`],
      ["event: response.completed", "resp-1"],
    );
  });

  it("keeps a data frame followed by a fragmented field and its event", () => {
    const created = 'data: {"response":{"id":"resp-1","status":"completed"}}';

    for (const field of ["id: event-42", "retry: 1000", ": keepalive", "x-extra: value"])
      for (let split = 1; split <= field.length; split++)
        expectCompletionKept(
          [
            "event: response.metadata\ndata:",
            created,
            field.slice(0, split),
            field.slice(split),
            "event: response.completed\n\n",
          ],
          ["event: response.completed", "resp-1"],
        );
  });

  it("keeps a data frame followed by a fragmented event after a line break", () => {
    const event = "event: response.completed\n\n";
    const created = 'data: {"response":{"id":"resp-1","status":"completed"}}\n';

    for (const field of ["", "id: event-42\n", ": keepalive\n"])
      for (let split = 1; split < "event:".length; split++) {
        const middle = field === "" ? [] : [field];

        expectCompletionKept(
          [
            "event: response.metadata\ndata:",
            created,
            ...middle,
            event.slice(0, split),
            event.slice(split),
          ],
          ["event: response.completed", "resp-1"],
        );
        expectCompletionKept(
          [
            "event: response.metadata\ndata:",
            created + field + event.slice(0, split),
            event.slice(split),
          ],
          ["event: response.completed", "resp-1"],
        );
      }
  });

  it("preserves an empty event until its frame completes", () => {
    const framer = responsesFramer({ codexClient: false });
    expect(framer.chunk("event: custom\ndata:")).toBe("");
    expect(framer.chunk("\n\n")).toBe("event: custom\ndata:\n\n");
  });

  it("does not split a metadata payload at a field-looking string inside its JSON", () => {
    for (const marker of [
      "data: private",
      "event: private",
      "id: private",
      "retry: private",
      ": private",
      'escaped " data: private',
      "escaped \\ event: private",
    ])
      for (const codex of [false, true]) {
        const body = `{"type":"response.metadata","metadata":{"marker":${JSON.stringify(marker)}}}`;
        const frame = `data: ${body}\n\n`;
        const needle = marker.replace('escaped " ', "");
        const field = frame.indexOf(needle.startsWith("escaped") ? "event: private" : needle);
        expect(field).toBeGreaterThan(0);
        const got = run([frame.slice(0, field), frame.slice(field), COMPLETED], codex);

        if (codex) expect(got, marker).toContain(body);
        else {
          expect(got, marker).not.toContain("response.metadata");
          expect(got, marker).not.toContain("private");
        }

        expect(got, marker).toContain("response.completed");
      }
  });

  it("filters a malformed private payload", () => {
    const got = run([
      'data: {"type":"response.metadata","metadata":{"marker":"private"}\n\n',
      COMPLETED,
    ]);

    expect(got).not.toContain("response.metadata");
    expect(got).not.toContain("private");
  });
});

describe("recovery of JSON split across chunk boundaries", () => {
  const cases: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
    [
      "multiline-json",
      ['data: {"type"', ':"response.metadata",\ndata: "metadata":{"marker":"private"}}\n\n'],
    ],
    [
      "multiple-colons",
      ['data: {"type"', ':"response.metadata","metadata"', ':{"marker":"private"}}\n\n'],
    ],
    [
      "real-comment",
      [
        'data: {"type"',
        ':"response.metadata",\n: keepalive\ndata: "metadata":{"marker":"private"}}\n\n',
      ],
    ],
    [
      "split-data-field",
      ["data", ': {"type":"response.metadata","metadata":{"marker":"private"}}\n\n'],
    ],
    [
      "multiple-colons-with-comment",
      [
        'data: {"type"',
        ':"response.metadata",\n: keepalive\ndata: "metadata"',
        ':{"marker":"private"}}\n\n',
      ],
    ],
    [
      "separate-comment-with-split-key",
      [
        'data: {"type"',
        ": keepalive",
        'data: :"response.metadata","metadata"',
        ':{"marker":"private"}}\n\n',
      ],
    ],
    [
      "colon-before-string-field",
      ['data: {"type":"response.metadata","metadata":{"marker"', ':"', 'data: private"}}\n\n'],
    ],
    [
      "empty-comment",
      ['data: {"type"', ":", 'data: :"response.metadata","metadata":{"marker":"private"}}\n\n'],
    ],
  ];

  for (const [name, chunks] of cases) {
    it(`drops the private metadata for standard clients (${name})`, () => {
      const got = run([...chunks, COMPLETED]);
      expect(got).not.toContain("response.metadata");
      expect(got).not.toContain("private");
      expect(got).toContain("response.completed");
    });

    it(`delivers intact JSON to Codex clients (${name})`, () => {
      const got = run([...chunks, COMPLETED], true);
      const first = got.split("\n\n")[0] as string;

      const data = first
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");

      const marker = name === "colon-before-string-field" ? "data: private" : "private";
      const parsed = JSON.parse(data) as { type: string; metadata: { marker: string } };
      expect(parsed.type).toBe("response.metadata");
      expect(parsed.metadata.marker).toBe(marker);

      if (chunks.join("").includes(": keepalive")) expect(got).toContain(": keepalive");
      expect(got).toContain("response.completed");
    });
  }
});
