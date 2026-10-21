import { describe, expect, it } from "vitest";
import type { ToolkitView } from "@commissary/contract/tools";
import { sandboxCeilingText } from "../src/lib/agent-form.ts";
import {
  computerFact,
  draftOfToolkit,
  LEAK_WARNING,
  networkFact,
  NO_COMPUTER_REASON,
  OPTIONAL_PIECES_URL,
  settingsBody,
  settingsChanged,
  settingsProblem,
} from "../src/lib/sandbox-settings.ts";
import { fieldsOfNetwork, hostsProblem, networkOfFields } from "../src/lib/sandbox-network.ts";

type Ceiling = Pick<ToolkitView, "network" | "computer">;

const NONE: Ceiling = {};

describe("the sandbox toolkit's settings form (#225)", () => {
  it("starts from the toolkit's ceiling: no network and no computer until an org admin allows more", () => {
    expect(draftOfToolkit(NONE, true)).toEqual({
      network: "none",
      hosts: "",
      registries: false,
      computer: false,
    });
    expect(
      draftOfToolkit(
        {
          network: {
            kind: "hosts",
            hosts: ["example.com", "*.example.org"],
            presets: ["package_registries"],
          },
          computer: true,
        },
        true,
      ),
    ).toEqual({
      network: "hosts",
      hosts: "example.com\n*.example.org",
      registries: true,
      computer: true,
    });
    expect(draftOfToolkit({ network: { kind: "open" } }, true).network).toBe("open");
  });

  it("shows the computer turned off where the deployment has none, whatever is stored (ADR 0043)", () => {
    expect(draftOfToolkit({ computer: true }, false).computer).toBe(false);
    expect(draftOfToolkit({ computer: true }, true).computer).toBe(true);
  });

  it("builds the network a draft asks for: none, the internet, or hosts with the package registries preset", () => {
    expect(networkOfFields({ network: "none", hosts: "ignored", registries: true })).toEqual({
      kind: "none",
    });
    expect(networkOfFields({ network: "open", hosts: "", registries: false })).toEqual({
      kind: "open",
    });
    expect(
      networkOfFields({
        network: "hosts",
        hosts: "Example.com, *.example.org\nexample.com",
        registries: true,
      }),
    ).toEqual({
      kind: "hosts",
      hosts: ["example.com", "*.example.org"],
      presets: ["package_registries"],
    });
    expect(networkOfFields({ network: "hosts", hosts: "example.com", registries: false })).toEqual({
      kind: "hosts",
      hosts: ["example.com"],
    });
    expect(
      fieldsOfNetwork(networkOfFields({ network: "hosts", hosts: "a.dev", registries: true })),
    ).toEqual({
      network: "hosts",
      hosts: "a.dev",
      registries: true,
    });
  });

  it("refuses a malformed host, and a list of hosts with no host and no preset", () => {
    const fields = { network: "hosts" as const, hosts: "", registries: false };

    expect(settingsProblem({ ...fields, computer: false })).toMatch(/Name a host/);
    expect(settingsProblem({ ...fields, registries: true, computer: false })).toBeUndefined();
    expect(settingsProblem({ ...fields, hosts: "https://example.com", computer: false })).toMatch(
      /not a host name/,
    );
    expect(settingsProblem({ ...fields, hosts: "exa mple.com *.", computer: false })).toMatch(
      /not a host name/,
    );
    expect(hostsProblem({ ...fields, network: "none", hosts: "https://x" })).toBeUndefined();
  });

  it("saves only what changed, so the toolkit's other settings stay as they are", () => {
    const toolkit: Ceiling = {
      network: { kind: "hosts", hosts: ["example.com"], presets: ["package_registries"] },
      computer: false,
    };

    const draft = draftOfToolkit(toolkit, true);

    expect(settingsChanged(toolkit, draft, true)).toBe(false);
    expect(settingsBody(toolkit, draft, true)).toEqual({});

    expect(settingsBody(toolkit, { ...draft, computer: true }, true)).toEqual({ computer: true });
    expect(settingsBody(toolkit, { ...draft, network: "open" }, true)).toEqual({
      network: { kind: "open" },
    });
    expect(
      settingsBody(
        toolkit,
        { ...draft, hosts: "example.com\nnew.example.com", registries: false },
        true,
      ),
    ).toEqual({ network: { kind: "hosts", hosts: ["example.com", "new.example.com"] } });
    expect(settingsBody(NONE, { ...draftOfToolkit(NONE, true), network: "none" }, true)).toEqual(
      {},
    );
  });

  it("does not count a retyped host (case, spacing, a trailing dot) as a change", () => {
    const toolkit: Ceiling = { network: { kind: "hosts", hosts: ["example.com"] } };

    expect(
      settingsChanged(
        toolkit,
        { network: "hosts", hosts: " Example.COM. ", registries: false, computer: false },
        true,
      ),
    ).toBe(false);
  });

  it("never names the computer where the deployment has none: a stored allowance is left as it was", () => {
    const toolkit: Ceiling = { computer: true };
    const draft = draftOfToolkit(toolkit, false);

    expect(settingsChanged(toolkit, draft, false)).toBe(false);
    expect(settingsBody(toolkit, { ...draft, network: "open" }, false)).toEqual({
      network: { kind: "open" },
    });
  });

  it("states the ceiling in words, as the agent editor does", () => {
    expect(sandboxCeilingText({ network: { kind: "open" }, computer: true })).toBe(
      "the internet and the computer",
    );
    expect(networkFact(undefined)).toBe("None");
    expect(networkFact({ kind: "open" })).toBe("The internet");
    expect(
      networkFact({ kind: "hosts", hosts: ["a.dev", "b.dev"], presets: ["package_registries"] }),
    ).toBe("Only a.dev, b.dev and the package registries");
    expect(networkFact({ kind: "hosts", hosts: [], presets: ["package_registries"] })).toBe(
      "Only the package registries",
    );
  });

  it("tells members the computer is allowed or not, and explains no absence (ADR 0043)", () => {
    expect(computerFact({ computer: true }, true)).toBe("Allowed");
    expect(computerFact({ computer: true }, false)).toBe("Not allowed");
    expect(computerFact({}, true)).toBe("Not allowed");
  });

  it("explains the reason an admin sees, with the docs' Optional pieces section, and the leak the network risks", () => {
    expect(NO_COMPUTER_REASON).toMatch(/no computer/);
    expect(OPTIONAL_PIECES_URL).toMatch(/docs\/DEPLOY\.md#optional-pieces$/);
    expect(LEAK_WARNING).toMatch(/prompt injection/);
    expect(LEAK_WARNING).toMatch(/leak data/);
  });
});
