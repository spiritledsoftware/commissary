// The outbound guard (ADR 0044, docs/THREAT-MODEL.md): which user-supplied URLs Commissary fetches.
import { Result } from "effect";
import { describe, expect, it } from "vitest";
import { checkOutboundUrl, OUTBOUND_REFUSED_MESSAGE, type OutboundPolicy } from "../src/index.ts";

const DEPLOYED: OutboundPolicy = { ownHosts: [], localDevelopment: false };

const refusal = (url: string, policy: OutboundPolicy = DEPLOYED) => {
  const result = checkOutboundUrl(url, policy);

  return Result.isFailure(result) ? result.failure : undefined;
};

describe("checkOutboundUrl", () => {
  it("allows a public https: URL", () => {
    const result = checkOutboundUrl("https://api.example.com/v1", DEPLOYED);

    expect(Result.isSuccess(result) && result.success.href).toBe("https://api.example.com/v1");
  });

  it("refuses http: and every other scheme, with the message callers show", () => {
    for (const url of ["http://api.example.com/v1", "ftp://example.com/", "file:///etc/passwd"]) {
      const refused = refusal(url);

      expect(refused?.reason, url).toBe("scheme");
      expect(refused?.message).toBe(OUTBOUND_REFUSED_MESSAGE);
    }

    expect(OUTBOUND_REFUSED_MESSAGE).toBe("Commissary only reaches public HTTPS addresses");
  });

  it("refuses what is not a URL", () => {
    expect(refusal("not a url")?.reason).toBe("invalid_url");
    expect(refusal("")?.reason).toBe("invalid_url");
  });

  it.each([
    ["this network", "0.0.0.0"],
    ["this network", "0.1.2.3"],
    ["private 10/8", "10.0.0.1"],
    ["private 10/8", "10.255.255.255"],
    ["CGNAT", "100.64.0.1"],
    ["CGNAT", "100.127.255.254"],
    ["Alibaba Cloud metadata (CGNAT)", "100.100.100.200"],
    ["loopback", "127.0.0.1"],
    ["loopback", "127.255.0.9"],
    ["link-local", "169.254.0.1"],
    ["cloud metadata", "169.254.169.254"],
    ["private 172.16/12", "172.16.0.1"],
    ["private 172.16/12", "172.31.255.255"],
    ["IETF protocol assignments", "192.0.0.8"],
    ["documentation TEST-NET-1", "192.0.2.1"],
    ["6to4 relay anycast", "192.88.99.1"],
    ["private 192.168/16", "192.168.1.1"],
    ["benchmarking", "198.18.0.1"],
    ["benchmarking", "198.19.255.255"],
    ["documentation TEST-NET-2", "198.51.100.7"],
    ["documentation TEST-NET-3", "203.0.113.9"],
    ["multicast", "224.0.0.1"],
    ["multicast", "239.255.255.250"],
    ["reserved", "240.0.0.1"],
    ["broadcast", "255.255.255.255"],
  ])("refuses an IPv4 literal in %s (%s)", (_range, address) => {
    expect(refusal(`https://${address}/v1`)?.reason).toBe("address");
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "100.63.255.255",
    "100.128.0.0",
    "172.15.255.255",
    "172.32.0.0",
    "192.169.0.1",
    "198.17.255.255",
    "198.20.0.0",
    "223.255.255.255",
  ])("allows the public IPv4 literal %s", (address) => {
    expect(refusal(`https://${address}/v1`)).toBeUndefined();
  });

  it.each([
    ["decimal", "2130706433"],
    ["octal", "0177.0.0.1"],
    ["hex", "0x7f.0.0.1"],
    ["hex, whole", "0x7f000001"],
    ["short form", "127.1"],
    ["short form, metadata", "169.254.43518"],
    ["decimal, metadata", "2852039166"],
    ["octal, private", "012.0.0.1"],
    ["short form, private", "10.1"],
  ])("refuses an IPv4 literal in odd notation: %s (%s)", (_notation, address) => {
    expect(refusal(`https://${address}/`)?.reason).toBe("address");
  });

  it.each([
    ["unspecified", "::"],
    ["loopback", "::1"],
    ["loopback, long form", "0:0:0:0:0:0:0:1"],
    ["IPv4-compatible", "::7f00:1"],
    ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
    ["IPv4-mapped loopback, hex", "::ffff:7f00:1"],
    ["IPv4-mapped metadata", "::ffff:169.254.169.254"],
    ["IPv4-mapped private", "::ffff:10.0.0.1"],
    ["IPv4-mapped private, long form", "0:0:0:0:0:ffff:c0a8:0101"],
    ["NAT64 of a private address", "64:ff9b::10.0.0.1"],
    ["local-use NAT64", "64:ff9b:1::1"],
    ["discard-only", "100::1"],
    ["Teredo", "2001::1"],
    ["IETF protocol assignments", "2001:2::1"],
    ["documentation", "2001:db8::1"],
    ["documentation 3fff::/20", "3fff:abc::1"],
    ["6to4 of a private address", "2002:c0a8:101::1"],
    ["unique local fc00::/7", "fc00::1"],
    ["unique local fc00::/7", "fd12:3456:789a::1"],
    ["link-local", "fe80::1"],
    ["link-local", "febf::1"],
    ["site-local", "fec0::1"],
    ["multicast", "ff02::1"],
    ["reserved", "4000::1"],
  ])("refuses an IPv6 literal in %s (%s)", (_range, address) => {
    expect(refusal(`https://[${address}]/v1`)?.reason).toBe("address");
  });

  it.each(["2606:4700:4700::1111", "2a00:1450:4001::200e", "::ffff:8.8.8.8", "64:ff9b::808:808"])(
    "allows the public IPv6 literal %s",
    (address) => {
      expect(refusal(`https://[${address}]/v1`)).toBeUndefined();
    },
  );

  it("refuses localhost names outside local development", () => {
    expect(refusal("https://localhost:8080/v1")?.reason).toBe("address");
    expect(refusal("https://api.localhost/v1")?.reason).toBe("address");
    expect(refusal("https://LOCALHOST./v1")?.reason).toBe("address");
  });

  it("allows loopback over http: and https: in local development only", () => {
    const local: OutboundPolicy = { ownHosts: [], localDevelopment: true };

    for (const url of [
      "http://localhost:11434/v1",
      "https://localhost/v1",
      "http://127.0.0.1:8080/v1",
      "http://[::1]:8080/v1",
    ]) {
      expect(refusal(url, local), url).toBeUndefined();
      expect(refusal(url), url).toBeDefined();
    }

    // Local development opens loopback only: http: elsewhere and private addresses stay refused.
    expect(refusal("http://api.example.com/v1", local)?.reason).toBe("scheme");
    expect(refusal("https://10.0.0.1/v1", local)?.reason).toBe("address");
    expect(refusal("https://169.254.169.254/", local)?.reason).toBe("address");
  });

  it("refuses the deployment's own hosts, exactly or under a wildcard", () => {
    const policy: OutboundPolicy = {
      ownHosts: ["example.com", "app.example.com", "API.example.com", "*.acct.workers.dev"],
      localDevelopment: false,
    };

    for (const url of [
      "https://example.com/",
      "https://app.example.com/v1",
      "https://api.example.com./v1",
      "https://commissary-api-pr-1.acct.workers.dev/v1",
    ])
      expect(refusal(url, policy)?.reason, url).toBe("own_host");

    for (const url of [
      "https://other.example.com/",
      "https://example.com.evil.test/",
      "https://someone.else.workers.dev/",
    ])
      expect(refusal(url, policy), url).toBeUndefined();
  });

  it("names the refused host, never the path or query", () => {
    expect(refusal("http://api.example.com/v1?key=secret")?.host).toBe("api.example.com");
  });
});
