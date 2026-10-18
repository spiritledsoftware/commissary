// TypeSafe's System One request as SubQ's (ADR 0032): images in asset order, references replaced by labels, `assets`
// dropped; media types from a format, a content type or the image's first bytes.
import { describe, expect, it } from "vitest";
import {
  base64DecodedSize,
  bytesToBase64,
  formatMediaType,
  partMediaType,
  sniffImageType,
  toSubQRequest,
} from "../src/systemone/index.ts";

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d];

const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1];

const WEBP_HEAD = [0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];

describe("SubQ requests", () => {
  it("turn assets into images in order, replace every reference with its label and drop assets", () => {
    const request = {
      model: "subq-snap-preview",
      state: { photo: "<image:a>", text: "compare <image:b> with <image:a>", count: 2 },
      questions: {
        same: {
          type: "noul",
          instructions: "Do <image:a> and <image:b> show the same bill?",
          criteria: { true: "<image:a> matches", false: ["no", { see: "<image:b>" }] },
        },
        kind: {
          type: "choice",
          instructions: { question: "What is <image:b>?" },
          // Option names are answer keys: they stay as they are.
          criteria: { "<image:a>": "like <image:a>", other: null },
        },
        level: {
          type: "score",
          instructions: "How clear is <image:b>?",
          criteria: ["<image:b> blurry", "sharp"],
        },
      },
      assets: {
        "<image:a>": { type: "image", part: "asset-0" },
        "<image:b>": { format: "png", data_base64: "iVBORw0K" },
      },
    };

    const images = [
      { mediaType: "image/jpeg", base64: "/9j/" },
      { mediaType: "image/png", base64: "iVBORw0K" },
    ];

    expect(toSubQRequest(request, images)).toEqual({
      model: "subq-snap-preview",
      state: { photo: "[image 1]", text: "compare [image 2] with [image 1]", count: 2 },
      questions: {
        same: {
          type: "noul",
          instructions: "Do [image 1] and [image 2] show the same bill?",
          criteria: { true: "[image 1] matches", false: ["no", { see: "[image 2]" }] },
        },
        kind: {
          type: "choice",
          instructions: { question: "What is [image 2]?" },
          criteria: { "<image:a>": "like [image 1]", other: null },
        },
        level: {
          type: "score",
          instructions: "How clear is [image 2]?",
          criteria: ["[image 2] blurry", "sharp"],
        },
      },
      images,
    });
    // The client's body is not changed.
    expect(request.state.photo).toBe("<image:a>");
  });

  it("replace the longest reference first, in one pass, so labels and longer references stay whole", () => {
    const converted = toSubQRequest(
      {
        model: "m",
        state: "img1 img10 image",
        questions: {},
        assets: {
          img1: { data_base64: "" },
          img10: { data_base64: "" },
          image: { data_base64: "" },
        },
      },
      [],
    );

    expect(converted.state).toBe("[image 1] [image 2] [image 3]");
  });

  it("leave a request without assets as it is, minus an empty assets map and images of its own", () => {
    const request = { model: "m", state: "s", questions: {}, assets: {}, images: ["raw"] };

    expect(toSubQRequest(request, [])).toEqual({
      model: "m",
      state: "s",
      questions: {},
    });
  });
});

describe("SubQ image media types", () => {
  it("map TypeSafe's formats and image content types", () => {
    expect(["png", "JPG", "jpeg", " webp ", "gif"].map(formatMediaType)).toEqual([
      "image/png",
      "image/jpeg",
      "image/jpeg",
      "image/webp",
      undefined,
    ]);
    expect(
      ["image/png", "image/jpg", "IMAGE/JPEG; q=1", "application/octet-stream", ""].map(
        partMediaType,
      ),
    ).toEqual(["image/png", "image/jpeg", "image/jpeg", undefined, undefined]);
  });

  it("tell PNG, JPEG and WebP apart by their first bytes", () => {
    expect(sniffImageType(Uint8Array.from(PNG_HEAD))).toBe("image/png");
    expect(sniffImageType(Uint8Array.from(JPEG_HEAD))).toBe("image/jpeg");
    expect(sniffImageType(Uint8Array.from(WEBP_HEAD))).toBe("image/webp");
    expect(sniffImageType(new TextEncoder().encode("GIF89a......"))).toBeUndefined();
    expect(sniffImageType(Uint8Array.from([0x89, 0x50]))).toBeUndefined();
  });
});

describe("base64", () => {
  it("measures the decoded size without decoding", () => {
    for (const length of [0, 1, 2, 3, 4, 5, 1000]) {
      const encoded = btoa("x".repeat(length));
      expect(base64DecodedSize(encoded)).toBe(length);
    }
  });

  it("encodes bytes in chunks, the same as btoa", () => {
    const bytes = Uint8Array.from({ length: 100_000 }, (_, index) => (index * 7) % 256);
    let binary = "";

    for (const byte of bytes) binary += String.fromCharCode(byte);

    expect(bytesToBase64(bytes)).toBe(btoa(binary));
  });
});
