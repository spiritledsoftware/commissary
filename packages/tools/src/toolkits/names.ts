/**
 * Tool and toolkit names (ADR 0037). A tool's full name is its toolkit's name and its own joined by one underscore,
 * `github_create_issue`, in `[a-z0-9_]` only: upstream names are lowercased and every other character becomes `_`. A
 * full name is at most {@link MAX_FULL_NAME} characters, so that it fits after a client's `mcp__<server>__` prefix; a
 * longer one is cut and ends in a four-character hash of the whole name, and is flagged so it can be renamed.
 */
import { sha256Hex } from "@commissary/core";

/** The longest full tool name (ADR 0037). */
export const MAX_FULL_NAME = 46;

/** Characters of the hash that ends a shortened name. */
const HASH_LENGTH = 4;

/** The longest toolkit name, so a full name keeps room for the tool's own. */
const MAX_TOOLKIT_NAME = 32;

/** A toolkit name: lowercase words of `[a-z0-9]` joined by single underscores. */
const TOOLKIT_NAME = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

/** A tool name an override gives: `[a-z0-9_]`, starting with a letter or digit. */
const TOOL_NAME = /^[a-z0-9][a-z0-9_]*$/;

/** `name` lowercased, with every character outside `[a-z0-9_]` replaced by `_`. */
export const sanitizeName = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9_]/g, "_");

export const isToolkitName = (name: string): boolean =>
  name.length <= MAX_TOOLKIT_NAME && TOOLKIT_NAME.test(name);

/** Whether an override's name is one a tool can take. */
export const isToolName = (name: string): boolean => TOOL_NAME.test(name);

/** A full name, and whether it had to be cut to {@link MAX_FULL_NAME}. */
export interface FullName {
  readonly name: string;
  readonly shortened: boolean;
}

/**
 * The full name of the tool `tool` (an upstream name, or the name an override gave it) of the toolkit `toolkit`: cut
 * to {@link MAX_FULL_NAME} characters when longer, ending in `_` and the first four hex characters of the SHA-256 of
 * the whole name.
 */
export const fullToolName = (toolkit: string, tool: string): FullName => {
  const whole = `${toolkit}_${sanitizeName(tool)}`;

  if (whole.length <= MAX_FULL_NAME) return { name: whole, shortened: false };
  const kept = whole.slice(0, MAX_FULL_NAME - HASH_LENGTH - 1).replace(/_+$/, "");

  return { name: `${kept}_${sha256Hex(whole).slice(0, HASH_LENGTH)}`, shortened: true };
};

/** Labels that name a service's MCP or API host rather than the service. */
const GENERIC_LABELS: ReadonlySet<string> = new Set([
  "www",
  "mcp",
  "api",
  "app",
  "tools",
  "server",
]);

/** Second-level labels of country domains (`co.uk`, `com.au`): the service's name is the label before. */
const SECOND_LEVEL: ReadonlySet<string> = new Set(["co", "com", "org", "net", "gov", "ac", "edu"]);

/**
 * The default name of a toolkit built from `source`: the service's label of its host, `mcp.linear.app` → `linear`,
 * `api.githubcopilot.com` → `githubcopilot`, sanitised to a toolkit name. The toolkit catalog's slug replaces it later
 * (#207).
 */
export const defaultToolkitName = (source: URL): string => {
  const labels = source.hostname.split(".").filter((label) => label !== "");

  if (labels.length > 1) labels.pop();

  if (labels.length > 1 && SECOND_LEVEL.has(labels.at(-1) ?? "")) labels.pop();

  const named = labels.filter((label) => !GENERIC_LABELS.has(label));
  const label = named.at(-1) ?? labels.at(-1) ?? "toolkit";

  const slug = sanitizeName(label)
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, MAX_TOOLKIT_NAME)
    .replace(/_$/, "");

  return slug === "" ? "toolkit" : slug;
};
