/**
 * Bare Codex patches in Devin's `invalid_json_str`.
 *
 * Go source: internal/runtime/executor/helps/devin_apply_patch_diagnostic.go (`CanBeDevinBareApplyPatchPrefix`,
 * `RecoverDevinBareApplyPatch`). Devin sometimes sends the patch of a custom `apply_patch` tool as raw text instead of
 * `{"input": ...}` JSON; a complete, well-framed patch is wrapped into the JSON arguments instead of failing the call.
 * The Go diagnostics that go with it (byte counts, prefix shapes and parse error classes of rejected calls, for logs)
 * are not ported: this executor keeps no request logs.
 */
import { wrapApplyPatchInput } from "@commissary/translation";

const PATCH_MARKER = "*** Begin Patch";

const PATCH_END_MARKER = "*** End Patch";

/** Go `strings.TrimLeft(raw, " \t\r\n")`. */
const trimLeftSpace = (raw: string): string => raw.replace(/^[ \t\r\n]+/, "");

/** Go `strings.TrimSpace` (Unicode white space). */
const trimSpace = (raw: string): string => raw.replace(/^[\s\uFEFF]+|[\s\uFEFF]+$/g, "");

/** Whether `raw` can still become a valid bare apply_patch payload as further streaming chunks arrive. */
export const canBeDevinBareApplyPatchPrefix = (raw: string): boolean => {
  const trimmed = trimLeftSpace(raw);

  if (trimmed === "") return true;

  if (trimmed.length < PATCH_MARKER.length) return PATCH_MARKER.startsWith(trimmed);

  if (!trimmed.startsWith(PATCH_MARKER)) return false;

  if (trimmed.length === PATCH_MARKER.length) return true;
  const next = trimmed[PATCH_MARKER.length];

  return next === "\n" || next === "\r";
};

type Section = "" | "add" | "delete" | "update";

/** The section being read (kept in an object: the helpers below change it, which narrowing would not follow). */
interface Parse {
  mode: Section;
}

/**
 * Validates that `raw` is a complete, well-framed bare Codex apply_patch payload and wraps it into `{"input": "..."}`;
 * `undefined` when it is not (truncated, empty, a section without a body, malformed headers).
 */
export const recoverDevinBareApplyPatch = (raw: string): string | undefined => {
  const trimmed = trimSpace(raw);
  const lines = trimmed.split("\n").map((line) => line.replace(/\r$/, ""));

  if (lines.length < 3) return undefined;

  if (lines[0] !== PATCH_MARKER || lines[lines.length - 1] !== PATCH_END_MARKER) return undefined;

  let sawEnvId = false;
  const state: Parse = { mode: "" };
  let fileOps = 0;
  let sectionHasBody = false;
  let hasMove = false;
  let inHunk = false;
  let hunkHasLines = false;
  let afterEof = false;

  const canCloseSection = (): boolean => {
    if ((state.mode === "add" || state.mode === "update") && !sectionHasBody) return false;

    if (state.mode === "update" && inHunk && !hunkHasLines) return false;

    return true;
  };

  const argumentOf = (line: string, prefix: string): string => trimSpace(line.slice(prefix.length));

  const openSection = (next: Section, hasBody: boolean): void => {
    state.mode = next;
    sectionHasBody = hasBody;
    hasMove = false;
    inHunk = false;
    hunkHasLines = false;
    afterEof = false;
    fileOps++;
  };

  for (const line of lines.slice(1, -1)) {
    if (line.startsWith("***")) {
      if (line.startsWith("*** Environment ID: ")) {
        if (state.mode !== "" || sawEnvId || argumentOf(line, "*** Environment ID: ") === "")
          return undefined;
        sawEnvId = true;
      } else if (line.startsWith("*** Add File: ")) {
        if (!canCloseSection() || argumentOf(line, "*** Add File: ") === "") return undefined;
        openSection("add", false);
      } else if (line.startsWith("*** Delete File: ")) {
        if (!canCloseSection() || argumentOf(line, "*** Delete File: ") === "") return undefined;
        openSection("delete", true);
      } else if (line.startsWith("*** Update File: ")) {
        if (!canCloseSection() || argumentOf(line, "*** Update File: ") === "") return undefined;
        openSection("update", false);
      } else if (line.startsWith("*** Move to: ")) {
        if (
          state.mode !== "update" ||
          hasMove ||
          sectionHasBody ||
          inHunk ||
          afterEof ||
          argumentOf(line, "*** Move to: ") === ""
        ) {
          return undefined;
        }

        hasMove = true;
      } else if (line === "*** End of File") {
        if (state.mode !== "update" || !inHunk || !hunkHasLines || afterEof) return undefined;
        afterEof = true;
      } else {
        return undefined;
      }

      continue;
    }

    if (state.mode === "add") {
      if (!line.startsWith("+")) return undefined;
      sectionHasBody = true;
    } else if (state.mode === "update") {
      if (afterEof) return undefined;

      if (line === "@@" || line.startsWith("@@ ")) {
        if (inHunk && !hunkHasLines) return undefined;
        inHunk = true;
        hunkHasLines = false;
      } else if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {
        inHunk = true;
        hunkHasLines = true;
        sectionHasBody = true;
      } else {
        return undefined;
      }
    } else {
      return undefined;
    }
  }

  if (fileOps === 0 || !canCloseSection()) return undefined;

  return wrapApplyPatchInput(trimmed);
};
