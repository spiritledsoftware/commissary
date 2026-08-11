import { expect, it } from "vitest";

import { decodeCanonicalBase64, encodeCanonicalBase64 } from "../../src/sql/base64.js";

it("encodes and decodes canonical padded RFC 4648 Base64", () => {
  const vectors = [
    { bytes: [], encoded: "" },
    { bytes: [0x66], encoded: "Zg==" },
    { bytes: [0x66, 0x6f], encoded: "Zm8=" },
    { bytes: [0x66, 0x6f, 0x6f], encoded: "Zm9v" },
    { bytes: [0x66, 0x6f, 0x6f, 0x62], encoded: "Zm9vYg==" },
    { bytes: [0x66, 0x6f, 0x6f, 0x62, 0x61], encoded: "Zm9vYmE=" },
    { bytes: [0x66, 0x6f, 0x6f, 0x62, 0x61, 0x72], encoded: "Zm9vYmFy" },
    { bytes: [0xfb, 0xff], encoded: "+/8=" },
  ] as const;

  for (const { bytes, encoded } of vectors) {
    const value = Uint8Array.from(bytes);
    expect(encodeCanonicalBase64(value)).toBe(encoded);
    expect(decodeCanonicalBase64(encoded)).toEqual(value);
  }
});

it("rejects malformed, unpadded, and noncanonical Base64", () => {
  const invalidValues = [
    "Zg",
    "Zg=",
    "Zg===",
    "=m9v",
    "Zm=9",
    "Zm9v=",
    "Zm9v\n",
    "Zm9v ",
    "Zm9v_",
    "====",
    "AB==",
    "Zm9=",
  ];

  for (const value of invalidValues) {
    expect(decodeCanonicalBase64(value)).toBeUndefined();
  }
});
