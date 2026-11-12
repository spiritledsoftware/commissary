// Bounded zstd request-body decoding (src/http/zstd.ts, src/http/body.ts): decompression bombs answer
// 413 instead of exhausting the isolate's memory.
import { describe, expect, it } from "vite-plus/test";
import { decodeRequestBody, RequestBodyTooLargeError } from "../../src/http/body.ts";
import { DecodedBodyTooLargeError, inflateZstd } from "../../src/http/zstd.ts";
import {
  concatBytes,
  zstdDeclaredSizeHeader,
  zstdFrame,
  zstdRleBomb,
  zstdSkippable,
} from "../support/zstd.ts";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("inflateZstd", () => {
  it("decodes raw and RLE blocks, several frames and skippable frames", () => {
    const first = zstdFrame([{ raw: '{"model":"' }, { rle: 5, byte: "x" }, { raw: '",' }]);
    const second = zstdFrame([{ raw: '"n":1}' }]);

    const decoded = inflateZstd(
      concatBytes(first, zstdSkippable(Uint8Array.of(1, 2, 3)), second),
      1024,
    );

    expect(text(decoded)).toBe('{"model":"xxxxx","n":1}');
  });

  it("stops a decompression bomb one block past the limit", () => {
    const bomb = zstdRleBomb(4 * 1024 * 1024);
    expect(bomb.length).toBeLessThan(200);
    expect(() => inflateZstd(bomb, 1024 * 1024)).toThrow(DecodedBodyTooLargeError);
    expect(inflateZstd(bomb, 4 * 1024 * 1024)).toHaveLength(4 * 1024 * 1024);
  });

  it("rejects frames whose declared window or content size exceeds the limit before allocating", () => {
    // A 2 GiB window: fzstd would allocate it up front.
    expect(() => inflateZstd(zstdFrame([{ rle: 16, byte: "a" }], 21), 32 * 1024 * 1024)).toThrow(
      DecodedBodyTooLargeError,
    );
    expect(() => inflateZstd(zstdDeclaredSizeHeader(2 ** 40), 32 * 1024 * 1024)).toThrow(
      DecodedBodyTooLargeError,
    );
    // The check covers every frame, not just the first one.
    const small = zstdFrame([{ raw: "{}" }]);
    expect(() =>
      inflateZstd(concatBytes(small, zstdFrame([{ rle: 1, byte: "a" }], 30)), 1024),
    ).toThrow(DecodedBodyTooLargeError);
  });

  it("leaves corrupt input to the decoder", () => {
    expect(() => inflateZstd(Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 0x00), 1024)).toThrow();
    expect(() =>
      inflateZstd(Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x68, 0x07, 0x00), 1024),
    ).toThrow();
  });
});

describe("decodeRequestBody limit", () => {
  it("maps an oversized zstd body to RequestBodyTooLargeError (413)", () => {
    expect(() => decodeRequestBody(zstdRleBomb(2048), "zstd", 1024)).toThrow(
      RequestBodyTooLargeError,
    );
    expect(decodeRequestBody(zstdFrame([{ raw: '{"a":1}' }]), "zstd", 1024)).toBe('{"a":1}');
    // A raw JSON body sent with a zstd header is still accepted (Go fallback).
    expect(decodeRequestBody(new TextEncoder().encode('{"a":1}'), "zstd", 4)).toBe('{"a":1}');
  });
});
