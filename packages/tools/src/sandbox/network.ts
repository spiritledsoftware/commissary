/**
 * A sandbox's network (ADR 0041, ADR 0044, #222): which hosts a sandbox session's commands may reach. None by default;
 * a list of allowed hosts, with the `package_registries` preset; or the open internet. The sandbox toolkit carries the
 * org's ceiling, the widest network an org admin allows, and a session asks for one within it when it opens.
 *
 * Every request a sandbox makes goes through one filtering entrypoint (the Cloudflare provider's `SandboxEgress`),
 * which asks {@link egressRefusal}: the session's network first, then the outbound guard (`checkOutboundUrl`), so an
 * address the guard refuses stays refused even on the open internet.
 */
import { checkOutboundUrl, type OutboundPolicy } from "@commissary/core";
import type { SandboxNetwork } from "@commissary/contract/tools";
import { Result } from "effect";

export type { SandboxNetwork };

/** The network a sandbox has unless an org admin and its session ask for more. */
export const NO_NETWORK: SandboxNetwork = { kind: "none" };

/**
 * What a sandbox session may have (#222, #223): its network and whether it may use the computer. The sandbox toolkit's
 * is the org's ceiling, set by its admins; a session asks for one within it when it opens, and keeps it.
 */
export interface SandboxAllowance {
  readonly network: SandboxNetwork;
  /**
   * Whether it may use the computer (ADR 0041): a provider with one runs there a command its own shell cannot run at
   * all. Never on a deployment without the computer.
   */
  readonly computer: boolean;
}

/** What a sandbox has unless an org admin and its session ask for more: no network and no computer. */
export const NO_ALLOWANCE: SandboxAllowance = { network: NO_NETWORK, computer: false };

/**
 * The hosts of each preset. `package_registries`: npm, PyPI, GitHub (its API, its downloads and release assets), and
 * mise's download hosts (its versions index and the runtimes it installs most: Node.js, Python's builds, Go), for the
 * computer's mise (#223).
 */
export const PRESET_HOSTS: Readonly<Record<"package_registries", ReadonlyArray<string>>> = {
  package_registries: [
    "registry.npmjs.org",
    "registry.yarnpkg.com",
    "pypi.org",
    "files.pythonhosted.org",
    "github.com",
    "api.github.com",
    "codeload.github.com",
    "objects.githubusercontent.com",
    "raw.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "mise.jdx.dev",
    "mise-versions.jdx.dev",
    "nodejs.org",
    "go.dev",
    "dl.google.com",
  ],
};

/** A host as matched: lowercase, without a trailing dot. */
const bare = (host: string): string => host.trim().toLowerCase().replace(/\.+$/, "");

/** The hosts a `hosts` network allows: its own and its presets', normalized. */
export const allowedHosts = (
  network: Extract<SandboxNetwork, { kind: "hosts" }>,
): ReadonlyArray<string> => [
  ...new Set(
    [
      ...network.hosts,
      ...(network.presets ?? []).flatMap((preset) => PRESET_HOSTS[preset]),
    ].flatMap((host) => {
      const name = bare(host);

      return name === "" ? [] : [name];
    }),
  ),
];

/** Whether `pattern` (a name, or `*.` and a name) covers the host `host`. */
const coversHost = (pattern: string, host: string): boolean =>
  pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) : host === pattern;

/** Whether `pattern` covers every host `other` (a name or a wildcard) covers. */
const coversPattern = (pattern: string, other: string): boolean =>
  other.startsWith("*.")
    ? pattern.startsWith("*.") && other.endsWith(pattern.slice(1))
    : coversHost(pattern, other);

/** A host entry an org admin or a session may list: a DNS name, or `*.` and one; no scheme, port or path. */
const HOST_ENTRY =
  /^(\*\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Why `network` is not one to store or ask for (a malformed host), or undefined when it is. */
export const networkProblem = (network: SandboxNetwork): string | undefined => {
  if (network.kind !== "hosts") return undefined;
  const malformed = network.hosts.find((host) => !HOST_ENTRY.test(bare(host)));

  return malformed === undefined
    ? undefined
    : `${JSON.stringify(malformed)} is not a host name (a name such as example.com, or *.example.com)`;
};

/** `network` as stored: its hosts normalized, without duplicates. */
export const normalizedNetwork = (network: SandboxNetwork): SandboxNetwork =>
  network.kind === "hosts"
    ? {
        kind: "hosts",
        hosts: [...new Set(network.hosts.map(bare))],
        ...(network.presets === undefined || network.presets.length === 0
          ? {}
          : { presets: [...new Set(network.presets)] }),
      }
    : network;

/**
 * Whether a session may ask for `requested` under the org's `ceiling`: no network always; a list of hosts when the
 * ceiling is the open internet, or when each host it allows is one the ceiling allows; the open internet only under an
 * open ceiling.
 */
export const withinCeiling = (requested: SandboxNetwork, ceiling: SandboxNetwork): boolean => {
  if (requested.kind === "none" || ceiling.kind === "open") return true;

  if (requested.kind === "open" || ceiling.kind === "none") return false;
  const allowed = allowedHosts(ceiling);

  return allowedHosts(requested).every((host) =>
    allowed.some((pattern) => coversPattern(pattern, host)),
  );
};

/** A network as a model reads it, in a tool result. */
export const describeNetwork = (network: SandboxNetwork): string => {
  switch (network.kind) {
    case "none":
      return "no network";
    case "open":
      return "the internet";
    case "hosts":
      return `only ${allowedHosts(network).join(", ")}`;
  }
};

/**
 * Why a sandbox with `network` may not fetch `url` (what its command is told), or undefined when it may: the network
 * first, then the outbound guard under `policy`.
 */
export const egressRefusal = (
  url: string,
  network: SandboxNetwork,
  policy: OutboundPolicy,
): string | undefined => {
  const checked = checkOutboundUrl(url, policy);
  const host = Result.isSuccess(checked) ? bare(checked.success.hostname) : checked.failure.host;

  if (network.kind === "none") return "the sandbox has no network";

  if (
    network.kind === "hosts" &&
    !allowedHosts(network).some((pattern) => coversHost(pattern, host))
  )
    return `the sandbox's network does not allow ${host === "" ? "that address" : host}`;

  return Result.isFailure(checked) ? checked.failure.message : undefined;
};
