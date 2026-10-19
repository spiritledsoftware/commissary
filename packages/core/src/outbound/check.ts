/**
 * The outbound guard's check of one URL (ADR 0044, docs/THREAT-MODEL.md "Outbound requests to places they shouldn't
 * reach"): Commissary fetches a URL an org or member supplied only when it is `https:`, names no IP literal outside
 * the public internet, and is none of the deployment's own hosts. Local development (`alchemy dev`) may also reach
 * loopback, over `http:` or `https:`. Names are not resolved: Cloudflare's network does not route a Worker's fetch to
 * a private address, and every Worker sets `global_fetch_strictly_public` (docs/ARCHITECTURE.md "Outbound guard").
 *
 * The WHATWG URL parser already turns IPv4's odd notations (decimal `2130706433`, octal `0177.0.0.1`, hex `0x7f.1`,
 * short `127.1`) into a dotted quad, and an IPv6 literal into its compressed hex form, so the check sees one spelling
 * of each address.
 */
import { Result, Schema } from "effect";

/** What a caller shows when the guard refuses a URL. */
export const OUTBOUND_REFUSED_MESSAGE = "Commissary only reaches public HTTPS addresses";

/** Why the guard refused a URL. */
export const OutboundRefusalReason = Schema.Literals([
  /** Not a URL at all. */
  "invalid_url",
  /** Not `https:` (nor `http:` to loopback in local development). */
  "scheme",
  /** An IP literal or a name outside the public internet (private, loopback, link-local, reserved, ...). */
  "address",
  /** One of the deployment's own hosts. */
  "own_host",
  /** More redirects than the guard follows. */
  "too_many_redirects",
]);

export type OutboundRefusalReason = typeof OutboundRefusalReason.Type;

/**
 * The guard refused a URL. `message` is always {@link OUTBOUND_REFUSED_MESSAGE}; `host` names the refused host (empty
 * when the URL did not parse) for logs, never its path or query, which may carry secrets.
 */
export class OutboundRefused extends Schema.TaggedError<OutboundRefused>()("OutboundRefused", {
  reason: OutboundRefusalReason,
  host: Schema.String,
  message: Schema.String,
}) {}

export const outboundRefused = (reason: OutboundRefusalReason, host = ""): OutboundRefused =>
  new OutboundRefused({ reason, host, message: OUTBOUND_REFUSED_MESSAGE });

/** Where the guard runs: the deployment's own hosts, and whether this is local development. */
export interface OutboundPolicy {
  /**
   * Hosts of this deployment the guard refuses: exact names (`app.example.com`) or `*.` wildcards
   * (`*.account.workers.dev`, any name under it).
   */
  readonly ownHosts: ReadonlyArray<string>;
  /**
   * Local development (`alchemy dev`): loopback is reachable over `http:` and `https:`. Decided like the Access dev
   * bypass: the request being served came to a loopback host ({@link isLoopbackHost}).
   */
  readonly localDevelopment: boolean;
}

/**
 * The loopback hosts a request reaches only under `alchemy dev`, as `URL.hostname` spells them: production traffic
 * always arrives on a custom domain or a workers.dev URL. Shared with the Access dev bypass
 * (`@commissary/auth`'s `devBypass`).
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Whether `hostname` (`URL.hostname`) is one of {@link LOOPBACK_HOSTS}. */
export const isLoopbackHost = (hostname: string): boolean => LOOPBACK_HOSTS.has(hostname);

// --- IPv4 ------------------------------------------------------------------------------------------------------------

const DOTTED_QUAD = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

const ipv4 = (hostname: string): number | undefined => {
  const match = DOTTED_QUAD.exec(hostname);

  if (match === null) return undefined;

  const octets = match.slice(1).map(Number);

  if (octets.some((octet) => octet > 255)) return undefined;

  return octets.reduce((value, octet) => value * 256 + octet, 0);
};

const v4 = (a: number, b: number, c: number, d: number) => ((a * 256 + b) * 256 + c) * 256 + d;

/** IANA's IPv4 special-purpose ranges that are not the public internet, as [first address, prefix length]. */
const NON_PUBLIC_V4: ReadonlyArray<readonly [number, number]> = [
  [v4(0, 0, 0, 0), 8], // "this network"
  [v4(10, 0, 0, 0), 8], // private
  [v4(100, 64, 0, 0), 10], // shared address space (CGNAT); Alibaba Cloud's metadata 100.100.100.200
  [v4(127, 0, 0, 0), 8], // loopback
  [v4(169, 254, 0, 0), 16], // link-local; cloud metadata 169.254.169.254
  [v4(172, 16, 0, 0), 12], // private
  [v4(192, 0, 0, 0), 24], // IETF protocol assignments
  [v4(192, 0, 2, 0), 24], // documentation (TEST-NET-1)
  [v4(192, 88, 99, 0), 24], // 6to4 relay anycast
  [v4(192, 168, 0, 0), 16], // private
  [v4(198, 18, 0, 0), 15], // benchmarking
  [v4(198, 51, 100, 0), 24], // documentation (TEST-NET-2)
  [v4(203, 0, 113, 0), 24], // documentation (TEST-NET-3)
  [v4(224, 0, 0, 0), 4], // multicast
  [v4(240, 0, 0, 0), 4], // reserved, and the limited broadcast 255.255.255.255
];

const inV4Range = (address: number, [first, bits]: readonly [number, number]) =>
  Math.floor(address / 2 ** (32 - bits)) === Math.floor(first / 2 ** (32 - bits));

const isPublicV4 = (address: number): boolean =>
  !NON_PUBLIC_V4.some((range) => inV4Range(address, range));

const isLoopbackV4 = (address: number): boolean => inV4Range(address, [v4(127, 0, 0, 0), 8]);

// --- IPv6 ------------------------------------------------------------------------------------------------------------

const HEX_GROUP = /^[0-9a-f]{1,4}$/;

/** The eight 16-bit groups of an IPv6 literal (without brackets), or undefined when it is none. */
const ipv6 = (literal: string): ReadonlyArray<number> | undefined => {
  let text = literal.toLowerCase();
  let tail: Array<number> = [];
  // WHATWG serialises hex groups only; an embedded dotted quad is accepted anyway.
  const lastColon = text.lastIndexOf(":");
  const quad = ipv4(text.slice(lastColon + 1));

  if (quad !== undefined) {
    tail = [Math.floor(quad / 65536), quad % 65536];
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }

  const halves = text.split("::");

  if (halves.length > 2) return undefined;

  const parse = (half: string | undefined) =>
    half === undefined || half === "" ? [] : half.split(":");

  const head = parse(halves[0]);
  const rest = parse(halves[1]);

  if (![...head, ...rest].every((group) => HEX_GROUP.test(group))) return undefined;

  const explicit = [...head, ...rest].map((group) => Number.parseInt(group, 16));
  const missing = 8 - explicit.length;

  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;

  const groups = [
    ...head.map((group) => Number.parseInt(group, 16)),
    ...Array.from({ length: halves.length === 1 ? 0 : missing }, () => 0),
    ...rest.map((group) => Number.parseInt(group, 16)),
  ];

  if (tail.length > 0) groups.splice(6, 2, ...tail);

  return groups;
};

/** Whether the first `bits` bits of `groups` equal those of `prefix`. */
const inV6Range = (groups: ReadonlyArray<number>, prefix: ReadonlyArray<number>, bits: number) => {
  for (let index = 0; index * 16 < bits; index += 1) {
    const width = Math.min(16, bits - index * 16);
    const shift = 16 - width;

    if ((groups[index] ?? 0) >> shift !== (prefix[index] ?? 0) >> shift) return false;
  }

  return true;
};

const embeddedV4 = (high: number | undefined, low: number | undefined) =>
  (high ?? 0) * 65536 + (low ?? 0);

/** IANA's IPv6 special-purpose ranges inside global unicast (2000::/3) that are not the public internet. */
const NON_PUBLIC_V6: ReadonlyArray<readonly [ReadonlyArray<number>, number]> = [
  [[0x2001, 0x0000], 23], // IETF protocol assignments (Teredo 2001::/32, ORCHID, ...)
  [[0x2001, 0x0db8], 32], // documentation
  [[0x3fff, 0x0000], 20], // documentation
];

const isPublicV6 = (groups: ReadonlyArray<number>): boolean => {
  // IPv4-mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96) carry an IPv4 address: it decides.
  if (inV6Range(groups, [0, 0, 0, 0, 0, 0xffff], 96) || inV6Range(groups, [0x64, 0xff9b], 96))
    return isPublicV4(embeddedV4(groups[6], groups[7]));

  // 6to4 (2002::/16) carries one in its second and third groups.
  if (inV6Range(groups, [0x2002], 16)) return isPublicV4(embeddedV4(groups[1], groups[2]));

  // Everything outside global unicast (2000::/3) is not public: unspecified, loopback, IPv4-compatible, discard-only,
  // unique local (fc00::/7), link-local (fe80::/10), site-local, multicast (ff00::/8), reserved.
  if (!inV6Range(groups, [0x2000], 3)) return false;

  return !NON_PUBLIC_V6.some(([prefix, bits]) => inV6Range(groups, prefix, bits));
};

const isLoopbackV6 = (groups: ReadonlyArray<number>): boolean =>
  groups.every((group, index) => group === (index === 7 ? 1 : 0)) ||
  (inV6Range(groups, [0, 0, 0, 0, 0, 0xffff], 96) &&
    isLoopbackV4(embeddedV4(groups[6], groups[7])));

// --- hosts -----------------------------------------------------------------------------------------------------------

/** `URL.hostname` without a trailing dot, so `example.com.` is `example.com`. */
const bareHost = (hostname: string): string => hostname.toLowerCase().replace(/\.+$/, "");

const isLocalhostName = (host: string): boolean =>
  host === "localhost" || host.endsWith(".localhost");

type HostKind = "public" | "loopback" | "non-public";

const hostKind = (host: string): HostKind => {
  if (host.startsWith("[") && host.endsWith("]")) {
    const groups = ipv6(host.slice(1, -1));

    if (groups === undefined) return "non-public";

    if (isLoopbackV6(groups)) return "loopback";

    return isPublicV6(groups) ? "public" : "non-public";
  }

  const address = ipv4(host);

  if (address !== undefined) {
    if (isLoopbackV4(address)) return "loopback";

    return isPublicV4(address) ? "public" : "non-public";
  }

  // `localhost` and its subdomains are loopback by definition (RFC 6761), wherever they would resolve.
  return isLocalhostName(host) ? "loopback" : "public";
};

const isOwnHost = (host: string, ownHosts: ReadonlyArray<string>): boolean =>
  ownHosts.some((entry) => {
    const own = bareHost(entry.trim());

    if (own === "") return false;

    return own.startsWith("*.") ? host.endsWith(own.slice(1)) : host === own;
  });

/**
 * Checks one URL against the outbound guard: the parsed URL when Commissary may fetch it, else why not. Every hop of
 * a redirect is checked the same way (`guardHttpClient`).
 */
export const checkOutboundUrl = (
  url: string | URL,
  policy: OutboundPolicy,
): Result.Result<URL, OutboundRefused> => {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return Result.fail(outboundRefused("invalid_url"));
  }

  const host = bareHost(parsed.hostname);
  const kind = hostKind(host);
  const loopbackAllowed = policy.localDevelopment && kind === "loopback";

  if (parsed.protocol !== "https:" && !(loopbackAllowed && parsed.protocol === "http:"))
    return Result.fail(outboundRefused("scheme", host));

  if (kind !== "public" && !loopbackAllowed) return Result.fail(outboundRefused("address", host));

  if (isOwnHost(host, policy.ownHosts)) return Result.fail(outboundRefused("own_host", host));

  return Result.succeed(parsed);
};
