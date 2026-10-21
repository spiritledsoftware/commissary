// The endpoint URL builder's model (src/lib/mcp-endpoint.ts, #208, ADR 0037, ADR 0045): the MCP endpoint's URLs on each
// kind of deployment, `?toolkits=`, how many tools a URL gives the member, the narrowing suggestion and the setup
// snippets of docs/CLIENTS.md.
import { describe, expect, it } from "vitest";
import type { UsableTools } from "@commissary/contract/tools";
import {
  accessTokenSnippets,
  endpointsOf,
  narrowingNote,
  oneHostNote,
  snippetsOf,
  toolCount,
} from "../src/lib/mcp-endpoint.ts";

const SELF_HOSTED = {
  origin: "https://commissary.example.com",
  slug: "acme",
  hosted: false,
  apiUrl: "https://api.example.com",
};

const CLOUD = { ...SELF_HOSTED, hosted: true };

describe("the endpoint URLs", () => {
  it("are two on a self-hosted Commissary: the app host's for Access sign-ins, the API host's for keys", () => {
    expect(endpointsOf(SELF_HOSTED, "all").map((endpoint) => [endpoint.via, endpoint.url])).toEqual(
      [
        ["access", "https://commissary.example.com/o/acme/mcp"],
        ["key", "https://api.example.com/mcp"],
      ],
    );
  });

  it("is one on Commissary Cloud, the API host's, which signs clients in itself or takes a key", () => {
    expect(endpointsOf(CLOUD, "all").map((endpoint) => [endpoint.via, endpoint.url])).toEqual([
      ["cloud", "https://api.example.com/mcp"],
    ]);
    // A Cloud stage with one host serves it on the app host.
    expect(endpointsOf({ ...CLOUD, apiUrl: undefined }, "all").map((e) => e.url)).toEqual([
      "https://commissary.example.com/mcp",
    ]);
  });

  it("is the Access one alone on a self-hosted Commissary with one host, which has no API-key endpoint", () => {
    const oneHost = { ...SELF_HOSTED, apiUrl: undefined };

    expect(endpointsOf(oneHost, "all").map((e) => [e.via, e.url])).toEqual([
      ["access", "https://commissary.example.com/o/acme/mcp"],
    ]);
    expect(oneHostNote(oneHost)).toBe(
      "This deployment has one host, so API keys reach no MCP endpoint: clients sign in through Access.",
    );
    expect(oneHostNote(SELF_HOSTED)).toBeUndefined();
    expect(oneHostNote({ ...CLOUD, apiUrl: undefined })).toBeUndefined();
  });

  it("name the picked toolkits in ?toolkits=, by the names the member sees", () => {
    expect(endpointsOf(SELF_HOSTED, ["github", "linear"]).map((e) => e.url)).toEqual([
      "https://commissary.example.com/o/acme/mcp?toolkits=github,linear",
      "https://api.example.com/mcp?toolkits=github,linear",
    ]);
  });
});

const USABLE: UsableTools = {
  toolkits: [
    {
      id: "tk_gh",
      name: "github",
      tools: [
        { id: "tk_gh:create_issue", name: "github_create_issue", tool_class: "write" },
        { id: "tk_gh:search", name: "github_search", tool_class: "read" },
      ],
    },
    {
      id: "tk_lin",
      name: "linear",
      tools: [{ id: "tk_lin:list", name: "linear_list", tool_class: "read" }],
    },
  ],
};

describe("how many tools a URL gives", () => {
  it("counts every tool the member may use, or those of the picked toolkits", () => {
    expect(toolCount(USABLE, "all", undefined)).toBe(3);
    expect(toolCount(USABLE, ["linear"], undefined)).toBe(1);
    // Names match as the endpoint matches them: case-insensitively; an unknown one narrows to nothing.
    expect(toolCount(USABLE, ["GitHub"], undefined)).toBe(2);
    expect(toolCount(USABLE, ["jira"], undefined)).toBe(0);
  });

  it("narrows by the picked API key's tool scope as well", () => {
    const scope = [{ toolkit: "tk_gh", tools: { kind: "read" as const } }];

    expect(toolCount(USABLE, "all", scope)).toBe(1);
    expect(toolCount(USABLE, ["linear"], scope)).toBe(0);
    // A key without a scope may use every tool its member may use.
    expect(toolCount(USABLE, "all", null)).toBe(3);
  });

  it("suggests narrowing above about 100 tools (ADR 0037), with no hard cap", () => {
    expect(narrowingNote(0)).toBeUndefined();
    expect(narrowingNote(100)).toBeUndefined();
    expect(narrowingNote(101)).toBe(
      "That is a lot for a model to choose from: pick fewer toolkits, or an API key with a tool scope.",
    );
  });
});

const clients = (via: Parameters<typeof snippetsOf>[0]) =>
  snippetsOf(via, "https://x.example/mcp?toolkits=github").map((snippet) => snippet.client);

describe("the setup snippets (docs/CLIENTS.md)", () => {
  it("set up the clients of each way in, with the URL as built", () => {
    expect(clients("access")).toEqual(["Claude", "Claude Code", "Cursor", "Codex"]);
    expect(clients("key")).toEqual(["Claude Code", "Cursor", "Codex", "pi"]);
    expect(clients("cloud")).toEqual(["Claude", "Claude Code", "Cursor", "Codex"]);

    for (const via of ["access", "key", "cloud"] as const)
      for (const snippet of snippetsOf(via, "https://x.example/mcp?toolkits=github"))
        expect(`${snippet.how} ${snippet.code ?? ""}`).toContain(
          "https://x.example/mcp?toolkits=github",
        );
  });

  it("send the API key from an environment variable on the API host only, never the key itself", () => {
    const [claudeCode] = snippetsOf("key", "https://api.example.com/mcp");

    expect(claudeCode?.code).toBe(
      'claude mcp add --transport http commissary https://api.example.com/mcp \\\n  --header "Authorization: Bearer $COMMISSARY_API_KEY"',
    );

    for (const via of ["access", "cloud"] as const)
      for (const snippet of snippetsOf(via, "https://x.example/mcp"))
        expect(snippet.code ?? "").not.toContain("COMMISSARY_API_KEY");
  });

  it("show how to send an Access token without Managed OAuth, which the panel cannot tell is on", () => {
    expect(accessTokenSnippets("https://commissary.example.com/o/acme/mcp")).toEqual([
      {
        client: "Claude Code",
        how: "Sign in once with cloudflared, then pass its token; run cloudflared access token again when the session ends.",
        code:
          "cloudflared access login https://commissary.example.com\n" +
          "claude mcp add --transport http commissary https://commissary.example.com/o/acme/mcp \\\n" +
          '  --header "cf-access-token: $(cloudflared access token -app=https://commissary.example.com)"',
        language: "bash",
      },
    ]);
  });
});
