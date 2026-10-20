/**
 * Whether the deployment has the sandbox's computer (ADR 0041, ADR 0043, #223), as the Workers that need to know read
 * it: the state Worker's Tools part (whether "may use the computer" can be turned on) and the app Worker
 * (`deployment.computer` on `GET /v9/management/me`).
 *
 * The computer is a Cloudflare Container attached to the `SandboxSession` Durable Object class: it appears only as
 * `ctx.container` inside that class's objects, and has no binding in any Worker's `env`. So the deploy binds this
 * variable beside it (alchemy.run.ts, from the one `COMMISSARY_COMPUTER` setting that attaches the container), and the
 * session object checks `ctx.container` itself too. Name and value live here only, for the deploy and the checks alike.
 */

/** The variable the deploy binds exactly when it attaches the computer's container: its name and value. */
export const COMPUTER_MARKER = { COMPUTER: "on" } as const;

/** A Worker's view of the marker. */
export interface ComputerMarker {
  /** `on` exactly when the deployment has the computer ({@link COMPUTER_MARKER}). */
  readonly COMPUTER?: string | undefined;
}

/**
 * The computer's image as the deploy names it: the id of its Alchemy Container (alchemy.run.ts), which is its key in
 * the session object's `ctx.container.images`.
 */
export const COMPUTER_IMAGE = "Computer";

/**
 * The instance sizes a deployment may give the computer (`COMMISSARY_COMPUTER_INSTANCE`): Cloudflare's named ones, as
 * its Containers documentation lists them (the Workers types lag behind: they lack `basic`).
 */
export const COMPUTER_INSTANCES = [
  "lite",
  "basic",
  "standard-1",
  "standard-2",
  "standard-3",
  "standard-4",
] as const;

export type ComputerInstance = (typeof COMPUTER_INSTANCES)[number];

/** The instance size `value` names, or undefined when it names none (`COMMISSARY_COMPUTER_INSTANCE`, case aside). */
export const computerInstanceOf = (value: string): ComputerInstance | undefined =>
  COMPUTER_INSTANCES.find((instance) => instance === value.trim().toLowerCase());

/**
 * The default size: `standard-1` (1/2 vCPU, 4 GiB of memory, 8 GB of disk). computerd holds the container's copy of
 * the Workspace in memory, and a Node.js or Python install through mise is some 100 to 200 MB unpacked beside its
 * download, so `lite` (256 MiB) cannot hold one and 4 GiB holds one comfortably.
 */
export const DEFAULT_COMPUTER_INSTANCE: ComputerInstance = "standard-1";

/** Whether the deployment has the computer, from the marker in `env`. */
export const hasComputer = (env: ComputerMarker): boolean =>
  env.COMPUTER === COMPUTER_MARKER.COMPUTER;
