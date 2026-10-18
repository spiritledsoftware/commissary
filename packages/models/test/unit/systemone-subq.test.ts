// SubQ's request body (`executor/systemone/subq.ts`, ADR 0032): TypeSafe assets become SubQ's `images` with their
// media types, and requests over SubQ's image limits are refused before any image is read or encoded.
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@commissary/json";
import { ExecutionError } from "../../src/executor/errors.ts";
import { subqBody } from "../../src/executor/systemone/subq.ts";

const MIB = 1024 * 1024;

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 1, 2]);

const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 6, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 9, 9]);

const GIF = new TextEncoder().encode("GIF89a........");

const base64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

const request = (assets: Record<string, JsonObject>, model = "subq-snap-preview"): JsonObject => ({
  model,
  state: Object.keys(assets).join(" and "),
  questions: { q: { type: "noul", instructions: "Are these the same?" } },
  assets,
});

const build = (body: JsonObject, parts?: ReadonlyMap<string, File>) =>
  Effect.runPromise(subqBody(body, parts));

const refusal = async (body: JsonObject, parts?: ReadonlyMap<string, File>) => {
  const error = await Effect.runPromise(Effect.flip(subqBody(body, parts)));

  expect(error).toBeInstanceOf(ExecutionError);
  expect(error).toMatchObject({ status: 400, requestScoped: true });

  return error.message;
};

/** A file part whose reads are counted. */
const watched = (bytes: Uint8Array | number, type: string) => {
  const file = new File([typeof bytes === "number" ? new Uint8Array(bytes) : bytes], "f", { type });

  return {
    file,
    arrayBuffer: vi.spyOn(file, "arrayBuffer"),
    slice: vi.spyOn(file, "slice"),
  };
};

describe("SubQ request bodies", () => {
  it("send multipart and inline assets as images in order, typed by format, content type or bytes", async () => {
    const typed = new File([PNG], "a.png", { type: "image/png" });
    const untyped = new File([WEBP], "b", { type: "application/octet-stream" });

    const built = await build(
      request({
        "<a>": { type: "image", part: "asset-0" },
        "<b>": { part: "asset-1" },
        "<c>": { format: "jpg", data_base64: "/9j/4AAQ" },
        "<d>": { data_base64: base64(PNG) },
      }),
      new Map([
        ["asset-0", typed],
        ["asset-1", untyped],
      ]),
    );

    expect(built).toEqual({
      json: {
        model: "subq-snap-preview",
        state: "[image 1] and [image 2] and [image 3] and [image 4]",
        questions: { q: { type: "noul", instructions: "Are these the same?" } },
        images: [
          { mediaType: "image/png", base64: base64(PNG) },
          { mediaType: "image/webp", base64: base64(WEBP) },
          { mediaType: "image/jpeg", base64: "/9j/4AAQ" },
          { mediaType: "image/png", base64: base64(PNG) },
        ],
      },
    });
  });

  it("send a text request as it is, as JSON", async () => {
    const body = { model: "subq-snap-preview", state: "s", questions: {} };

    expect(await build(body)).toEqual({ json: body });
  });

  it("refuse a fifth image before reading any", async () => {
    const parts = [0, 1, 2, 3, 4].map(() => watched(PNG, "image/png"));

    const message = await refusal(
      request(Object.fromEntries(parts.map((_, index) => [`<${index}>`, { part: `p${index}` }]))),
      new Map(parts.map((part, index) => [`p${index}`, part.file])),
    );

    expect(message).toBe("SubQ takes at most 4 images per request; this request has 5");
    expect(parts.every((part) => part.arrayBuffer.mock.calls.length === 0)).toBe(true);
  });

  it("refuse an image over 4 MiB, or 8 MiB in all, without reading or decoding it", async () => {
    const big = watched(4 * MIB + 1, "image/png");

    expect(await refusal(request({ "<a>": { part: "a" } }), new Map([["a", big.file]]))).toBe(
      "image 1 is 4194305 bytes; SubQ takes at most 4194304 bytes per image",
    );
    expect(big.arrayBuffer).not.toHaveBeenCalled();
    expect(big.slice).not.toHaveBeenCalled();

    // Inline base64 is measured by its length.
    const inline = "A".repeat(5_592_412);
    expect(await refusal(request({ "<a>": { format: "png", data_base64: inline } }))).toMatch(
      /^image 1 is 4194309 bytes;/,
    );

    const three = [0, 1, 2].map(() => watched(3 * MIB, "image/png"));
    expect(
      await refusal(
        request({ "<a>": { part: "a" }, "<b>": { part: "b" }, "<c>": { part: "c" } }),
        new Map(three.map((part, index) => ["abc".charAt(index), part.file])),
      ),
    ).toBe("the images are 9437184 bytes in all; SubQ takes at most 8388608 bytes per request");
    expect(three.every((part) => part.arrayBuffer.mock.calls.length === 0)).toBe(true);
  });

  it("refuse media types SubQ does not take", async () => {
    expect(
      await refusal(
        request({ "<a>": { part: "a" } }),
        new Map([["a", new File([GIF], "a.gif", { type: "image/gif" })]]),
      ),
    ).toBe("image 1 is image/gif; SubQ takes image/png, image/jpeg, image/webp");
    expect(
      await refusal(request({ "<a>": { part: "a" } }), new Map([["a", new File([GIF], "a")]])),
    ).toBe("image 1 is not a PNG, JPEG or WebP image");
    expect(await refusal(request({ "<a>": { format: "gif", data_base64: base64(GIF) } }))).toBe(
      "image 1 has an unsupported format (png, jpg, jpeg or webp)",
    );
  });

  it("refuse an asset without image data or naming a part that was not sent", async () => {
    expect(await refusal(request({ "<a>": { type: "image" } }))).toBe("image 1 has no image data");
    expect(await refusal(request({ "<a>": { part: "missing" } }))).toBe(
      "image 1 names a multipart part that was not sent",
    );
  });

  it("apply SubQ's limits to a model id the catalog does not know", async () => {
    const message = await refusal(
      request(
        Object.fromEntries(
          [0, 1, 2, 3, 4].map((index) => [`<${index}>`, { data_base64: base64(PNG) }]),
        ),
        "subq-snap-next",
      ),
    );

    expect(message).toBe("SubQ takes at most 4 images per request; this request has 5");
  });
});
