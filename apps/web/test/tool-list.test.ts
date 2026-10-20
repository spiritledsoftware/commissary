// A toolkit's tool list (src/lib/tool-list.ts, #208, ADR 0037, ADR 0038): what each flag tells its managers, and the
// whole override each edit sends (hide, rename, describe anew, reclassify), keeping what the edit does not touch.
import { describe, expect, it } from "vitest";
import type { ToolView } from "@commissary/contract/tools";
import {
  draftOfTool,
  overrideBody,
  overrideRevision,
  resetBody,
  toolNameProblem,
  toolNotes,
} from "../src/lib/tool-list.ts";

const NO_FLAGS = { shortened: false, renamed: false, hidden: false, clash: false, missing: false };

const tool = (patch: Partial<ToolView> = {}): ToolView => ({
  id: "tk_1:create_issue",
  toolkit_id: "tk_1",
  upstream_name: "create_issue",
  name: "github_create_issue",
  description: "Creates an issue.",
  class: "write",
  flags: NO_FLAGS,
  ...patch,
});

const override = {
  revision: 3,
  hidden: false,
  updated_at: "2026-08-01T00:00:00.000Z",
  updated_by: "user:admin@example.com",
};

const notes = (flags: Partial<ToolView["flags"]>) =>
  toolNotes(tool({ flags: { ...NO_FLAGS, ...flags } })).map((note) => note.text);

describe("the flags", () => {
  it("say what each means and what to do", () => {
    expect(notes({ shortened: true })).toEqual([
      "Its full name was cut to 46 characters and ends in a hash: rename it.",
    ]);
    expect(notes({ clash: true })).toEqual([
      "Shadowed: another tool took its full name after a listing. Rename it to show it.",
    ]);
    expect(notes({ missing: true })).toEqual([
      "Gone upstream: its source no longer lists it. Reset its override to drop it.",
    ]);
    expect(notes({ deprecated: true, hidden: true })).toEqual([
      "Deprecated upstream, so hidden until you show it.",
    ]);
    expect(notes({ hidden: true })).toEqual(["Hidden by an override."]);
    expect(notes({})).toEqual([]);
  });

  it("mark only a vanished tool as failing: a name to change or a hidden tool is a note", () => {
    const severity = (flags: Partial<typeof NO_FLAGS>) =>
      toolNotes(tool({ flags: { ...NO_FLAGS, ...flags } }))[0]?.severity;

    expect(severity({ missing: true })).toBe("failing");
    expect(severity({ clash: true })).toBe("note");
    expect(severity({ shortened: true })).toBe("note");
    expect(severity({ hidden: true })).toBe("note");
  });
});

describe("the overrides", () => {
  it("start from the tool's override, and name its revision for If-Match (0 for none)", () => {
    expect(draftOfTool(tool())).toEqual({ hidden: false, name: "", description: "", class: "" });
    expect(overrideRevision(tool())).toBe(0);

    const overridden = tool({
      name: "github_open_issue",
      class: "read",
      flags: { ...NO_FLAGS, renamed: true },
      override: { ...override, name: "open_issue", class: "read" },
    });

    expect(draftOfTool(overridden)).toEqual({
      hidden: false,
      name: "open_issue",
      description: "",
      class: "read",
    });
    expect(overrideRevision(overridden)).toBe(3);
  });

  it("hide, rename, describe and reclassify a tool, each by its upstream name", () => {
    const draft = draftOfTool(tool());

    expect(overrideBody(tool(), { ...draft, hidden: true })).toEqual({
      tool: "create_issue",
      hidden: true,
    });
    expect(overrideBody(tool(), { ...draft, name: " open_issue " })).toEqual({
      tool: "create_issue",
      name: "open_issue",
    });
    expect(overrideBody(tool(), { ...draft, description: "Opens a ticket." })).toEqual({
      tool: "create_issue",
      description: "Opens a ticket.",
    });
    expect(overrideBody(tool(), { ...draft, class: "read" })).toEqual({
      tool: "create_issue",
      class: "read",
    });
  });

  it("show a deprecated tool with hidden: false, and keep a price an org admin set", () => {
    const deprecated = tool({ flags: { ...NO_FLAGS, deprecated: true, hidden: true } });

    expect(overrideBody(deprecated, { ...draftOfTool(deprecated), hidden: false })).toEqual({
      tool: "create_issue",
      hidden: false,
    });

    // The override is written whole, so one that leaves the price out would clear it (#199).
    const priced = tool({ override: { ...override, price_micros: 5000 } });

    expect(overrideBody(priced, { ...draftOfTool(priced), name: "open" })).toEqual({
      tool: "create_issue",
      name: "open",
      price_micros: 5000,
    });
    expect(resetBody(priced)).toEqual({ tool: "create_issue", price_micros: 5000 });
    expect(resetBody(tool())).toEqual({ tool: "create_issue" });
  });

  it("check a new name: lowercase letters, digits and _, within the 46 characters of a full name", () => {
    expect(toolNameProblem("open_issue", "github")).toBeUndefined();
    expect(toolNameProblem("", "github")).toBeUndefined();
    expect(toolNameProblem("Open-Issue", "github")).toBe(
      "A name holds lowercase letters, digits and _ only.",
    );
    expect(toolNameProblem("x".repeat(40), "github")).toBe(
      "github_ and the name are 47 characters; a full name is at most 46.",
    );
  });
});
