// The endpoint URL builder's model (#208, ADR 0037, ADR 0045, docs/CLIENTS.md "MCP clients"): where Commissary's MCP
// endpoint is on this deployment, the URL with `?toolkits=`, how many tools a URL gives the member, the suggestion to
// narrow it, and the setup snippets of the clients. Pure: no DOM, tested in test/mcp-endpoint.test.ts.
import type { ToolScope } from "@commissary/contract/api-keys";
import type { UsableTools } from "@commissary/contract/tools";
import { draftOfScope, toolsGiven } from "./tool-scope.ts";

/** Where the panel runs: its origin, the org it shows, the kind of deployment and its API host. */
export interface EndpointPlace {
  /** The panel's origin, the app host (`https://commissary.example.com`). */
  readonly origin: string;
  /** The org the panel shows. */
  readonly slug: string;
  /** Commissary Cloud. */
  readonly hosted: boolean;
  /** `GET /me`'s `api_url`: the API host, when the client API has a host of its own. */
  readonly apiUrl: string | undefined;
}

/**
 * How a client reaches an endpoint: `access`, a self-hosted Commissary's app host, where Access signs the client in as
 * its member (ADR 0045); `key`, the API host with an API key; `cloud`, Commissary Cloud's one endpoint, where a client
 * signs in through Commissary's own OAuth or sends an API key.
 */
export type EndpointVia = "access" | "key" | "cloud";

export interface Endpoint {
  readonly via: EndpointVia;
  readonly url: string;
}

/** Which toolkits a URL narrows to (`?toolkits=`), by the names the member sees, or every one. */
export type ToolkitSelection = "all" | ReadonlyArray<string>;

const MCP_PATH = "/mcp";

const withToolkits = (base: string, selection: ToolkitSelection): string =>
  selection === "all" ? base : `${base}?toolkits=${selection.map(encodeURIComponent).join(",")}`;

/** The MCP endpoint's URLs on this deployment, narrowed to `selection`. */
export const endpointsOf = (
  place: EndpointPlace,
  selection: ToolkitSelection,
): ReadonlyArray<Endpoint> => {
  const apiHost = place.apiUrl ?? place.origin;

  if (place.hosted)
    return [{ via: "cloud", url: withToolkits(`${apiHost}${MCP_PATH}`, selection) }];

  const access: Endpoint = {
    via: "access",
    url: withToolkits(`${place.origin}/o/${encodeURIComponent(place.slug)}${MCP_PATH}`, selection),
  };

  return place.apiUrl === undefined
    ? [access]
    : [access, { via: "key", url: withToolkits(`${place.apiUrl}${MCP_PATH}`, selection) }];
};

/**
 * Why a self-hosted Commissary with one host shows one URL: the API Worker gets no `/mcp` there, so the app host's is
 * the one behind Access (docs/CLIENTS.md). `undefined` elsewhere.
 */
export const oneHostNote = (place: EndpointPlace): string | undefined =>
  !place.hosted && place.apiUrl === undefined
    ? "This deployment has one host, so API keys reach no MCP endpoint: clients sign in through Access."
    : undefined;

/**
 * How many tools a URL gives the member: what they may use (`GET /tools`), narrowed to the picked toolkits by name
 * (case-insensitively, as the endpoint matches `?toolkits=`) and, when an API key is picked, by its tool scope (`null`:
 * a key without one; `undefined`: no key).
 */
export const toolCount = (
  usable: UsableTools,
  selection: ToolkitSelection,
  scope: ToolScope | null | undefined,
): number => {
  const picked =
    selection === "all" ? undefined : new Set(selection.map((name) => name.toLowerCase()));

  const narrowed: UsableTools = {
    toolkits: usable.toolkits.filter(
      (toolkit) => picked === undefined || picked.has(toolkit.name.toLowerCase()),
    ),
  };

  return toolsGiven(draftOfScope(scope), narrowed).length;
};

/** Above this many tools the builder suggests narrowing the URL (ADR 0037); there is no hard cap. */
export const NARROW_ABOVE = 100;

/**
 * The suggestion to narrow a URL that gives more than {@link NARROW_ABOVE} tools, shown under its count; `undefined`
 * below it.
 */
export const narrowingNote = (count: number): string | undefined =>
  count > NARROW_ABOVE
    ? "That is a lot for a model to choose from: pick fewer toolkits, or an API key with a tool scope."
    : undefined;

/** How to set one client up with a URL: what to do, and what to paste or run, in its language. */
export interface Snippet {
  readonly client: string;
  readonly how: string;
  readonly code?: string;
  readonly language?: "bash" | "json" | "toml";
}

/** The environment variable the API-key snippets read the key from: the key itself never appears in the panel. */
export const API_KEY_VARIABLE = "COMMISSARY_API_KEY";

/** Clients that sign in by themselves, through Access (`access`) or Commissary's own OAuth (`cloud`). */
const signInSnippets = (url: string, where: string): ReadonlyArray<Snippet> => [
  {
    client: "Claude",
    how: `Settings > Connectors > Add custom connector, with the URL ${url}, then Connect and sign in ${where}.`,
  },
  {
    client: "Claude Code",
    how: "Then /mcp in Claude Code, and Authenticate: it opens the sign-in in your browser.",
    code: `claude mcp add --transport http commissary ${url}`,
    language: "bash",
  },
  {
    client: "Cursor",
    how: "In ~/.cursor/mcp.json, then Connect in Cursor's MCP settings.",
    code: JSON.stringify({ mcpServers: { commissary: { url } } }, null, 2),
    language: "json",
  },
  {
    client: "Codex",
    how: "In ~/.codex/config.toml, then codex mcp login commissary.",
    code: `[mcp_servers.commissary]\nurl = "${url}"`,
    language: "toml",
  },
];

/**
 * Whether the deployment's Access application signs clients in by itself (Managed OAuth, `ACCESS_MANAGED_OAUTH`) is not
 * something the panel can read, so the Access URL's snippets come with the way in without it.
 */
export const WITHOUT_MANAGED_OAUTH =
  "Those sign-ins need Managed OAuth on the deployment's Access application (ACCESS_MANAGED_OAUTH, off by default). Without it, a client sends an Access token itself, from cloudflared:";

/** How a client sends a person's Access token from `cloudflared` (docs/CLIENTS.md, "Without Managed OAuth"). */
export const accessTokenSnippets = (url: string): ReadonlyArray<Snippet> => {
  const app = new URL(url).origin;

  return [
    {
      client: "Claude Code",
      how: "Sign in once with cloudflared, then pass its token; run cloudflared access token again when the session ends.",
      code: `cloudflared access login ${app}\nclaude mcp add --transport http commissary ${url} \\\n  --header "cf-access-token: $(cloudflared access token -app=${app})"`,
      language: "bash",
    },
  ];
};

/** Clients that send an API key from {@link API_KEY_VARIABLE}. */
const keySnippets = (url: string): ReadonlyArray<Snippet> => [
  {
    client: "Claude Code",
    how: `With the key in ${API_KEY_VARIABLE}:`,
    code: `claude mcp add --transport http commissary ${url} \\\n  --header "Authorization: Bearer $${API_KEY_VARIABLE}"`,
    language: "bash",
  },
  {
    client: "Cursor",
    how: "In ~/.cursor/mcp.json:",
    code: JSON.stringify(
      {
        mcpServers: {
          commissary: { url, headers: { Authorization: `Bearer \${env:${API_KEY_VARIABLE}}` } },
        },
      },
      null,
      2,
    ),
    language: "json",
  },
  {
    client: "Codex",
    how: "In ~/.codex/config.toml; Codex sends the variable's value as the bearer token.",
    code: `[mcp_servers.commissary]\nurl = "${url}"\nbearer_token_env_var = "${API_KEY_VARIABLE}"`,
    language: "toml",
  },
  {
    client: "pi",
    how: "In ~/.pi/agent/mcp.json:",
    code: JSON.stringify(
      {
        mcpServers: {
          commissary: { url, headers: { Authorization: `Bearer \${${API_KEY_VARIABLE}}` } },
        },
      },
      null,
      2,
    ),
    language: "json",
  },
];

/**
 * The setup snippets of the clients docs/CLIENTS.md covers, for a URL reached `via` a way in (`key` also sets clients
 * up with an API key on Commissary Cloud's endpoint).
 */
export const snippetsOf = (via: EndpointVia, url: string): ReadonlyArray<Snippet> => {
  switch (via) {
    case "access":
      return signInSnippets(url, "through Access");
    case "cloud":
      return signInSnippets(url, "to Commissary");
    case "key":
      return keySnippets(url);
  }
};
