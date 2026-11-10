// Devin Connect-RPC wire codec: protobuf round trips and parity with bytes produced by the Go code
// (fixtures: `go run ./tools/fixturegen/devin`).
import { describe, expect, it } from "vitest";
import {
  ConnectFrameError,
  ConnectFrameParser,
  inflateFrame,
} from "../src/executor/devin/connect.ts";
import { buildSensitiveWordMatcher } from "../src/executor/claude/cloaking.ts";
import { devinLevelLookup } from "../src/executor/devin/catalog.ts";
import { resolveDevinChatModelUid } from "../src/executor/devin/models.ts";
import { devinPayloadView, finalizeDevinPayload } from "../src/executor/devin/payload.ts";
import { ProtoError, ProtoWriter, readFields, WireType } from "../src/executor/devin/protobuf.ts";
import {
  buildGetChatMessageRequest,
  generateDeviceFingerprint,
  parseDevinFrame,
  parseDimensionGroups,
  parseTrailerError,
  sanitizeDevinSystemPrompt,
  wrapConnectEnvelope,
} from "../src/executor/devin/wire.ts";
import fixtures from "./fixtures/devin.json";

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));

const toHex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("protobuf codec", () => {
  it("round-trips varints, strings, bytes, doubles and floats", () => {
    const bytes = new ProtoWriter()
      .varint(1, 0)
      .varint(2, 300)
      .varint(3, 2 ** 40 + 5)
      .string(4, "héllo")
      .bytes(5, Uint8Array.of(0, 1, 2))
      .double(6, 0.1)
      .float(7, 1.5)
      .toBytes();

    const fields = [...readFields(bytes)];
    expect(fields.map((field) => [field.num, field.wire])).toEqual([
      [1, WireType.Varint],
      [2, WireType.Varint],
      [3, WireType.Varint],
      [4, WireType.Bytes],
      [5, WireType.Bytes],
      [6, WireType.Fixed64],
      [7, WireType.Fixed32],
    ]);
    expect(fields[1]?.varint).toBe(300);
    expect(fields[2]?.varint).toBe(2 ** 40 + 5);
    expect(text(fields[3]?.bytes as Uint8Array)).toBe("héllo");
    expect(Array.from((fields[4] as { bytes: Uint8Array }).bytes)).toEqual([0, 1, 2]);
    const double = (fields[5] as { bytes: Uint8Array }).bytes;
    expect(new DataView(double.buffer, double.byteOffset, 8).getFloat64(0, true)).toBe(0.1);
  });

  it("rejects truncated and malformed input", () => {
    expect(() => [...readFields(Uint8Array.of(0x0a, 0x05, 0x01))]).toThrow(ProtoError);
    expect(() => [...readFields(Uint8Array.of(0x80))]).toThrow(ProtoError);
    expect(() => [...readFields(Uint8Array.of(0x0b))]).toThrow(ProtoError); // group start
    expect(() => [...readFields(Uint8Array.of(0x00, 0x01))]).toThrow(ProtoError); // field 0
  });
});

describe("Connect envelope and frame reader", () => {
  it("matches the Go envelope bytes", () => {
    const [plain, trailer] = fixtures.envelopes;
    expect(toHex(wrapConnectEnvelope(new TextEncoder().encode("abc")))).toBe(plain);
    expect(toHex(wrapConnectEnvelope(new TextEncoder().encode("{}"), 2))).toBe(trailer);
  });

  it("reassembles frames split across arbitrary chunk boundaries", () => {
    const wire = new Uint8Array([
      ...wrapConnectEnvelope(Uint8Array.of(1, 2, 3)),
      ...wrapConnectEnvelope(new Uint8Array(0)),
      ...wrapConnectEnvelope(new TextEncoder().encode("{}"), 2),
    ]);

    const parser = new ConnectFrameParser();
    const frames = [];

    for (let i = 0; i < wire.length; i += 3) frames.push(...parser.push(wire.subarray(i, i + 3)));
    expect(frames.map((frame) => [frame.flag, frame.payload.length])).toEqual([
      [0, 3],
      [0, 0],
      [2, 2],
    ]);
    expect(parser.pending).toBe(0);
    parser.push(Uint8Array.of(0, 0, 0));
    expect(parser.pending).toBe(3);
  });

  it("rejects invalid flags and oversized frames", () => {
    expect(() => new ConnectFrameParser().push(Uint8Array.of(4, 0, 0, 0, 0))).toThrow(
      ConnectFrameError,
    );
    expect(() => new ConnectFrameParser().push(Uint8Array.of(0, 0xff, 0xff, 0xff, 0xff))).toThrow(
      /exceeds maximum/,
    );
  });

  it("inflates gzip frames", async () => {
    const gz = fixtures.scenarios.find((scenario) => scenario.name === "gzip-frame")?.frames[0];
    expect(gz?.flag).toBe(1);
    const payload = await inflateFrame({ flag: 1, payload: fromHex(gz?.hex ?? "") });
    expect(parseDevinFrame(payload).content).toEqual(new TextEncoder().encode("zipped"));
    await expect(inflateFrame({ flag: 1, payload: Uint8Array.of(1, 2, 3) })).rejects.toThrow(
      /decompress gzip/,
    );
  });
});

describe("response frames (parity with ParseDevinFrame)", () => {
  for (const expected of fixtures.frames) {
    it(`decodes ${expected.name}`, () => {
      const frame = parseDevinFrame(fromHex(expected.hex));
      expect(text(frame.content)).toBe(expected.content);
      expect(text(frame.thinking)).toBe(expected.thinking);
      expect(text(frame.deltaSignature)).toBe(expected.signature);
      expect(frame.deltaSignatureType).toBe(expected.signatureType);
      expect(frame.outputId).toBe(expected.outputId);
      expect(frame.messageId).toBe(expected.messageId);
      expect(frame.timestamp).toBe(expected.timestamp);
      expect(frame.stopReason).toBe(expected.stopReason);
      expect(frame.unknownFields).toEqual(expected.unknown ?? []);
      expect(
        frame.toolCalls.map((call) => ({
          id: call.id,
          name: call.name,
          arguments: call.arguments,
          invalidJsonStr: call.invalidJsonStr,
          invalidJsonErr: call.invalidJsonErr,
          isCustomToolCall: call.isCustomToolCall,
        })),
      ).toEqual(expected.toolCalls);

      if (expected.usage !== undefined) {
        expect({
          promptTokens: frame.usage?.promptTokens,
          completionTokens: frame.usage?.completionTokens,
          cachedTokens: frame.usage?.cachedTokens,
          cacheWriteTokens: frame.usage?.cacheWriteTokens,
          statusCode: frame.usage?.statusCode,
          requestId: frame.usage?.requestId,
          modelName: frame.usage?.modelName,
        }).toEqual(expected.usage);
      }

      if (expected.dimension !== undefined) {
        const parsed = parseDimensionGroups(frame.dimensionGroups);
        expect(parsed).toEqual({
          promptTokens: expected.dimension.input,
          completionTokens: expected.dimension.output,
          cachedTokens: expected.dimension.cached,
        });
      }
    });
  }

  it("throws on malformed frames", () => {
    expect(() => parseDevinFrame(Uint8Array.of(0x1a, 0x09, 0x01))).toThrow(ProtoError);
  });
});

describe("EOS trailer mapping (parity with ParseDevinTrailerError)", () => {
  for (const expected of fixtures.trailers) {
    it(`maps ${JSON.stringify(expected.json)}`, () => {
      const parsed = parseTrailerError(new TextEncoder().encode(expected.json));
      expect(parsed?.status ?? 0).toBe(expected.status);
      expect(parsed?.message ?? "").toBe(expected.message ?? "");
    });
  }
});

describe("model UID resolution (parity with ResolveDevinChatModelUID)", () => {
  for (const expected of fixtures.modelUids) {
    it(`${JSON.stringify(expected.model)} level=${expected.level || "-"} budget=${expected.budget}`, () => {
      expect(
        resolveDevinChatModelUid(expected.model, expected.level, expected.budget, devinLevelLookup),
      ).toBe(expected.uid);
    });
  }
});

describe("model UID resolution: swe-2, lightning and fast variants (Go devin_models_test.go)", () => {
  // The expected UIDs are the cases of upstream commits a3c84a37 (catalog additions), 3dae075d (lightning) and
  // ecbaa6c7 (fast variants).
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ["swe-2-flash-high", "", "swe-2-flash-high"],
    ["swe-2-flash", "", "swe-2-flash-high"],
    ["swe-2-flash", "medium", "swe-2-flash-medium"],
    ["swe-2-flash(max)", "", "swe-2-flash-max"],
    ["devin/swe-2-flash:medium", "", "swe-2-flash-medium"],
    ["devin/swe-2-lightning", "", "swe-2-high-lightning"],
    ["devin/swe-2-lightning(medium)", "", "swe-2-medium-lightning"],
    ["devin/swe-2-lightning:max", "", "swe-2-max-lightning"],
    ["devin/swe-2-lightning", "medium", "swe-2-medium-lightning"],
    ["devin/swe-2-lightning(max)", "medium", "swe-2-max-lightning"],
    ["devin/swe-2-high-lightning", "", "swe-2-high-lightning"],
    ["devin/swe-2-medium-lightning", "", "swe-2-medium-lightning"],
    ["devin/swe-2-high-lightning(max)", "", "swe-2-high-lightning"],
    ["devin/swe-2-lightning(low)", "", "swe-2-medium-lightning"],
    ["devin/swe-2-lightning(high-fast)", "", "swe-2-high-lightning"],
    ["devin/claude-opus-5-5(high-fast)", "", "claude-opus-5-5-high-fast"],
    ["devin/claude-opus-5-5(max-fast)", "", "claude-opus-5-5-max-fast"],
    ["devin/claude-opus-5-5", "high-fast", "claude-opus-5-5-high-fast"],
    ["devin/claude-opus-5-5(fast)", "", "claude-opus-5-5-medium-fast"],
    ["devin/claude-opus-5-5", "fast", "claude-opus-5-5-medium-fast"],
    ["devin/claude-opus-5-5(high)", "", "claude-opus-5-5-high"],
    ["devin/claude-haiku-4-5(high-fast)", "", "MODEL_PRIVATE_11"],
    // The catalog additions resolve through their own thinking levels.
    ["devin/nemotron-3-5-super", "", "nemotron-3-5-super-high"],
    ["devin/gpt-6-1-terra(max)", "", "gpt-6-1-terra-max"],
  ];

  for (const [model, level, uid] of cases) {
    it(`${model} level=${level || "-"} -> ${uid}`, () => {
      expect(resolveDevinChatModelUid(model, level, 0, devinLevelLookup)).toBe(uid);
    });
  }
});

describe("system prompt sanitising (parity with SanitizeDevinSystemPrompt)", () => {
  for (const expected of fixtures.systemPrompts) {
    it(expected.name, () => {
      expect(
        sanitizeDevinSystemPrompt(expected.input, buildSensitiveWordMatcher(expected.words ?? [])),
      ).toBe(expected.expected);
    });
  }
});

/** Replaces the random prompt ids so wire bytes can be compared with the Go output. */
const normalizePromptIds = (wire: Uint8Array): string => {
  const out = new ProtoWriter();

  for (const field of readFields(wire)) {
    if (field.num !== 3) {
      out.raw(field.encoded);
      continue;
    }

    const prompt = new ProtoWriter();

    for (const inner of readFields(field.bytes)) {
      if (inner.num === 1) prompt.string(1, "ID");
      else prompt.raw(inner.encoded);
    }

    out.bytes(3, prompt.toBytes());
  }

  return toHex(out.toBytes());
};

describe("GetChatMessageRequest encoding", () => {
  it("derives the device fingerprint like Go", () => {
    expect(generateDeviceFingerprint("seed-1")).toBe(fixtures.fingerprints["seed-1"]);
    expect(generateDeviceFingerprint("seed-1")).toHaveLength(732);
    expect(generateDeviceFingerprint("")).toMatch(/^[0-9a-f]{732}$/);
    expect(generateDeviceFingerprint("")).not.toBe(generateDeviceFingerprint(""));
  });

  it("encodes the Go request bytes of a simple chat (random prompt ids aside)", () => {
    const go = fixtures.scenarios.find((scenario) => scenario.name === "text-basic");

    const bytes = buildGetChatMessageRequest({
      sessionToken: "devin-session-token$test",
      deviceSeed: "seed-1",
      chatModelUid: "swe-2-high",
      systemPrompt: "",
      prompts: [
        {
          messageId: "x",
          source: 1,
          content: "hi",
          images: [],
          toolCalls: [],
          toolCallId: "",
          originalToolCallId: "",
          isOrphanedTool: false,
          droppedPart: "",
          thinking: "",
          signature: new Uint8Array(0),
          signatureType: "",
        },
      ],
      tools: [],
      temperature: 0.5,
      maxTokens: 256,
      sessionId: "11111111-1111-4111-8111-111111111111",
      cascadeId: "11111111-1111-4111-8111-111111111111",
      turnIndex: 0,
      matcher: undefined,
      osName: "linux",
    });

    expect(normalizePromptIds(bytes)).toBe(
      normalizePromptIds(fromHex(go?.requests[0]?.bodyHex ?? "")),
    );
  });

  it("exposes the business fields as a JSON view and re-encodes only changed fields", () => {
    const go = fromHex(
      fixtures.scenarios.find((s) => s.name === "history-tools-images")?.requests[0]?.bodyHex ?? "",
    );

    const view = devinPayloadView(go);
    expect(Object.keys(view)).toEqual(
      ["completion_config", "model", "prompts", "system_prompt", "tools", "cascade_id"].toSorted(),
    );
    expect(view["model"]).toBe("claude-opus-4-6-thinking");
    // An untouched view keeps the exact wire bytes.
    expect(finalizeDevinPayload(go, (value) => value).wire).toBe(go);

    // A changed view replaces the business fields; credentials and flags stay opaque.
    const changed = finalizeDevinPayload(go, (value) => {
      (value as { model: string }).model = "custom-uid";

      return value;
    });

    const reread = devinPayloadView(changed.wire);
    expect(reread["model"]).toBe("custom-uid");
    expect(reread["prompts"]).toEqual(view["prompts"]);
    expect(reread["tools"]).toEqual(view["tools"]);

    const opaque = (wire: Uint8Array): string[] =>
      [...readFields(wire)].flatMap((field) =>
        [1, 7, 15, 20].includes(field.num) ? [toHex(field.encoded)] : [],
      );

    expect(opaque(changed.wire).toSorted()).toEqual(opaque(go).toSorted());
  });
});
