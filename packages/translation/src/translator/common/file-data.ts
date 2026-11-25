/**
 * OpenAI file content normalisation.
 *
 * Go source: internal/translator/common/file_data.go (NormalizeOpenAIFileData); `inlineDataAsDataUrl` is the data-URL
 * step of codexContentPartFromGeminiFileData and openAIContentPartFromGeminiFileData (34d8fe0f).
 */
import { mimeTypeForExtension } from "./mime-types.ts";

const extensionOf = (filename: string): string => {
  const base = filename.slice(filename.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");

  return dot < 0 ? "" : base.slice(dot + 1).toLowerCase();
};

/** Returns the MIME type and raw base64 payload of OpenAI `file_data`, or `undefined` when unusable. */
export const normalizeOpenAIFileData = (
  filename: string,
  fallbackMimeType: string,
  fileData: string,
): { readonly mimeType: string; readonly data: string } | undefined => {
  if (fileData === "") return undefined;
  let fallback = fallbackMimeType;

  if (fallback === "") {
    const ext = extensionOf(filename);
    fallback = mimeTypeForExtension(ext);
  }

  if (fileData.slice(0, 5).toLowerCase() !== "data:") {
    return fallback === "" ? undefined : { mimeType: fallback, data: fileData };
  }

  const rest = fileData.slice(5);
  const comma = rest.indexOf(",");

  if (comma < 0) return undefined;
  const metadata = rest.slice(0, comma);
  const payload = rest.slice(comma + 1);

  if (payload === "") return undefined;
  const fields = metadata.split(";");
  const mimeType = (fields[0] ?? "").trim();

  if (mimeType === "") return undefined;

  return fields.slice(1).some((field) => field.trim().toLowerCase() === "base64")
    ? { mimeType, data: payload }
    : undefined;
};

/** Gemini inline data as a data URL; data that already is one (any case, leading spaces allowed) stays as it is. */
export const inlineDataAsDataUrl = (mimeType: string, data: string): string =>
  data.trim().toLowerCase().startsWith("data:") ? data : `data:${mimeType};base64,${data}`;
