/**
 * Restores Gemini thought signatures that rode Claude `thinking` carrier blocks onto their native parts (91aca317).
 *
 * Go source: internal/translator/gemini/claude/signature_carrier.go.
 */
import { asString, get, isJsonObject, type Json } from "@commissary/json";
import { isGeminiThoughtSignatureBypass } from "../../../signature/gemini.ts";
import { compatibleSignatureForProvider } from "../../../signature/provider.ts";
import { decodeGeminiClaudeCarrierSignature } from "../../common/gemini-claude-carrier.ts";

/** The `LastSignatureTarget` after a part the Claude translation drops: a later signature belongs to nothing. */
export const UNSUPPORTED_SIGNATURE_TARGET = "unsupported";

type Kind = "" | "text" | "function";

/**
 * `geminiClaudeCarrierSignatures`: block index -> the signature its Gemini part carries, for an assistant message's
 * content. A signature binds to a part of its own message only, and never across another semantic block.
 */
export const geminiClaudeCarrierSignatures = (blocks: ReadonlyArray<Json>): Map<number, string> => {
  const kinds: Kind[] = [];
  const transparent: boolean[] = [];

  for (const block of blocks) {
    let kind: Kind = "";
    let isTransparent = false;

    switch (asString(get(block, "type"))) {
      case "text":
        if (asString(get(block, "text")) !== "") kind = "text";
        else isTransparent = true;
        break;
      case "tool_use":
        if (isJsonObject(get(block, "input"))) kind = "function";
        break;
      // Omitted reasoning still forms a semantic boundary for its signature.
      case "thinking":
        if (asString(get(block, "thinking")) !== "") kind = "text";
        else isTransparent = true;
        break;
      default:
        break;
    }

    kinds.push(kind);
    transparent.push(isTransparent);
  }

  const previous: number[] = [];
  const next: number[] = Array.from({ length: blocks.length }, () => -1);
  let adjacent = -1;

  for (let i = 0; i < blocks.length; i++) {
    previous.push(adjacent);

    if (kinds[i] !== "") adjacent = i;
    else if (transparent[i] !== true) adjacent = -1;
  }

  adjacent = -1;

  for (let i = blocks.length - 1; i >= 0; i--) {
    next[i] = adjacent;

    if (kinds[i] !== "") adjacent = i;
    else if (transparent[i] !== true) adjacent = -1;
  }

  const signatures = new Map<number, string>();
  const sources = new Map<number, number>();

  for (const [i, block] of blocks.entries()) {
    if (asString(get(block, "type")) !== "thinking" || asString(get(block, "thinking")) !== "")
      continue;
    const decoded = decodeGeminiClaudeCarrierSignature(asString(get(block, "signature")));

    if (decoded === undefined || decoded.signature === "") continue;
    let target = next[i] ?? -1;

    if (decoded.marked) {
      if (decoded.direction === "previous") target = previous[i] ?? -1;
      else if (decoded.direction === "standalone") target = i;

      if (
        target < 0 ||
        (target !== i && decoded.target !== "any" && decoded.target !== kinds[target])
      )
        continue;
    } else {
      if (target < 0) target = previous[i] ?? -1;

      if (target < 0) target = i;
    }

    const signature = compatibleSignatureForProvider(
      "gemini",
      decoded.signature,
      kinds[target] === "function" ? "gemini_function_call" : "gemini_model_part",
    );

    if (signature === undefined || isGeminiThoughtSignatureBypass(signature)) continue;
    const oldSource = sources.get(target);
    const current = signatures.get(target);

    // Keep an earlier detached signature (on its own carrier) rather than silently replacing it.
    if (oldSource !== undefined && current !== undefined && current !== signature)
      signatures.set(oldSource, current);
    signatures.set(target, signature);
    sources.set(target, i);
  }

  return signatures;
};
