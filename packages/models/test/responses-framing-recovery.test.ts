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

  // [marker as it appears in the JSON, where the chunk boundary falls (the field-looking text), the JSON-encoded marker]
  const fieldLooking: ReadonlyArray<readonly [string, string, string]> = [
    ["data: private", "data: private", '"data: private"'],
    ["event: private", "event: private", '"event: private"'],
    ["id: private", "id: private", '"id: private"'],
    ["retry: private", "retry: private", '"retry: private"'],
    [": private", ": private", '": private"'],
    ['escaped " data: private', "data: private", '"escaped \\" data: private"'],
    ["escaped \\ event: private", "event: private", '"escaped \\\\ event: private"'],
  ];

  for (const [marker, boundary, encoded] of fieldLooking)
    for (const codex of [false, true])
      it(`does not split metadata at ${JSON.stringify(marker)} inside its JSON (${codex ? "codex" : "standard"})`, () => {
        const body = `{"type":"response.metadata","metadata":{"marker":${encoded}}}`;
        const frame = `data: ${body}\n\n`;
        const field = frame.indexOf(boundary);
        const got = run([frame.slice(0, field), frame.slice(field), COMPLETED], codex);

        if (codex) expect(got).toContain(body);
        else {
          expect(got).not.toContain("response.metadata");
          expect(got).not.toContain("private");
        }

        expect(got).toContain("response.completed");
      });

  it("reads only the top-level type of a truncated payload", () => {
    // Nested `type` before the top-level one: still private.
    const nestedFirst =
      'data: {"item":{"type":"message"},"type":"response.metadata","metadata":{"marker":"private"}\n\n';

    // Nested `type` that looks private, but the top-level type is public: kept.
    const nestedPrivate =
      'data: {"metadata":{"type":"response.metadata"},"type":"response.output_text.delta","delta":"kept"\n\n';

    const hidden = run([nestedFirst, COMPLETED]);
    expect(hidden).not.toContain("response.metadata");
    expect(hidden).not.toContain("private");
    expect(run([nestedPrivate, COMPLETED])).toContain("kept");
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
  // [name, chunks, marker the Codex client must read back, whether a genuine `: keepalive` comment must survive]
  const cases: ReadonlyArray<readonly [string, ReadonlyArray<string>, string, boolean]> = [
    [
      "multiline-json",
      ['data: {"type"', ':"response.metadata",\ndata: "metadata":{"marker":"private"}}\n\n'],
      "private",
      false,
    ],
    [
      "multiple-colons",
      ['data: {"type"', ':"response.metadata","metadata"', ':{"marker":"private"}}\n\n'],
      "private",
      false,
    ],
    [
      "real-comment",
      [
        'data: {"type"',
        ':"response.metadata",\n: keepalive\ndata: "metadata":{"marker":"private"}}\n\n',
      ],
      "private",
      true,
    ],
    [
      "split-data-field",
      ["data", ': {"type":"response.metadata","metadata":{"marker":"private"}}\n\n'],
      "private",
      false,
    ],
    [
      "multiple-colons-with-comment",
      [
        'data: {"type"',
        ':"response.metadata",\n: keepalive\ndata: "metadata"',
        ':{"marker":"private"}}\n\n',
      ],
      "private",
      true,
    ],
    [
      "separate-comment-with-split-key",
      [
        'data: {"type"',
        ": keepalive",
        'data: :"response.metadata","metadata"',
        ':{"marker":"private"}}\n\n',
      ],
      "private",
      true,
    ],
    [
      "colon-before-string-field",
      ['data: {"type":"response.metadata","metadata":{"marker"', ':"', 'data: private"}}\n\n'],
      "data: private",
      false,
    ],
    [
      "empty-comment",
      ['data: {"type"', ":", 'data: :"response.metadata","metadata":{"marker":"private"}}\n\n'],
      "private",
      false,
    ],
  ];

  for (const [name, chunks, expectedMarker, keepsComment] of cases) {
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

      const parsed = JSON.parse(data) as { type: string; metadata: { marker: string } };
      expect(parsed.type).toBe("response.metadata");
      expect(parsed.metadata.marker).toBe(expectedMarker);

      if (keepsComment) expect(got).toContain(": keepalive");
      expect(got).toContain("response.completed");
    });
  }
});
