// Synthetic Gemini thought signatures for the Google executors' tests (no real provider payload).
import type { Json } from "@commissary/json";

const base64 = (bytes: ReadonlyArray<number>): string => btoa(String.fromCharCode(...bytes));

/**
 * A Vertex "bare-Tink" signature (Go `testGeminiBareTinkSignature`): the Tink prefix byte, the pinned Vertex key id
 * `8f3d6b5f`, then filler ciphertext. Only Vertex accepts it; Antigravity and the Gemini API reject it.
 */
export const vertexBareTink = (length = 405): string => {
  const payload = [0x01, 0x8f, 0x3d, 0x6b, 0x5f];

  while (payload.length < length) payload.push(0xa0 + (payload.length % 0x20));

  return base64(payload);
};

/** A native Gemini 3 signature: protobuf field 2 wrapping one field-1 record that starts with the Tink prefix byte. */
export const nativeGeminiSignature = (): string => {
  const inner = [0x01, 0x0c, 0x39, 0xd6, 0xc7, ...new TextEncoder().encode("cipher-text-bytes")];
  const container = [0x0a, inner.length, ...inner];

  return base64([0x12, container.length, ...container]);
};

/**
 * A user turn, a model turn (a text part, then a functionCall, both carrying `signature` unless it is `undefined`)
 * and its functionResponse.
 */
export const signedToolRound = (signature: string | undefined): Json[] => [
  { role: "user", parts: [{ text: "list files" }] },
  {
    role: "model",
    parts: [
      { text: "checking", ...(signature === undefined ? {} : { thoughtSignature: signature }) },
      {
        functionCall: { name: "ls", args: {} },
        ...(signature === undefined ? {} : { thoughtSignature: signature }),
      },
    ],
  },
  { role: "user", parts: [{ functionResponse: { name: "ls", response: { ok: true } } }] },
];

/** The parts of the model turn of `signedToolRound` in the body that reached the upstream. */
export const sentModelParts = (body: string | undefined): Array<Record<string, unknown>> =>
  JSON.parse(body ?? "{}").contents[1].parts;
