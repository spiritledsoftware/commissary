// The Account page's Routing form (src/lib/account-fields.ts): applicability, the draft, the server's checks,
// the change count and the request body (changed fields only, null deletes, masked headers kept).
import { describe, expect, it } from "vite-plus/test";
import type { CredentialEntry } from "@commissary/contract/credentials";
import {
  appliesTo,
  changedFields,
  draftErrors,
  draftOf,
  type Edits,
  exclusionList,
  type HeaderRow,
  isSecretRow,
  maskTail,
  patchOf,
  rebaseEdits,
  serverError,
} from "../src/lib/account-fields.ts";

const entry = (overrides: Partial<CredentialEntry> = {}): CredentialEntry => ({
  id: "claude.json",
  auth_index: "0",
  name: "claude.json",
  type: "claude",
  provider: "claude",
  label: "",
  status: "active",
  status_message: "",
  disabled: false,
  unavailable: false,
  runtime_only: false,
  source: "file",
  size: 0,
  success: 0,
  failed: 0,
  recent_requests: [],
  quota: { signals: {} },
  cooldowns: [],
  ...overrides,
});

const MASK = "[redacted]…abcd";

const configured = entry({
  priority: 5,
  weight: 2,
  prefix: "team",
  disable_cooling: true,
  headers: { Authorization: MASK, "X-Team": "blue" },
  excluded_models: ["claude-3-*"],
  model_aliases: [
    { name: "claude-opus-4-5", alias: "opus", "display-name": "Opus" },
    { name: "claude-haiku-4-5", alias: "haiku", fork: true },
  ],
});

describe("appliesTo", () => {
  it("shows websockets for Codex only and aliases for every provider but gemini", () => {
    expect(appliesTo("codex", "websockets")).toBe(true);
    expect(appliesTo("claude", "websockets")).toBe(false);
    expect(appliesTo("xai", "websockets")).toBe(false);
    expect(appliesTo("gemini", "model_aliases")).toBe(false);
    expect(appliesTo("gemini-cli", "model_aliases")).toBe(true);
    expect(appliesTo("gemini", "prefix")).toBe(true);
  });
});

describe("draftOf", () => {
  it("reads the account's values, marking hidden header values", () => {
    const draft = draftOf(configured);

    expect(draft).toMatchObject({
      priority: "5",
      weight: "2",
      request_retry: "",
      prefix: "team",
      disable_cooling: "never",
      websockets: false,
      excluded_models: "claude-3-*",
    });
    expect(draft.headers).toEqual([
      expect.objectContaining({
        name: "Authorization",
        value: MASK,
        hidden: { name: "Authorization", mask: MASK },
      }),
      expect.objectContaining({ name: "X-Team", value: "blue", hidden: undefined }),
    ]);
    expect(draft.model_aliases[0]).toMatchObject({
      name: "claude-opus-4-5",
      alias: "opus",
      fork: false,
      kept: { "display-name": "Opus" },
    });
    expect(draftOf(entry({ disable_cooling: false })).disable_cooling).toBe("cool");
    expect(draftOf(entry()).disable_cooling).toBe("routing");
  });

  it("shows the tail of a mask", () => {
    expect(maskTail(MASK)).toBe("…abcd");
    expect(maskTail("[redacted]")).toBeUndefined();
  });
});

describe("changes and the request", () => {
  it("counts only touched fields that differ, the way the server stores them", () => {
    const draft = draftOf(configured);

    const edits: Edits = {
      priority: "05",
      prefix: " team ",
      excluded_models: "Claude-3-*\n\n",
      weight: "3",
      disable_cooling: "routing",
    };

    expect(changedFields(configured, edits)).toEqual(["weight", "disable_cooling"]);
    expect(patchOf(configured, edits)).toEqual({ weight: 3, disable_cooling: null });
    // Reordering nothing in the headers is not a change.
    expect(changedFields(configured, { headers: draft.headers.toReversed() })).toEqual([]);
  });

  it("sends null to clear a field and the routing default applies again", () => {
    expect(
      patchOf(configured, {
        priority: "",
        weight: " ",
        prefix: "",
        excluded_models: "",
        model_aliases: [],
        headers: [],
      }),
    ).toEqual({
      priority: null,
      weight: null,
      prefix: null,
      excluded_models: null,
      model_aliases: null,
      headers: null,
    });
  });

  it("merges headers: the mask goes back unchanged, removed headers send an empty value", () => {
    const [secret, team] = draftOf(configured).headers;

    expect(
      patchOf(configured, {
        headers: [
          secret!,
          { ...team!, value: "red" },
          { id: "n", name: "X-New", value: "1", hidden: undefined },
        ],
      }),
    ).toEqual({ headers: { "X-Team": "red", "X-New": "1" } });
    expect(patchOf(configured, { headers: [team!] })).toEqual({ headers: { Authorization: "" } });
    // Replacing the hidden value sends the new one.
    expect(
      patchOf(configured, {
        headers: [{ ...secret!, value: "Bearer new", hidden: undefined }, team!],
      }),
    ).toEqual({ headers: { Authorization: "Bearer new" } });
  });

  it("keeps the alias settings the form does not show and sends websockets only when on", () => {
    const aliases = draftOf(configured).model_aliases;

    expect(
      patchOf(configured, {
        model_aliases: [{ ...aliases[0]!, alias: "big", fork: true }, aliases[1]!],
      }),
    ).toEqual({
      model_aliases: [
        { name: "claude-opus-4-5", alias: "big", "display-name": "Opus", fork: true },
        { name: "claude-haiku-4-5", alias: "haiku", fork: true },
      ],
    });

    const codex = entry({ provider: "codex", websockets: true });

    expect(patchOf(codex, { websockets: false })).toEqual({ websockets: null });
    expect(patchOf(entry({ provider: "codex" }), { websockets: true })).toEqual({
      websockets: true,
    });
  });

  it("drops edits the refreshed account already shows", () => {
    const edits: Edits = { weight: "3", prefix: "other" };
    const saved = { ...configured, weight: 3 };

    expect(rebaseEdits(saved, edits)).toEqual({ prefix: "other" });
  });

  it("stores exclusions lower-cased and de-duplicated, one per line or comma", () => {
    expect(exclusionList(" GPT-5 \ngpt-5, claude-*\n")).toEqual(["gpt-5", "claude-*"]);
  });
});

const row = (name: string, alias: string) => ({
  id: `${name}:${alias}`,
  name,
  alias,
  fork: false,
  kept: {},
});

describe("draftErrors", () => {
  it("mirrors the server's checks on touched fields only", () => {
    expect(draftErrors(configured, {})).toEqual({});
    expect(
      draftErrors(configured, {
        priority: "1.5",
        weight: "1000001",
        request_retry: "-1",
        prefix: "a/b",
        excluded_models: "gpt 5",
      }),
    ).toEqual({
      priority: { message: expect.stringContaining("whole number") },
      weight: { message: expect.stringContaining("0 to 1,000,000") },
      request_retry: { message: expect.stringContaining("0 or more") },
      prefix: { message: expect.stringContaining("/") },
      excluded_models: { message: expect.stringContaining("has a space") },
    });
    expect(draftErrors(configured, { prefix: "a b" }).prefix?.message).toBe(
      "A prefix has no spaces.",
    );
    // Outer slashes are dropped like the server does.
    expect(draftErrors(configured, { prefix: "/squad/" })).toEqual({});
    expect(draftErrors(configured, { weight: "0", request_retry: "0" })).toEqual({});
  });

  it("checks aliases like the server and names the row", () => {
    expect(draftErrors(configured, { model_aliases: [row("a", "")] }).model_aliases).toEqual({
      message: expect.stringContaining("Enter the name clients call"),
      row: "a:",
    });
    expect(
      draftErrors(configured, { model_aliases: [row("a", "A")] }).model_aliases?.message,
    ).toContain("provider's own name");
    expect(
      draftErrors(configured, { model_aliases: [row("a", "x"), row("b", "X")] }).model_aliases,
    ).toEqual({ message: "X is already the alias of a.", row: "b:X" });
    // Blank rows are ignored.
    expect(draftErrors(configured, { model_aliases: [row(" ", "")] })).toEqual({});
  });

  it("refuses bad header names, duplicates, empty values and a mask that is not the row's own", () => {
    const [secret, team] = draftOf(configured).headers;

    const errors = (headers: NonNullable<Edits["headers"]>) =>
      draftErrors(configured, { headers }).headers?.message;

    expect(errors([{ ...team!, name: "Bad Name" }])).toContain("is not a header name");
    expect(errors([team!, { ...team!, id: "2", name: "x-team" }])).toBe("x-team is listed twice.");
    expect(errors([{ ...team!, value: "" }])).toContain("Enter a value for X-Team");
    expect(errors([{ ...team!, name: "" }])).toContain("Enter a name");
    // Renaming the row of a hidden value, or pasting a mask or marker into another header.
    expect(errors([{ ...secret!, name: "X-Auth" }])).toContain("only under its own name");
    expect(errors([{ ...team!, value: MASK }])).toContain("not its own");
    expect(errors([{ ...team!, value: "Bearer [REDACTED]" }])).toContain("not its own");
    expect(errors([{ ...team!, value: "[new secret]" }])).toContain("not its own");
    // The error names the row it is about.
    expect(
      draftErrors(configured, { headers: [secret!, { ...team!, value: "" }] }).headers,
    ).toEqual({ message: expect.any(String), row: team!.id });
    // Kept as it is, or replaced: fine.
    expect(errors([secret!, team!])).toBeUndefined();
    expect(
      errors([{ ...secret!, name: "X-Auth", value: "new", hidden: undefined }]),
    ).toBeUndefined();
  });
});

describe("serverError", () => {
  const draft = draftOf(configured);

  it("maps a 422 path to its field and row", () => {
    const team = draft.headers[1]!;

    expect(serverError(draft, "headers.x-team", "Bad.")).toEqual({
      key: "headers",
      error: { message: "Bad.", row: team.id },
    });
    expect(serverError(draft, "weight", "Bad.")).toEqual({
      key: "weight",
      error: { message: "Bad." },
    });
    // Alias indexes count the aliases sent: blank rows are skipped.
    const aliases = [row(" ", ""), ...draft.model_aliases];

    expect(serverError({ ...draft, model_aliases: aliases }, "model_aliases.1", "Bad.")).toEqual({
      key: "model_aliases",
      error: { message: "Bad.", row: draft.model_aliases[1]!.id },
    });
    // An entry the form no longer shows stays on the field; an unknown field is not a form error.
    expect(serverError(draft, "headers.X-Gone", "Bad.")).toEqual({
      key: "headers",
      error: { message: "Bad." },
    });
    expect(serverError(draft, "base_url", "Bad.")).toBeUndefined();
    expect(serverError(draft, undefined, "Bad.")).toBeUndefined();
  });
});

describe("headers", () => {
  it("renames a header's case without removing it and drops outer prefix slashes", () => {
    const [secret, team] = draftOf(configured).headers;

    expect(patchOf(configured, { headers: [secret!, { ...team!, name: "x-team" }] })).toEqual({
      headers: { "x-team": "blue" },
    });
    expect(patchOf(configured, { prefix: "/squad/" })).toEqual({ prefix: "squad" });
    expect(changedFields(configured, { prefix: "/team/" })).toEqual([]);
  });

  it("types replaced values and new secret headers into a password field", () => {
    const base: HeaderRow = { id: "h", name: "X-Team", value: "", hidden: undefined };

    expect(isSecretRow(base)).toBe(false);
    expect(isSecretRow({ ...base, replaced: true })).toBe(true);
    expect(isSecretRow({ ...base, added: true })).toBe(true);
    expect(isSecretRow({ ...base, added: true, name: " user-agent " })).toBe(false);
    expect(isSecretRow({ ...base, added: true, name: "" })).toBe(false);
  });
});
