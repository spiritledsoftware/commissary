/**
 * Claude document blocks with a text or content source, for translators to non-Claude targets.
 *
 * Go source: internal/translator/common/claude_messages.go (ClaudeDocumentHeader, ClaudeDocumentTextBlock,
 * ExpandClaudeContentDocument).
 */
import { asString, get, isJsonArray, isJsonObject, type Json } from "@commissary/json";

/** `ClaudeDocumentHeader`: the document's optional title and context as a header, or "" without either. */
export const claudeDocumentHeader = (part: Json | undefined): string => {
  const title = asString(get(part, "title")).trim();
  const context = asString(get(part, "context")).trim();
  const lines: string[] = [];

  if (title !== "") lines.push(`Document: ${title}`);

  if (context !== "") lines.push(`Context: ${context}`);

  return lines.join("\n");
};

/**
 * `ClaudeDocumentTextBlock`: a plain-text document (`source.type == "text"`) as text, after its header. Undefined for
 * other sources and blank text.
 */
export const claudeDocumentTextBlock = (part: Json | undefined): string | undefined => {
  const source = get(part, "source");

  if (asString(get(source, "type")) !== "text") return undefined;
  const data = asString(get(source, "data"));

  if (data.trim() === "") return undefined;
  const header = claudeDocumentHeader(part);

  return header === "" ? data : `${header}\n${data}`;
};

/**
 * `ExpandClaudeContentDocument`: converts the nested text and image blocks of a document with
 * `source.type == "content"`. The header goes before the first converted item, and only if one converts; an image
 * `convertImage` rejects (or every image, without `convertImage`/`emitImage`) calls `onImageDrop`. True if anything was
 * emitted.
 */
export const expandClaudeContentDocument = <Image>(
  part: Json | undefined,
  emitText: (text: string) => void,
  convertImage?: (image: Json) => Image | undefined,
  emitImage?: (image: Image) => void,
  onImageDrop?: () => void,
): boolean => {
  const source = get(part, "source");

  if (asString(get(source, "type")) !== "content") return false;
  const content = get(source, "content");

  if (content === undefined) return false;
  const header = claudeDocumentHeader(part);
  let headerEmitted = false;
  let emitted = false;

  const emitHeader = (): void => {
    if (header === "" || headerEmitted) return;
    emitText(header);
    headerEmitted = true;
  };

  const emitNonBlankText = (text: string): void => {
    if (text.trim() === "") return;
    emitHeader();
    emitText(text);
    emitted = true;
  };

  if (typeof content === "string") {
    emitNonBlankText(content);

    return emitted;
  }

  if (!isJsonArray(content)) return false;

  for (const item of content) {
    if (typeof item === "string") {
      emitNonBlankText(item);
      continue;
    }

    if (!isJsonObject(item)) continue;

    switch (asString(get(item, "type"))) {
      case "text":
        emitNonBlankText(asString(get(item, "text")));
        break;
      case "image": {
        const image =
          convertImage !== undefined && emitImage !== undefined ? convertImage(item) : undefined;

        if (image === undefined || emitImage === undefined) {
          onImageDrop?.();
          break;
        }

        emitHeader();
        emitImage(image);
        emitted = true;
        break;
      }
    }
  }

  return emitted;
};
