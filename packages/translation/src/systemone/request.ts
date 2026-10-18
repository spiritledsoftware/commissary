/**
 * Reading TypeSafe's System One request (ADR 0032, https://docs.typesafe.ai/api): `{model, state, questions, assets?}`.
 * Questions are named, each with a `type` (`noul`, `choice`, `score`, `box`); `assets` maps a reference string (which
 * appears in `state`, `instructions` or `criteria`) to an image, sent inline (`format`, `data_base64`) or as a
 * multipart file part (`part`). Workers addition, no Go counterpart. Pure: parsed JSON in, plain values out.
 */
import { isJsonObject, type Json, type JsonObject } from "@commissary/json";

/** One asset of a request: its reference and its descriptor (`{type?, format?, data_base64?, part?}`). */
export interface SystemOneAsset {
  readonly ref: string;
  readonly asset: JsonObject;
}

/** The request's assets in the order the client listed them; non-object descriptors are skipped. */
export const systemOneAssets = (body: Json | undefined): ReadonlyArray<SystemOneAsset> => {
  const assets = isJsonObject(body) ? body["assets"] : undefined;

  if (!isJsonObject(assets)) return [];

  return Object.entries(assets).flatMap(([ref, asset]) =>
    isJsonObject(asset) ? [{ ref, asset }] : [],
  );
};

/** The asset references of a request, in order. */
export const assetRefs = (body: Json | undefined): ReadonlyArray<string> =>
  systemOneAssets(body).map((entry) => entry.ref);

/** The multipart part an asset names (`assets.<ref>.part`), if any. */
export const assetPart = (asset: JsonObject): string | undefined => {
  const part = asset["part"];

  return typeof part === "string" ? part : undefined;
};

/**
 * How many images a request carries: every asset is an image (TypeSafe has no other asset type), whether inline or a
 * multipart part.
 */
export const countImages = (body: Json | undefined): number => systemOneAssets(body).length;

/** Whether any question is a Box question (`type: "box"`, Jev 1.14 only). */
export const hasBoxQuestion = (body: Json | undefined): boolean => {
  const questions = isJsonObject(body) ? body["questions"] : undefined;

  if (!isJsonObject(questions)) return false;

  return Object.values(questions).some(
    (question) =>
      isJsonObject(question) &&
      typeof question["type"] === "string" &&
      question["type"].trim().toLowerCase() === "box",
  );
};
