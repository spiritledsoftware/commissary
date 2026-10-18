/**
 * TypeSafe's System One API (ADR 0032), the client format of `/v1/systemone`: reading requests and upstream errors.
 * The provider conversions (SubQ's request, images and answers) live next to it.
 */
export { parseUpstreamSystemOneError, type SystemOneError } from "./errors.ts";

export {
  assetPart,
  assetRefs,
  countImages,
  hasBoxQuestion,
  type SystemOneAsset,
  systemOneAssets,
} from "./request.ts";

export {
  base64DecodedSize,
  base64Head,
  bytesToBase64,
  formatMediaType,
  imageLabel,
  partMediaType,
  SNIFF_BYTES,
  sniffImageType,
  type SubQImage,
  toSubQRequest,
} from "./subq.ts";
