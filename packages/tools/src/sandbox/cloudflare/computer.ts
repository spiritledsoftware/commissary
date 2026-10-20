/**
 * The computer of Cloudflare's sandbox (ADR 0041, #223): a Cloudflare Container attached to the `SandboxSession` class,
 * one per session object, running computerd on the session's Workspace files (`@cloudflare/computer`'s container
 * backend: computerd's FUSE mount at `/workspace`, synced with the object's SQLite over a capnweb WebSocket). A session
 * runs a command there only when just-bash cannot run it at all (`fallback.ts`), and only when it may use the computer.
 *
 * - **Lifecycle.** It starts at the session's first fallback and stops after {@link COMPUTER_IDLE_MS} without use (the
 *   container's inactivity timeout). The files stay in the Workspace, so the next fallback starts a fresh computer on
 *   the same files. One instance size per deployment (`COMMISSARY_COMPUTER_INSTANCE`, `@commissary/core`).
 * - **A barebones image** (`infra/computer/Dockerfile`): computerd, mise and what mise needs to download and unpack.
 *   mise keeps its data, cache, config and state under {@link MISE_HOME}, in the Workspace, and its shims are first on
 *   the commands' `PATH`, so `mise use node@22` lasts as long as the session and survives the computer stopping.
 * - **One egress point** (ADR 0044). Its outbound HTTP and HTTPS are intercepted to the session object (the
 *   container's `interceptAllOutboundHttp`, through `WorkspaceProxy`), whose computer backend hands each request to
 *   the sandbox's `SandboxEgress` with the session's network and the outbound guard, as just-bash's are.
 *   `enableInternet` is always `false`, set explicitly whatever the backend asks for ({@link guardedContainer}): nothing
 *   leaves but through the egress.
 * - **No credential of Commissary's enters it.** Its environment holds computerd's settings and mise's directories only
 *   ({@link COMPUTER_ENV}); {@link guardedContainer} refuses any other. Beneath it, `@cloudflare/computer` adds the
 *   per-container `RPC_CLIENT_SECRET`: a random value of the session object's own, which authorizes computerd's
 *   connection back to this session (`/api`) and the object's requests to computerd. computerd keeps it from the
 *   commands' environment, but the commands run as root (computerd has no way to run them as another user, and its
 *   FUSE mount admits its own user only), so a command can read it from `/proc`. It reaches nothing but this session's
 *   own computerd channel: the same files and commands the command has already.
 */
import type {
  ContainerBackend,
  ContainerLaunchSpec,
  IWorkspaceContainerAPI,
} from "@cloudflare/computer/backends/container";
import { COMPUTER_IMAGE, type ComputerInstance } from "@commissary/core";
import { SANDBOX_HOME } from "../provider.ts";

/** The computer's backend id in a session's Workspace (just-bash's keeps the package's default). */
export const COMPUTER_BACKEND = "computer";

/** How long the computer keeps running without a command: ten minutes (ADR 0041). */
export const COMPUTER_IDLE_MS = 10 * 60 * 1000;

/** Where mise keeps everything, inside the Workspace. */
export const MISE_HOME = `${SANDBOX_HOME}/.mise`;

/** The system's CA bundle, which the image's entrypoint adds the containers' interception CA to. */
const CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";

/**
 * The computer's environment: computerd's shell (bash, as the commands that come to it are bash's), and for every
 * command it runs (`COMPUTER_VAR_`, which computerd strips): mise's directories and shims, mise without prompts, and
 * the CA bundle for runtimes that keep their own (Node.js, Python's `requests` and pip), since its HTTPS goes through
 * the interception. Nothing else, and no credential.
 */
export const COMPUTER_ENV = {
  EXEC_SHELL: "/bin/bash",
  COMPUTER_VAR_PATH: `${MISE_HOME}/data/shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
  COMPUTER_VAR_MISE_DATA_DIR: `${MISE_HOME}/data`,
  COMPUTER_VAR_MISE_CACHE_DIR: `${MISE_HOME}/cache`,
  COMPUTER_VAR_MISE_CONFIG_DIR: `${MISE_HOME}/config`,
  COMPUTER_VAR_MISE_STATE_DIR: `${MISE_HOME}/state`,
  COMPUTER_VAR_MISE_TRUSTED_CONFIG_PATHS: SANDBOX_HOME,
  COMPUTER_VAR_MISE_YES: "1",
  COMPUTER_VAR_NODE_EXTRA_CA_CERTS: CA_BUNDLE,
  COMPUTER_VAR_SSL_CERT_FILE: CA_BUNDLE,
  COMPUTER_VAR_REQUESTS_CA_BUNDLE: CA_BUNDLE,
  COMPUTER_VAR_PIP_CERT: CA_BUNDLE,
} as const satisfies Readonly<Record<string, string>>;

/** What the container backend itself sets: computerd's port and mount point. */
const BACKEND_ENV = new Set(["PORT", "MOUNT_POINT"]);

/**
 * Cloudflare refused to start the computer: the deployment's account is at its limit of containers. The session answers
 * it in these words; it reaches the session as the cause of the container backend's own error.
 */
export class ComputerAtLimit extends Error {
  override readonly name = "ComputerAtLimit";

  constructor(readonly refusal: string) {
    super(
      `Cloudflare refused to start the computer: the deployment's account is at its limit of containers (${refusal}).`,
    );
  }
}

/** Whether `error`, or an error it was caused by, is {@link ComputerAtLimit}. */
export const atLimit = (error: Error): ComputerAtLimit | undefined => {
  for (let cause: unknown = error, depth = 0; cause instanceof Error && depth < 8; depth += 1) {
    if (cause instanceof ComputerAtLimit) return cause;
    cause = cause.cause;
  }

  return undefined;
};

/** Cloudflare's own words when it has no container for the object, or too many start at once. */
const LIMIT_ERRORS = [
  "there is no container instance that can be provided to this durable object",
  "you are requesting too many containers per second",
];

/** `spec` held to what the computer may have: no internet but through the egress, and no environment beyond its own. */
const guardedSpec = (spec: ContainerLaunchSpec): ContainerLaunchSpec => {
  const extra = Object.keys(spec.env).filter(
    (name) => !BACKEND_ENV.has(name) && !Object.hasOwn(COMPUTER_ENV, name),
  );

  if (extra.length > 0)
    throw new Error(`the computer gets no environment beyond its own, not ${extra.join(", ")}`);

  // Always explicit (ADR 0044): the Containers documentation conflicts about the default.
  return { ...spec, enableInternet: false };
};

/** A start's failure, with the account's limit in words when that is what refused it. */
const startFailure = (error: Error): Error =>
  LIMIT_ERRORS.some((words) => error.message.toLowerCase().includes(words))
    ? new ComputerAtLimit(error.message)
    : error;

/**
 * `host` (the session object's container) as the computer's backend gets it: each launch held to {@link guardedSpec},
 * then given the idle timeout; a refusal at the account's limit said in words. Everything else passes through.
 */
export const guardedContainer = (host: IWorkspaceContainerAPI): IWorkspaceContainerAPI => {
  const launched = async (
    launch: (spec: ContainerLaunchSpec) => ReturnType<IWorkspaceContainerAPI["start"]>,
    spec: ContainerLaunchSpec,
  ) => {
    const guarded = guardedSpec(spec);
    let runtime: Awaited<ReturnType<IWorkspaceContainerAPI["start"]>>;

    try {
      runtime = await launch(guarded);
    } catch (error) {
      throw startFailure(error instanceof Error ? error : new Error(String(error)));
    }

    await host.setInactivityTimeout(COMPUTER_IDLE_MS);

    return runtime;
  };

  return {
    start: (spec) => launched((guarded) => host.start(guarded), spec),
    restart: (spec) => launched((guarded) => host.restart(guarded), spec),
    interceptOutboundHttp: (hostname, workspace) => host.interceptOutboundHttp(hostname, workspace),
    interceptAllOutboundHttp: (workspace, token) => host.interceptAllOutboundHttp(workspace, token),
    fetchPort: (port, input, init) => host.fetchPort(port, input, init),
    port: (port) => host.port(port),
    setInactivityTimeout: (durationMs) => host.setInactivityTimeout(durationMs),
    status: () => host.status(),
    exitInfo: () => host.exitInfo(),
  };
};

/** What a session hands its computer: the container, its Workspace's object, its egress, and the deployment's size. */
export interface ComputerOptions {
  /** The session object's state, whose `ctx.container` the computer is (through `@cloudflare/computer`'s host over it). */
  readonly state: DurableObjectState;
  /** The session object, as the container's outbound intercept finds it again. */
  readonly workspace: { readonly binding: string; readonly id: string };
  /** The sandbox's egress entrypoint with the session's network and the outbound guard's policy. */
  readonly gateway: Fetcher;
  readonly instance: ComputerInstance;
}

/** The computer's Workspace backend: `@cloudflare/computer`'s container backend over {@link guardedContainer}. */
export const computerBackend = async (options: ComputerOptions): Promise<ContainerBackend> => {
  const { ContainerBackend, WorkspaceContainerAPI } =
    await import("@cloudflare/computer/backends/container");

  return new ContainerBackend({
    id: COMPUTER_BACKEND,
    container: () => ({
      getWorkspaceContainer: () => guardedContainer(new WorkspaceContainerAPI(options.state)),
    }),
    workspace: options.workspace,
    // Every request the computer makes goes to the egress; the backend then sets `enableInternet: false` too.
    egress: { mode: "http-gateway", gateway: options.gateway },
    name: COMPUTER_IMAGE,
    // SAFETY: every `ComputerInstance` is one of Cloudflare's sizes (its Containers documentation); the Workers types
    // that `ContainerInstanceSize` comes from lag behind it (they lack `basic`).
    instance: options.instance as NonNullable<ContainerLaunchSpec["instance"]>,
    containerEnv: { ...COMPUTER_ENV },
  });
};
