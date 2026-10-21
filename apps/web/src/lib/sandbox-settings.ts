// The sandbox toolkit's settings on its page (#225, ADR 0041, ADR 0043, ADR 0044): the org's ceiling on what a sandbox
// session, and a hosted agent's sandbox, may have: whether it may use the computer, and the widest network (none,
// allowed hosts with the "package registries" preset, or the internet). Org admins set it; a session keeps what it
// opened with. The price per computer hour is on the same page, in the prices (`tool-prices.ts`). The server checks
// every rule again; this keeps the panel from offering what would be refused. Pure: no DOM, tested in
// test/sandbox-settings.test.ts.
import type { SandboxNetwork, ToolkitView, UpdateToolkit } from "@commissary/contract/tools";
import {
  fieldsOfNetwork,
  hostsProblem,
  type NetworkFields,
  networkOfFields,
} from "./sandbox-network.ts";

/** A body built a field at a time. */
type Writable<T> = { -readonly [K in keyof T]: T[K] };

/** What the settings form holds: the network ceiling's fields, and whether the computer is allowed. */
export interface SandboxSettingsDraft extends NetworkFields {
  readonly computer: boolean;
}

/** Where `docs/DEPLOY.md`'s "Optional pieces" section is: what an org admin follows to give a deployment a computer. */
export const OPTIONAL_PIECES_URL =
  "https://github.com/spiritledsoftware/commissary/blob/main/docs/DEPLOY.md#optional-pieces";

/**
 * Network access and tool results that carry prompt injection together are a way to leak data (ADR 0041, ADR 0044): the
 * ceiling says what a sandbox may reach, so the form says so where it is set.
 */
export const LEAK_WARNING =
  "A sandbox with a network can send out anything it holds, and a tool result may carry instructions meant to make an agent do that (prompt injection). Network access and untrusted tool results together are a way to leak data: allow the narrowest network that the work needs.";

/** What "may use the computer" is, under its checkbox. */
export const COMPUTER_HINT =
  "The computer runs a command the sandbox's own shell cannot (git, a language runtime) and is priced by the hour (the price is under Prices). With it off, such a command fails with the shell's own error.";

/** The one-line reason "may use the computer" is off where the deployment has no computer (admins only). */
export const NO_COMPUTER_REASON =
  "This deployment has no computer, an optional piece, so it is off.";

/** What a session keeps: a change reaches the sessions opened after it. */
export const SESSIONS_KEEP_NOTE =
  "Open sessions keep the network and the computer they opened with; a change reaches the sessions opened after it.";

/** The settings form's draft of a toolkit's ceiling; the computer reads off where the deployment has none. */
export const draftOfToolkit = (
  toolkit: Pick<ToolkitView, "network" | "computer">,
  computerAvailable: boolean,
): SandboxSettingsDraft => ({
  ...fieldsOfNetwork(toolkit.network),
  computer: computerAvailable && toolkit.computer === true,
});

/** What is wrong with a draft, or `undefined`. */
export const settingsProblem = (draft: SandboxSettingsDraft): string | undefined =>
  hostsProblem(draft);

/** A network as the server stores it: its hosts lowercased and without duplicates, presets only when there are any. */
const comparable = (network: SandboxNetwork): string =>
  JSON.stringify(
    network.kind === "hosts"
      ? {
          kind: "hosts",
          hosts: [...new Set(network.hosts.map((host) => host.toLowerCase().replace(/\.+$/, "")))],
          presets: network.presets ?? [],
        }
      : network,
  );

/** Whether a draft's network differs from the toolkit's. */
const networkChanged = (toolkit: Pick<ToolkitView, "network">, draft: SandboxSettingsDraft) =>
  comparable(networkOfFields(draft)) !== comparable(toolkit.network ?? { kind: "none" });

/** Whether a draft differs from the toolkit's ceiling (where the deployment has no computer, the network only). */
export const settingsChanged = (
  toolkit: Pick<ToolkitView, "network" | "computer">,
  draft: SandboxSettingsDraft,
  computerAvailable: boolean,
): boolean =>
  networkChanged(toolkit, draft) ||
  (computerAvailable && draft.computer !== (toolkit.computer === true));

/**
 * The body that saves a draft: only what changed, so the toolkit's other settings stay as they are. Where the
 * deployment has no computer the body never names it (the server refuses `true`, and a stored `true` is left as it was).
 */
export const settingsBody = (
  toolkit: Pick<ToolkitView, "network" | "computer">,
  draft: SandboxSettingsDraft,
  computerAvailable: boolean,
): UpdateToolkit => {
  const body: Writable<UpdateToolkit> = {};

  if (networkChanged(toolkit, draft)) body.network = networkOfFields(draft);

  if (computerAvailable && draft.computer !== (toolkit.computer === true))
    body.computer = draft.computer;

  return body;
};

/** The network ceiling in a fact of the toolkit's page: "None", "The internet", "Only example.com and the package registries". */
export const networkFact = (network: SandboxNetwork | undefined): string => {
  if (network === undefined || network.kind === "none") return "None";

  if (network.kind === "open") return "The internet";

  const named = network.hosts.length === 0 ? [] : [network.hosts.join(", ")];
  const registries = network.presets?.includes("package_registries") === true;

  return `Only ${[...named, ...(registries ? ["the package registries"] : [])].join(" and ")}`;
};

/**
 * The computer in a fact of the toolkit's page, which members read too: allowed when the org allows it and the
 * deployment has one. A deployment without one says no more to a member than "Not allowed".
 */
export const computerFact = (
  toolkit: Pick<ToolkitView, "computer">,
  computerAvailable: boolean,
): string => (computerAvailable && toolkit.computer === true ? "Allowed" : "Not allowed");
