/**
 * TypeSafe's System One request as SubQ's Decisions API (ADR 0032, https://docs.subq.ai, Decisions API). Workers
 * addition, no Go counterpart. Pure: parsed JSON and bytes in, plain values out; reading the images and checking
 * SubQ's limits is the executor's (`executor/systemone/subq.ts` in `@commissary/models`).
 *
 * The two APIs differ only in their images. TypeSafe names each image in `assets` by a reference string that appears
 * where the image belongs (in `state`, `instructions` or `criteria`); SubQ takes a top-level `images` list of
 * `{mediaType, base64}` that every question sees. So every asset becomes an image, in asset order, and each reference
 * becomes a positional label (`[image 1]`, …): an image is no longer scoped to the question that named it. The
 * replacement is plain text, like TypeSafe's own, so a reference that also occurs as ordinary text is replaced there
 * too.
 */
import { isJsonObject, type Json, type JsonObject } from "@commissary/json";
import { systemOneAssets } from "./request.ts";

/** One image of a SubQ request: a media type and plain base64 (no `data:` prefix). */
export interface SubQImage {
  readonly mediaType: string;
  readonly base64: string;
}

/** The positional label of the image at `index` (zero-based) in the converted request. */
export const imageLabel = (index: number): string => `[image ${index + 1}]`;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Replaces every reference in the string values of `value` (object keys stay: choice option names are answer keys). */
const replaceIn = (value: Json, pattern: RegExp, labels: ReadonlyMap<string, string>): Json => {
  if (typeof value === "string") return value.replace(pattern, (ref) => labels.get(ref) ?? ref);

  if (Array.isArray(value)) return value.map((item) => replaceIn(item, pattern, labels));

  if (isJsonObject(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceIn(item, pattern, labels)]),
    );

  return value;
};

/**
 * SubQ's request from a TypeSafe request and its images (one per asset, in asset order, already read and encoded):
 * each asset reference in a string of `state` or of a question's `instructions` or `criteria` replaced by its label,
 * `assets` (and an `images` field the client sent) removed, and `images` set when there are any. Longer references
 * are replaced first, in one pass, so a reference that is part of another (`img1`, `img10`) or of a label is never
 * replaced inside it. `body` is not changed.
 */
export const toSubQRequest = (body: JsonObject, images: ReadonlyArray<SubQImage>): JsonObject => {
  const labels = new Map(
    systemOneAssets(body)
      .map((entry, index) => [entry.ref, imageLabel(index)] as const)
      .filter(([ref]) => ref !== ""),
  );

  const pattern = new RegExp(
    [...labels.keys()]
      .toSorted((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join("|"),
    "g",
  );

  const replace = (value: Json): Json =>
    labels.size === 0 ? value : replaceIn(value, pattern, labels);

  const question = (value: Json): Json =>
    isJsonObject(value)
      ? Object.fromEntries(
          Object.entries(value).map(([field, item]) => [
            field,
            field === "instructions" || field === "criteria" ? replace(item) : item,
          ]),
        )
      : value;

  const converted = Object.entries(body)
    // `images` is not TypeSafe's: SubQ's come from the assets only, so their limits hold.
    .filter(([key]) => key !== "assets" && key !== "images")
    .map(([key, value]): readonly [string, Json] => {
      if (key === "state") return [key, replace(value)];

      if (key === "questions" && isJsonObject(value))
        return [
          key,
          Object.fromEntries(Object.entries(value).map(([id, item]) => [id, question(item)])),
        ];

      return [key, value];
    });

  const sent = images.map((image) => ({ mediaType: image.mediaType, base64: image.base64 }));

  return Object.fromEntries(sent.length === 0 ? converted : [...converted, ["images", sent]]);
};

const FORMATS = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["webp", "image/webp"],
]);

/** The media type of an asset's `format` (TypeSafe's `png`, `jpg`, `jpeg`; also `webp`); `undefined` otherwise. */
export const formatMediaType = (format: string): string | undefined =>
  FORMATS.get(format.trim().toLowerCase());

/**
 * The media type of a multipart file part's content type when it names an image (`image/jpg` read as `image/jpeg`,
 * parameters dropped); `undefined` for none or `application/octet-stream`, whose bytes must tell.
 */
export const partMediaType = (contentType: string): string | undefined => {
  const type = (contentType.split(";")[0] ?? "").trim().toLowerCase();

  if (!type.startsWith("image/")) return undefined;

  return type === "image/jpg" ? "image/jpeg" : type;
};

const startsWithBytes = (bytes: Uint8Array, prefix: ReadonlyArray<number>, at = 0): boolean =>
  bytes.length >= at + prefix.length && prefix.every((byte, offset) => bytes[at + offset] === byte);

/** The bytes {@link sniffImageType} needs from the start of an image. */
export const SNIFF_BYTES = 12;

/** PNG, JPEG or WebP from an image's first bytes (its magic numbers); `undefined` for anything else. */
export const sniffImageType = (bytes: Uint8Array): string | undefined => {
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";

  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";

  // RIFF <size> WEBP
  if (
    startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWithBytes(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  )
    return "image/webp";

  return undefined;
};

/** The first bytes of plain base64 text (enough to sniff), `undefined` when they are not base64. */
export const base64Head = (text: string): Uint8Array | undefined => {
  try {
    return Uint8Array.from(atob(text.slice(0, (SNIFF_BYTES / 3) * 4)), (char) =>
      char.charCodeAt(0),
    );
  } catch {
    return undefined;
  }
};

/** The decoded size of plain base64 text, from its length and padding, without decoding it. */
export const base64DecodedSize = (text: string): number => {
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;

  return Math.max(0, Math.floor((text.length * 3) / 4) - padding);
};

const CHUNK = 0x8000;

/** Standard base64 of `bytes`, built in chunks so a large image needs no per-byte string. */
export const bytesToBase64 = (bytes: Uint8Array): string => {
  const pieces: string[] = [];

  for (let at = 0; at < bytes.length; at += CHUNK)
    pieces.push(String.fromCharCode(...bytes.subarray(at, at + CHUNK)));

  return btoa(pieces.join(""));
};
