/**
 * SubQ's request body (ADR 0032): the client's TypeSafe request converted to SubQ's Decisions API, always JSON. Workers
 * addition, no Go counterpart; the conversion itself is `toSubQRequest` (`@commissary/translation/systemone`).
 *
 * Every asset, inline (`data_base64`) or a multipart file part, becomes an `images` entry `{mediaType, base64}` in asset
 * order. The media type comes from the asset's `format`, else the part's image content type, else the image's first
 * bytes (a part sent as `application/octet-stream` or without a type). SubQ's limits (the catalog's `systemOne.images`:
 * count, bytes per image, bytes in all, media types) are checked from the asset count, `File.size` and the length of
 * the inline base64 before any image is read or encoded: a Worker has 128 MB of memory. Only then are the parts read
 * and encoded; inline base64 goes on as the client sent it.
 */
import { Effect } from "effect";
import type { JsonObject } from "@commissary/json";
import {
  assetPart,
  base64DecodedSize,
  base64Head,
  bytesToBase64,
  formatMediaType,
  partMediaType,
  SNIFF_BYTES,
  sniffImageType,
  type SubQImage,
  systemOneAssets,
  toSubQRequest,
} from "@commissary/translation/systemone";
import { ExecutionError } from "../errors.ts";
import { systemOneCapabilities } from "./capabilities.ts";
import type { SystemOneBody } from "./executor.ts";
import { SUBQ } from "./providers.ts";

/** SubQ's catalog model, whose image limits (the same for the whole Decisions API) also apply to ids the catalog lacks. */
export const SUBQ_SNAP = "subq-snap-preview";

const refused = (message: string): ExecutionError =>
  new ExecutionError({ status: 400, message, requestScoped: true });

const readFailed = () =>
  new ExecutionError({ status: 500, message: "could not read a multipart image part" });

/** One image as the client sent it: its size and, when known without reading it, its media type. */
type Source =
  | {
      readonly kind: "inline";
      readonly data: string;
      readonly size: number;
      readonly mediaType?: string;
    }
  | {
      readonly kind: "part";
      readonly file: File;
      readonly size: number;
      readonly mediaType?: string;
    };

const sourceOf = (
  asset: JsonObject,
  label: string,
  parts: ReadonlyMap<string, File> | undefined,
): Source | ExecutionError => {
  const format = asset["format"];
  let mediaType: string | undefined;

  if (typeof format === "string" && format.trim() !== "") {
    mediaType = formatMediaType(format);

    if (mediaType === undefined)
      return refused(`${label} has an unsupported format (png, jpg, jpeg or webp)`);
  }

  const partName = assetPart(asset);

  if (partName !== undefined) {
    const file = parts?.get(partName);

    if (file === undefined) return refused(`${label} names a multipart part that was not sent`);

    const type = mediaType ?? partMediaType(file.type);

    return {
      kind: "part",
      file,
      size: file.size,
      ...(type === undefined ? {} : { mediaType: type }),
    };
  }

  const data = asset["data_base64"];

  if (typeof data !== "string" || data === "") return refused(`${label} has no image data`);

  return {
    kind: "inline",
    data,
    size: base64DecodedSize(data),
    ...(mediaType === undefined ? {} : { mediaType }),
  };
};

/** The media type of an image whose format and content type did not say: its first bytes. */
const sniffed = (source: Source): Effect.Effect<string | undefined, ExecutionError> =>
  source.kind === "inline"
    ? Effect.succeed(sniffImageType(base64Head(source.data) ?? new Uint8Array()))
    : Effect.tryPromise({
        try: () => source.file.slice(0, SNIFF_BYTES).arrayBuffer(),
        catch: readFailed,
      }).pipe(Effect.map((head) => sniffImageType(new Uint8Array(head))));

const encoded = (source: Source): Effect.Effect<string, ExecutionError> =>
  source.kind === "inline"
    ? Effect.succeed(source.data)
    : Effect.tryPromise({ try: () => source.file.arrayBuffer(), catch: readFailed }).pipe(
        Effect.map((bytes) => bytesToBase64(new Uint8Array(bytes))),
      );

const describeCount = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

/** SubQ's body from the client's TypeSafe request and its multipart file parts. */
export const subqBody = Effect.fnUntraced(function* (
  body: JsonObject,
  parts: ReadonlyMap<string, File> | undefined,
): Effect.fn.Return<SystemOneBody, ExecutionError> {
  const assets = systemOneAssets(body);

  if (assets.length === 0) return { json: toSubQRequest(body, []) };
  const model = typeof body["model"] === "string" ? body["model"] : "";

  const limits =
    systemOneCapabilities(SUBQ, model)?.images ?? systemOneCapabilities(SUBQ, SUBQ_SNAP)?.images;

  if (limits === false) return yield* refused("SubQ does not accept images for this model");
  const { max, maxBytes, totalBytes, mediaTypes } = limits ?? {};

  if (max !== undefined && assets.length > max)
    return yield* refused(
      `SubQ takes at most ${describeCount(max, "image")} per request; this request has ${assets.length}`,
    );
  const sources: Source[] = [];
  let total = 0;

  for (const [index, { asset }] of assets.entries()) {
    const label = `image ${index + 1}`;
    const source = sourceOf(asset, label, parts);

    if (source instanceof ExecutionError) return yield* source;

    if (maxBytes !== undefined && source.size > maxBytes)
      return yield* refused(
        `${label} is ${source.size} bytes; SubQ takes at most ${maxBytes} bytes per image`,
      );
    total += source.size;
    sources.push(source);
  }

  if (totalBytes !== undefined && total > totalBytes)
    return yield* refused(
      `the images are ${total} bytes in all; SubQ takes at most ${totalBytes} bytes per request`,
    );
  const types: string[] = [];

  for (const [index, source] of sources.entries()) {
    const mediaType = source.mediaType ?? (yield* sniffed(source));

    if (mediaType === undefined)
      return yield* refused(`image ${index + 1} is not a PNG, JPEG or WebP image`);

    if (mediaTypes !== undefined && !mediaTypes.includes(mediaType))
      return yield* refused(
        `image ${index + 1} is ${mediaType}; SubQ takes ${mediaTypes.join(", ")}`,
      );
    types.push(mediaType);
  }

  const images: SubQImage[] = [];

  for (const [index, source] of sources.entries())
    images.push({ mediaType: types[index] ?? "", base64: yield* encoded(source) });

  return { json: toSubQRequest(body, images) };
});
