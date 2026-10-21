// A hosted agent's sandbox (#230) as Tools checks it for the Agents area's routes: the toolkit it names must be a
// sandbox toolkit its owner sees, and the network and computer its runs' sessions ask for must be within that
// toolkit's ceiling, as for a client's `sandbox_open`. A run's session still fits as long as neither the definition nor
// the ceiling narrowed below what it was opened with; widening either leaves it as it is.
import { describe, expect, it } from "@effect/vitest";
import { agentSandboxFits, agentSandboxRefusal } from "../../src/sandbox/agent-sandbox.ts";

const SANDBOX = { kind: "sandbox" };

describe("an agent's sandbox", () => {
  it("names a sandbox toolkit its owner sees", () => {
    expect(agentSandboxRefusal({ toolkit: "sandbox" }, SANDBOX)).toBeUndefined();
    expect(agentSandboxRefusal({ toolkit: "sandbox" }, undefined)).toBe(
      '"sandbox" is no sandbox toolkit the agent\'s owner can use',
    );
    expect(agentSandboxRefusal({ toolkit: "browser" }, { kind: "browser" })).toBe(
      '"browser" is no sandbox toolkit the agent\'s owner can use',
    );
  });

  it("asks for a network within the toolkit's ceiling, none by default", () => {
    const hosts = { kind: "hosts" as const, hosts: ["example.com"] };

    expect(agentSandboxRefusal({ toolkit: "sandbox", network: hosts }, SANDBOX)).toBe(
      "the sandbox toolkit allows at most no network",
    );
    expect(
      agentSandboxRefusal(
        { toolkit: "sandbox", network: hosts },
        { ...SANDBOX, network: { kind: "hosts", hosts: ["*.example.com", "example.com"] } },
      ),
    ).toBeUndefined();
    expect(
      agentSandboxRefusal(
        { toolkit: "sandbox", network: { kind: "open" } },
        { ...SANDBOX, network: hosts },
      ),
    ).toBe("the sandbox toolkit allows at most only example.com");
    expect(
      agentSandboxRefusal(
        { toolkit: "sandbox", network: { kind: "hosts", hosts: ["not a host"] } },
        { ...SANDBOX, network: { kind: "open" } },
      ),
    ).toMatch(/^invalid network: "not a host" is not a host name/);
  });

  it("may use the computer only where the toolkit allows it", () => {
    expect(agentSandboxRefusal({ toolkit: "sandbox", computer: true }, SANDBOX)).toBe(
      "the sandbox toolkit does not allow the computer",
    );
    expect(
      agentSandboxRefusal({ toolkit: "sandbox", computer: true }, { ...SANDBOX, computer: true }),
    ).toBeUndefined();
    expect(agentSandboxRefusal({ toolkit: "sandbox", computer: false }, SANDBOX)).toBeUndefined();
  });
});

describe("a run's session", () => {
  const hosts = { kind: "hosts" as const, hosts: ["example.com"] };
  const wide = { ...SANDBOX, network: { kind: "open" as const }, computer: true };
  const opened = { toolkit: "sandbox", network: hosts, computer: true };

  it("fits a definition and a ceiling as wide as it was opened with, or wider", () => {
    expect(agentSandboxFits(opened, opened, wide)).toBe(true);
    expect(
      agentSandboxFits(
        { toolkit: "sandbox", network: { kind: "open" }, computer: true },
        opened,
        wide,
      ),
    ).toBe(true);
    expect(agentSandboxFits({ toolkit: "sandbox" }, { toolkit: "sandbox" }, SANDBOX)).toBe(true);
  });

  it("no longer fits a definition or a ceiling narrowed since, nor another toolkit", () => {
    expect(agentSandboxFits({ toolkit: "sandbox", computer: true }, opened, wide)).toBe(false);
    expect(agentSandboxFits({ toolkit: "sandbox", network: hosts }, opened, wide)).toBe(false);
    expect(agentSandboxFits(opened, opened, { ...SANDBOX, network: hosts })).toBe(false);
    expect(agentSandboxFits(opened, opened, { ...SANDBOX, network: { kind: "open" } })).toBe(false);
    expect(agentSandboxFits({ ...opened, toolkit: "other" }, opened, wide)).toBe(false);
  });
});
