// A sandbox's network as a form edits it (ADR 0041, #233, #225): none, a list of hosts (with the package registries
// preset), or the internet. Shared by the agent editor's sandbox, which asks for a network within the sandbox
// toolkit's ceiling, and the sandbox toolkit's settings, which set that ceiling. Pure: no DOM, tested through
// test/agent-form.test.ts and test/sandbox-settings.test.ts.
import type { SandboxNetwork } from "@commissary/contract/tools";

/** What the network picker offers: none, a list of hosts (with the package registries preset), or the internet. */
export type NetworkKind = SandboxNetwork["kind"];

export const NETWORK_KINDS: ReadonlyArray<{
  readonly id: NetworkKind;
  readonly label: string;
  readonly hint: string;
}> = [
  { id: "none", label: "No network", hint: "Commands cannot reach anything outside the sandbox." },
  {
    id: "hosts",
    label: "Only these hosts",
    hint: "One host name a line: example.com, or *.example.com for every name under it.",
  },
  {
    id: "open",
    label: "The internet",
    hint: "Every public address, as the outbound guard allows.",
  },
];

/** The fields of a network in a form. */
export interface NetworkFields {
  readonly network: NetworkKind;
  /** Host names a line, for `hosts`. */
  readonly hosts: string;
  /** For `hosts`: also the package registries (npm, PyPI, GitHub and mise's download hosts). */
  readonly registries: boolean;
}

const hostLines = (text: string): ReadonlyArray<string> =>
  text
    .split(/[\s,]+/)
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host !== "");

/** A host entry the sandbox takes: a DNS name, or `*.` and one; no scheme, port or path. */
const HOST_ENTRY =
  /^(\*\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** The network the fields ask for. */
export const networkOfFields = (fields: NetworkFields): SandboxNetwork => {
  switch (fields.network) {
    case "none":
      return { kind: "none" };
    case "open":
      return { kind: "open" };
    case "hosts":
      return {
        kind: "hosts",
        hosts: [...new Set(hostLines(fields.hosts))],
        ...(fields.registries ? { presets: ["package_registries" as const] } : {}),
      };
  }
};

/** The fields of a stored network; none for a toolkit that states none. */
export const fieldsOfNetwork = (network: SandboxNetwork | undefined): NetworkFields => {
  const stored = network ?? { kind: "none" as const };

  return {
    network: stored.kind,
    hosts: stored.kind === "hosts" ? stored.hosts.join("\n") : "",
    registries: stored.kind === "hosts" && stored.presets?.includes("package_registries") === true,
  };
};

/** What is wrong with a list of hosts the fields ask for (a malformed name, or none), or `undefined`. */
export const hostsProblem = (fields: NetworkFields): string | undefined => {
  if (fields.network !== "hosts") return undefined;

  const hosts = hostLines(fields.hosts);
  const malformed = hosts.find((host) => !HOST_ENTRY.test(host));

  if (malformed !== undefined)
    return `“${malformed}” is not a host name: use a name such as example.com, or *.example.com.`;

  if (hosts.length === 0 && !fields.registries)
    return "Name a host, or allow the package registries, or choose no network.";

  return undefined;
};

/** The package registries preset's checkbox. */
export const PACKAGE_REGISTRIES_LABEL = "Also the package registries (npm, PyPI, GitHub, mise)";
