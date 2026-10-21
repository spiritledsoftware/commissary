// A fake computer for the sandbox's session objects (#223): the tests fake the container. It stands where the
// container's backend stands in the session's Workspace, works on the Workspace's own files (as computerd's FUSE mount
// does), keeps nothing of its own (so a computer that starts again finds only what the files hold), and sends every
// request through the session's egress, as the real one's outbound intercept does. Its "image" knows a few commands:
//
// - `mise use <tool>@<version>`: fetches the tool's release (Node.js's from nodejs.org, Python's from GitHub's release
//   assets) through the egress, and on success installs it under mise's directory in the Workspace (`MISE_HOME`), with
//   its shim, and writes `mise.toml`, as mise does;
// - `node --version`, `node <file>`, `python3 --version`: through the installed shim, reading the Workspace's files;
// - `curl -sS <url>`: through the egress;
// - `nap <seconds>`: takes that many real seconds, as a slow command does (#241's tests of calls at once);
// - those joined by `&&`.
//
// Anything else is not found, as on the barebones image. Each start of a session's computer is counted, by session.
import { SandboxSession } from "../../src/sandbox/cloudflare/session.ts";
import type { ComputerBackend } from "../../src/sandbox/cloudflare/session.ts";
import { MISE_HOME } from "../../src/sandbox/cloudflare/computer.ts";
import { fakeContainerOf, realContainerOrgs, withContainer } from "./fake-container.ts";

/** How many times each session object's computer started (`connect`), by the object's id. */
export const computerStarts = new Map<string, number>();

/** Where mise installs a tool's shim. */
const SHIMS = `${MISE_HOME}/data/shims`;

/** What `mise use` downloads for each tool it knows, and the version it reports. */
const RELEASES = {
  node: (version) => ({
    url: `https://nodejs.org/dist/latest-v${version}.x/node-v${version}.0.0-linux-x64.tar.xz`,
    reports: `v${version}.0.0`,
  }),
  python: (version) => ({
    url: `https://github.com/astral-sh/python-build-standalone/releases/download/20250101/cpython-${version}.0-x86_64-unknown-linux-gnu-install_only.tar.gz`,
    reports: `Python ${version}.0`,
  }),
} satisfies Record<string, (version: string) => { url: string; reports: string }>;

/** The commands of each shim. */
const SHIM_COMMANDS = { node: "node", python3: "python" } satisfies Record<string, string>;

/** `of[key]`, for a key that may not be one of its own. */
const own = <V>(of: Readonly<Record<string, V>>, key: string): V | undefined =>
  Object.hasOwn(of, key) ? of[key] : undefined;

interface Run {
  readonly exitCode: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

/** The Workspace's files, as the backend's host hands them. */
interface Files {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, options: { recursive: boolean }): Promise<void>;
}

const resolve = (cwd: string, path: string) => (path.startsWith("/") ? path : `${cwd}/${path}`);

const readOrUndefined = async (files: Files, path: string) =>
  await files.readFile(path, "utf8").catch(() => undefined);

/** One command line on the fake image: commands joined by `&&`, each run while the one before succeeds. */
const runOn = async (files: Files, gateway: Fetcher, source: string, cwd: string): Promise<Run> => {
  let stdout = "";
  let stderr = "";

  for (const part of source.split("&&")) {
    const run = await runOne(files, gateway, part, cwd);

    stdout += run.stdout ?? "";
    stderr += run.stderr ?? "";

    if (run.exitCode !== 0) return { exitCode: run.exitCode, stdout, stderr };
  }

  return { exitCode: 0, stdout, stderr };
};

/** One command on the fake image. */
const runOne = async (
  files: Files,
  gateway: Fetcher,
  source: string,
  cwd: string,
): Promise<Run> => {
  const [command = "", ...args] = source.trim().split(/\s+/);

  /** A fetch through the egress, or why it failed, as a download tool reports it. */
  const download = async (url: string): Promise<{ text: string } | { error: string }> => {
    try {
      const response = await gateway.fetch(url);

      return response.ok ? { text: await response.text() } : { error: `HTTP ${response.status}` };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };

  if (command === "mise" && args[0] === "use") {
    const [tool = "", version = ""] = (args[1] ?? "").split("@");

    const release = own<(version: string) => { url: string; reports: string }>(
      RELEASES,
      tool,
    )?.(version);

    if (release === undefined) return { exitCode: 1, stderr: `mise ERROR unknown tool ${tool}\n` };
    const fetched = await download(release.url);

    if ("error" in fetched)
      return {
        exitCode: 1,
        stderr: `mise ERROR failed to download ${release.url}: ${fetched.error}\n`,
      };

    const installed = `${MISE_HOME}/data/installs/${tool}/${version}`;

    await files.mkdir(`${installed}/bin`, { recursive: true });
    await files.writeFile(`${installed}/bin/${tool}`, release.reports);
    await files.mkdir(SHIMS, { recursive: true });

    for (const [shim, of] of Object.entries(SHIM_COMMANDS))
      if (of === tool) await files.writeFile(`${SHIMS}/${shim}`, `${installed}/bin/${tool}`);

    await files.writeFile(`${cwd}/mise.toml`, `[tools]\n${tool} = "${version}"\n`);

    return { exitCode: 0, stderr: `mise ${tool}@${version} installed\n` };
  }

  if (command === "nap") {
    await new Promise((done) => setTimeout(done, Number(args[0] ?? 0) * 1000));

    return { exitCode: 0 };
  }

  if (command === "curl") {
    const url = args.at(-1) ?? "";
    const fetched = await download(url);

    return "error" in fetched
      ? { exitCode: 6, stderr: `curl: (6) ${fetched.error}\n` }
      : { exitCode: 0, stdout: fetched.text };
  }

  if (Object.hasOwn(SHIM_COMMANDS, command)) {
    const binary = await readOrUndefined(files, `${SHIMS}/${command}`);
    const reports = binary === undefined ? undefined : await readOrUndefined(files, binary);

    if (reports === undefined)
      return { exitCode: 127, stderr: `bash: line 1: ${command}: command not found\n` };

    if (args[0] === "--version") return { exitCode: 0, stdout: `${reports}\n` };
    const script = await readOrUndefined(files, resolve(cwd, args[0] ?? ""));

    return script === undefined
      ? { exitCode: 1, stderr: `${command}: cannot open ${args[0] ?? ""}\n` }
      : { exitCode: 0, stdout: `${reports} ran ${args[0]}: ${script}` };
  }

  return { exitCode: 127, stderr: `bash: line 1: ${command}: command not found\n` };
};

/** A run's events as computerd streams them. */
const events = (id: string, run: Run) => {
  const encoder = new TextEncoder();
  let seq = 0;

  return new ReadableStream({
    start(controller) {
      if (run.stdout !== undefined && run.stdout !== "")
        controller.enqueue({ id, seq: ++seq, name: "stdout", value: encoder.encode(run.stdout) });

      if (run.stderr !== undefined && run.stderr !== "")
        controller.enqueue({ id, seq: ++seq, name: "stderr", value: encoder.encode(run.stderr) });

      controller.enqueue({ id, seq: ++seq, name: "exit", code: run.exitCode });
      controller.close();
    },
  });
};

/** The fake computer of the session object `objectId`, whose requests leave through `gateway`. */
export const fakeComputer = (objectId: string, gateway: Fetcher): ComputerBackend => ({
  id: "computer",
  type: "fake-computer",
  connect: async (host) => {
    computerStarts.set(objectId, (computerStarts.get(objectId) ?? 0) + 1);
    const files = host.fs as unknown as Files;

    return {
      // Its files are the Workspace's own (as through the FUSE mount): nothing to sync.
      sync: "none",
      rpc: {
        sync: {} as never,
        shell: {
          exec: async (input) => {
            const id = input.id ?? crypto.randomUUID();

            return {
              id,
              events: events(
                id,
                await runOn(files, gateway, input.source, input.cwd ?? "/workspace"),
              ),
            };
          },
          getExec: (input) => Promise.reject(new Error(`no such exec: ${input.id}`)),
          killExec: async () => {},
          disposeExec: async () => {},
        },
      },
      close: async () => {},
    };
  },
  // Its requests leave through `gateway` itself: nothing comes back to the session.
  handleFetch: () => Promise.resolve(new Response("not found", { status: 404 })),
});

/**
 * `SandboxSession` on a deployment that has the computer, with a fake container attached (`fake-container.ts`): every
 * test session may be given the computer, and whether it is depends on what the session opened with, as deployed. Its
 * computer is the fake above, or, for the orgs in `realContainerOrgs`, `@cloudflare/computer`'s own container backend
 * over the fake container.
 */
export class FakeComputerSandboxSession extends SandboxSession {
  protected override containerState(): DurableObjectState {
    return withContainer(this.ctx, fakeContainerOf(this.ctx.id.toString()));
  }

  protected override computerBackend(gateway: Fetcher): Promise<ComputerBackend> | undefined {
    const org = this.ctx.id.name?.split(":")[0] ?? "";

    return realContainerOrgs.has(org)
      ? super.computerBackend(gateway)
      : Promise.resolve(fakeComputer(this.ctx.id.toString(), gateway));
  }
}
