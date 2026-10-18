// System One (ADR 0032) pieces that need no Worker: multipart bodies, upstream error classification, usage and its
// price, the local refusals, the catalog records and their registration, the model listing.
import { describe, expect, it } from "vitest";
import { embeddedCatalogs, catalogAdditions } from "../../src/registry/catalog.ts";
import { openaiEntry } from "../../src/registry/listings.ts";
import { systemOneRefusal } from "../../src/executor/systemone/capabilities.ts";
import {
  systemOneUpstreamError,
  typeSafeUpstreamError,
} from "../../src/executor/systemone/errors.ts";
import { encodeMultipart, parseMultipart } from "../../src/executor/systemone/multipart.ts";
import { parseSystemOneUsage } from "../../src/executor/systemone/usage.ts";
import { tokenAccountingSemanticsFor } from "../../src/usage/accounting.ts";
import { costOf, findPrice } from "../../src/usage/pricing.ts";

const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (char) => char.charCodeAt(0),
);

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

describe("System One multipart bodies", () => {
  it("round-trip the request part and binary file parts unchanged", async () => {
    const encoded = encodeMultipart(
      [
        { name: "request", value: { json: '{"model":"jev-latest"}' } },
        { name: "asset-0", value: { file: new File([PNG], "asset-0", { type: "image/png" }) } },
        { name: "raw", value: { file: new File([new Uint8Array([0, 255, 13, 10, 45, 45])], "x") } },
      ],
      "b0undary",
    );

    expect(encoded.contentType).toBe("multipart/form-data; boundary=b0undary");
    const parsed = parseMultipart(await bytesOf(encoded.body), encoded.contentType);

    if (!parsed.ok) throw new Error(parsed.error);
    expect(
      parsed.parts.map(({ name, filename, contentType }) => ({ name, filename, contentType })),
    ).toEqual([
      { name: "request", contentType: "application/json" },
      { name: "asset-0", filename: "asset-0", contentType: "image/png" },
      { name: "raw", filename: "x" },
    ]);
    expect(new TextDecoder().decode(parsed.parts[0]?.body)).toBe('{"model":"jev-latest"}');
    expect(parsed.parts[1]?.body).toEqual(PNG);
    expect(parsed.parts[2]?.body).toEqual(new Uint8Array([0, 255, 13, 10, 45, 45]));
  });

  it("keep the bytes of a file part without a filename, after a preamble, with a quoted boundary", () => {
    const head = new TextEncoder().encode(
      'preamble\r\n--q b\r\nContent-Disposition: form-data; name="img"\r\n\r\n',
    );

    const tail = new TextEncoder().encode("\r\n--q b--\r\n");
    const body = new Uint8Array([...head, ...PNG, ...tail]);
    const parsed = parseMultipart(body, 'multipart/form-data; boundary="q b"');

    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.parts).toHaveLength(1);
    expect(parsed.parts[0]?.filename).toBeUndefined();
    expect(parsed.parts[0]?.body).toEqual(PNG);
  });

  it("refuse bodies without a boundary or a terminator", () => {
    expect(parseMultipart(new Uint8Array(), "multipart/form-data")).toEqual({
      ok: false,
      error: "multipart body has no boundary",
    });

    const open = new TextEncoder().encode(
      '--b\r\nContent-Disposition: form-data; name="a"\r\n\r\nx',
    );

    expect(parseMultipart(open, "multipart/form-data; boundary=b").ok).toBe(false);
  });
});

describe("System One upstream errors", () => {
  const error = (status: number, body = "{}", headers: Record<string, string> = {}) => ({
    status,
    body,
    headers: new Headers(headers),
    nowMs: 0,
  });

  it("cool the key on 401 and 402, and on TypeSafe's missing-key 403", () => {
    expect(systemOneUpstreamError(error(401)).credentialScoped).toBe(true);
    expect(systemOneUpstreamError(error(402)).credentialScoped).toBe(true);

    const missing =
      '{"detail":{"error_type":"authentication_error","message":"Must supply an API key! Check your request."}}';

    expect(typeSafeUpstreamError(error(403, missing)).credentialScoped).toBe(true);
    expect(typeSafeUpstreamError(error(403)).credentialScoped).toBeUndefined();
  });

  it("take the Retry-After of 429 and of TypeSafe's 529 as the cooldown hint, keeping status and body", () => {
    const limited = systemOneUpstreamError(error(429, "slow", { "retry-after": "7" }));
    expect(limited).toMatchObject({ status: 429, message: "slow", retryAfterMs: 7000 });
    expect(limited.headers?.["retry-after"]).toBe("7");
    expect(
      typeSafeUpstreamError(error(529, "busy", { "retry-after-ms": "250" })).retryAfterMs,
    ).toBe(250);
    expect(systemOneUpstreamError(error(422)).credentialScoped).toBeUndefined();
  });
});

describe("System One usage", () => {
  it("counts input and output tokens independently and prices them at the catalog addition's price", () => {
    const detail = parseSystemOneUsage({
      model: "jev-1.13.0",
      answers: {},
      usage: { input_tokens: 1_000_000, output_tokens: 20 },
    });

    expect(detail).toMatchObject({
      inputTokens: 1_000_000,
      outputTokens: 20,
      totalTokens: 1_000_020,
    });
    expect(detail?.tokenBreakdown).toMatchObject({
      quality: "complete",
      input: { uncachedTokens: 1_000_000, cacheReadTokens: 0 },
      output: { nonReasoningTokens: 20, reasoningTokens: 0 },
    });
    expect(parseSystemOneUsage({ answers: {} })).toBeUndefined();

    const sources = { docs: [], overrides: [], additions: catalogAdditions() };
    const breakdown = detail?.tokenBreakdown;

    if (breakdown === undefined) throw new Error("no breakdown");
    expect(costOf(findPrice(sources, "typesafe", "jev-latest"), breakdown)).toEqual({
      micros: 42_000,
      unpriced: false,
    });
    expect(costOf(findPrice(sources, "subq", "subq-snap-preview"), breakdown).micros).toBe(50_000);
    expect(costOf(findPrice(sources, "opencode-zen", "jev-1.13-free"), breakdown)).toEqual({
      micros: 0,
      unpriced: false,
    });
    expect(findPrice({ docs: [], overrides: [] }, "typesafe", "jev-latest")).toBeUndefined();
    const override = { id: "o", provider: "typesafe", model: "jev-latest", input: 1, output: 0 };
    expect(
      costOf(findPrice({ ...sources, overrides: [override] }, "typesafe", "jev-latest"), breakdown)
        .micros,
    ).toBe(1_000_000);
  });

  it("uses independent accounting for the new providers", () => {
    expect(tokenAccountingSemanticsFor("typesafe", "")).toBe("independent");
    expect(tokenAccountingSemanticsFor("subq", "")).toBe("independent");
  });
});

describe("System One local refusals", () => {
  const box = {
    model: "x",
    state: "s",
    questions: { where: { type: "box", instructions: "where?" } },
  };

  const image = {
    model: "x",
    state: "<image:a>",
    questions: { q: { type: "noul", instructions: "?" } },
    assets: { "<image:a>": { format: "png", data_base64: "iVBORw0K" } },
  };

  it("refuse Box on a model without it and images where the catalog says none", () => {
    expect(
      systemOneRefusal({
        provider: "typesafe",
        displayName: "TypeSafe",
        model: "jev-1.13.0",
        body: box,
      }),
    ).toMatchObject({
      status: 400,
      requestScoped: true,
      message: "jev-1.13.0 on TypeSafe does not support Box questions",
    });
    expect(
      systemOneRefusal({
        provider: "subq",
        displayName: "SubQ",
        model: "subq-snap-preview",
        body: box,
      })?.status,
    ).toBe(400);
    expect(
      systemOneRefusal({
        provider: "opencode-zen",
        displayName: "OpenCode Zen",
        model: "jev-1.13",
        body: image,
      })?.message,
    ).toBe("jev-1.13 on OpenCode Zen does not accept images");
  });

  it("let through what the model serves and models the catalog does not know", () => {
    for (const model of ["jev-1.14.0", "jev-preview", "jev-1.15.0"])
      expect(
        systemOneRefusal({ provider: "typesafe", displayName: "TypeSafe", model, body: box }),
      ).toBeUndefined();
    expect(
      systemOneRefusal({
        provider: "typesafe",
        displayName: "TypeSafe",
        model: "jev-latest",
        body: image,
      }),
    ).toBeUndefined();
  });
});

describe("System One catalog and registration", () => {
  it("keeps Zen's System One records in their own section", () => {
    expect(embeddedCatalogs().models["opencode-zen"].map((model) => model.id)).toEqual([
      "jev-1.13",
      "jev-1.13-free",
    ]);
  });

  it("lists a System One model with its type in the OpenAI model list, and nothing else gains one", () => {
    const [jev] = embeddedCatalogs().models.typesafe;

    if (jev === undefined) throw new Error("no TypeSafe model");
    expect(openaiEntry(jev)).toEqual({
      id: "jev-1.13.0",
      object: "model",
      owned_by: "typesafe",
      type: "systemone",
    });
    expect(openaiEntry({ ...jev, type: "claude" })).not.toHaveProperty("type");
  });
});
