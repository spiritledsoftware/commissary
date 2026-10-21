// The sandbox toolkit's pure parts (#222): the network a session may ask for under the org's ceiling and what its egress
// lets through (the network, then the outbound guard); the tools over a provider that answers what the test says, with
// output cut as pi cuts it and edits matched against the original; and the loader wrapper that holds the shell's
// Dynamic Worker to its files and the egress entrypoint.
import { describe, expect, it } from "@effect/vitest";
import { Effect, Result, type Schema } from "effect";
import type { SandboxNetwork } from "@commissary/contract/tools";
import { fileFailure } from "../../src/sandbox/cloudflare/files.ts";
import { guardedLoader } from "../../src/sandbox/cloudflare/loader.ts";
import { egressRefusal, networkProblem, withinCeiling } from "../../src/sandbox/network.ts";
import type { CommandResult, SandboxProvider } from "../../src/sandbox/provider.ts";
import {
  applyEdits,
  callSandboxTool as callWithTime,
  resolvePath,
  SANDBOX_TOOLS,
  type SandboxSessionLog,
} from "../../src/sandbox/toolkit.ts";
import { fakeSandboxProvider } from "../support/fake-sandbox.ts";

/** A call's tool result, without the computer time (#224) the fake provider never meters. */
const callSandboxTool = (...args: Parameters<typeof callWithTime>) =>
  callWithTime(...args).pipe(Effect.map((answer) => answer.result));

const POLICY = { ownHosts: ["app.example.com"], localDevelopment: false };

const NONE: SandboxNetwork = { kind: "none" };

const OPEN: SandboxNetwork = { kind: "open" };

const hosts = (list: ReadonlyArray<string>, registries = false): SandboxNetwork => ({
  kind: "hosts",
  hosts: list,
  ...(registries ? { presets: ["package_registries"] as const } : {}),
});

const IGNORED: SandboxSessionLog = { opened: () => {}, used: () => {}, ended: () => {} };

const CALL = {
  owner: { org: "org-a", principal: "user:alice@example.com" },
  sessions: IGNORED,
  ceiling: { network: NONE, computer: false },
  policy: POLICY,
  now: 0,
};

/** A log of what the toolkit told the Tools part of its sessions, and the call that tells it. */
const logging = () => {
  const told: Array<string> = [];

  const sessions: SandboxSessionLog = {
    opened: (id) => told.push(`opened ${id}`),
    used: (id) => told.push(`used ${id}`),
    ended: (id) => told.push(`ended ${id}`),
  };

  return { told, call: { ...CALL, sessions } };
};

const textOf = (result: Schema.JsonObject): string =>
  (result["content"] as ReadonlyArray<{ text: string }>)[0]?.text ?? "";

/** The fake provider, whose `run` answers `result` instead. */
const running = (result: CommandResult): SandboxProvider => ({
  ...fakeSandboxProvider(),
  run: () => Effect.succeed({ value: result }),
});

describe("a sandbox's network", () => {
  it("asks for no more than the org's ceiling", () => {
    expect(withinCeiling(NONE, NONE)).toBe(true);
    expect(withinCeiling(hosts(["a.example.com"]), NONE)).toBe(false);
    expect(withinCeiling(OPEN, hosts(["*.example.com"]))).toBe(false);
    expect(withinCeiling(OPEN, OPEN)).toBe(true);
    expect(withinCeiling(hosts(["anything.example.net"]), OPEN)).toBe(true);

    const ceiling = hosts(["*.example.com", "exact.example.org"]);

    expect(withinCeiling(hosts(["a.example.com", "b.c.example.com"]), ceiling)).toBe(true);
    expect(withinCeiling(hosts(["*.sub.example.com"]), ceiling)).toBe(true);
    expect(withinCeiling(hosts(["exact.example.org"]), ceiling)).toBe(true);
    expect(withinCeiling(hosts(["example.com"]), ceiling)).toBe(false);
    expect(withinCeiling(hosts(["*.example.org"]), ceiling)).toBe(false);
    expect(withinCeiling(hosts(["other.example.org"]), ceiling)).toBe(false);
    // The preset is its hosts: within a ceiling that has the preset, not within one that lacks them.
    expect(withinCeiling(hosts([], true), hosts([], true))).toBe(true);
    expect(withinCeiling(hosts(["registry.npmjs.org"]), hosts([], true))).toBe(true);
    expect(withinCeiling(hosts([], true), ceiling)).toBe(false);
  });

  it("names hosts only", () => {
    expect(
      networkProblem(hosts(["example.com", "*.example.org", "Mixed.Case.io."])),
    ).toBeUndefined();

    for (const bad of [
      "https://example.com",
      "example.com/path",
      "example.com:443",
      "*",
      "a..b",
      "",
    ])
      expect(networkProblem(hosts([bad]))).toContain("is not a host name");
  });

  it("lets through only what its network allows, and never what the outbound guard refuses", () => {
    expect(egressRefusal("https://example.com/", NONE, POLICY)).toBe("the sandbox has no network");
    expect(egressRefusal("https://example.com/", OPEN, POLICY)).toBeUndefined();

    const allowed = hosts(["*.example.com"], true);

    expect(egressRefusal("https://api.example.com/x", allowed, POLICY)).toBeUndefined();
    expect(egressRefusal("https://registry.npmjs.org/left-pad", allowed, POLICY)).toBeUndefined();
    expect(egressRefusal("https://example.org/", allowed, POLICY)).toBe(
      "the sandbox's network does not allow example.org",
    );

    for (const network of [
      OPEN,
      hosts(["*.example.com", "10.0.0.1", "localhost", "169.254.169.254"]),
    ])
      for (const url of [
        "http://api.example.com/",
        "https://10.0.0.1/",
        "https://localhost/",
        "https://169.254.169.254/latest/meta-data",
        "https://app.example.com/v9/management/me",
      ])
        expect([url, egressRefusal(url, network, POLICY)]).toEqual([
          url,
          "Commissary only reaches public HTTPS addresses",
        ]);

    expect(egressRefusal("https://[::1]/", OPEN, POLICY)).toBe(
      "Commissary only reaches public HTTPS addresses",
    );
  });
});

describe("the sandbox toolkit's tools", () => {
  it("are pi's coding tools, reading and listing only reading", () => {
    expect(SANDBOX_TOOLS.map((tool) => [tool.name, tool.annotations["readOnlyHint"]])).toEqual([
      ["open", false],
      ["bash", false],
      ["read", true],
      ["write", false],
      ["edit", false],
      ["list", true],
      ["close", false],
    ]);

    const bash = SANDBOX_TOOLS.find((tool) => tool.name === "bash");

    expect(bash?.inputSchema["required"]).toEqual(["session", "command"]);
  });

  it("resolve paths under the working directory", () => {
    expect(resolvePath("notes.txt")).toBe("/workspace/notes.txt");
    expect(resolvePath("./a/../b/c.txt")).toBe("/workspace/b/c.txt");
    expect(resolvePath("/etc/passwd")).toBe("/etc/passwd");
    expect(resolvePath("../../..")).toBe("/");
  });

  it.effect("refuse invalid arguments and unknown tools as tool errors", () =>
    Effect.gen(function* () {
      const provider = fakeSandboxProvider();

      expect(yield* callSandboxTool(provider, CALL, "bash", {})).toMatchObject({
        isError: true,
      });
      expect(textOf(yield* callSandboxTool(provider, CALL, "rm", {}))).toBe(
        "The sandbox has no tool rm.",
      );
      expect(
        textOf(
          yield* callSandboxTool(provider, CALL, "bash", {
            session: "s",
            command: "ls",
            timeout: 601,
          }),
        ),
      ).toContain("Invalid arguments");
    }),
  );

  it.effect("cut a command's output to its last 2000 lines and state it, as pi does", () =>
    Effect.gen(function* () {
      const lines = Array.from({ length: 2500 }, (_, index) => `line ${index + 1}`).join("\n");

      const result = yield* callSandboxTool(
        running({ exitCode: 0, stdout: { text: lines }, stderr: { text: "" } }),
        CALL,
        "bash",
        { session: "s", command: "seq" },
      );

      const text = textOf(result);

      expect(text.startsWith("line 501\n")).toBe(true);
      expect(text.endsWith("line 2500\n\n[Showing lines 501-2500 of 2500.]")).toBe(true);
      expect(result["isError"]).toBeUndefined();
    }),
  );

  it.effect(
    "state a cut the provider made, where it saved the whole, and a failing exit code",
    () =>
      Effect.gen(function* () {
        const result = yield* callSandboxTool(
          running({
            exitCode: 2,
            stdout: {
              text: "tail",
              cut: {
                totalLines: 9000,
                firstLine: 7001,
                partialLine: false,
                limit: "lines",
                savedAt: "/.computer/output/1.stdout",
              },
            },
            stderr: { text: "boom" },
          }),
          CALL,
          "bash",
          { session: "s", command: "build" },
        );

        expect(textOf(result)).toBe(
          "tail\n\n[Showing lines 7001-9000 of 9000. Full output: /.computer/output/1.stdout]\n\nstderr:\nboom\n\nCommand exited with code 2",
        );
        expect(result).toMatchObject({
          isError: true,
          structuredContent: { exit_code: 2, stderr: "boom" },
        });
      }),
  );

  it.effect("state a cut by bytes, and one in the middle of a line, as pi does", () =>
    Effect.gen(function* () {
      const bash = (cut: {
        readonly totalLines: number;
        readonly firstLine: number;
        readonly partialLine: boolean;
        readonly limit: "lines" | "bytes";
      }) =>
        callSandboxTool(
          running({ exitCode: 0, stdout: { text: "end", cut }, stderr: { text: "" } }),
          CALL,
          "bash",
          { session: "s", command: "x" },
        ).pipe(Effect.map(textOf));

      expect(
        yield* bash({ totalLines: 10, firstLine: 4, partialLine: false, limit: "bytes" }),
      ).toBe("end\n\n[Showing lines 4-10 of 10 (50.0KB limit).]");
      expect(yield* bash({ totalLines: 10, firstLine: 4, partialLine: true, limit: "bytes" })).toBe(
        "end\n\n[Showing lines 4-10 of 10 (50.0KB limit; line 4 only in part).]",
      );
      expect(yield* bash({ totalLines: 1, firstLine: 1, partialLine: true, limit: "bytes" })).toBe(
        "end\n\n[Showing last 3B of line 1.]",
      );
    }),
  );

  it.effect("tell the Tools part which sessions opened, were used and ended", () =>
    Effect.gen(function* () {
      const provider = fakeSandboxProvider();
      const { told, call } = logging();
      const opened = yield* callSandboxTool(provider, call, "open", {});
      const session = (opened["structuredContent"] as { session: string }).session;

      yield* callSandboxTool(provider, call, "write", { session, path: "a.txt", content: "a" });
      // A file that is not there is still a use of the session.
      yield* callSandboxTool(provider, call, "read", { session, path: "missing.txt" });
      // Another's session tells nothing.
      yield* callSandboxTool(provider, call, "read", { session: "fake_99", path: "a.txt" });
      yield* callSandboxTool(provider, call, "close", { session });
      // A closed one tells nothing: a session its provider closed reports its close itself (#224).
      yield* callSandboxTool(provider, call, "list", { session });

      expect(told).toEqual([
        `opened ${session}`,
        `used ${session}`,
        `used ${session}`,
        `ended ${session}`,
      ]);
    }),
  );

  it.effect("read a file from an offset, its first 2000 lines at most, saying where to go on", () =>
    Effect.gen(function* () {
      const provider = fakeSandboxProvider();
      const opened = yield* callSandboxTool(provider, CALL, "open", {});
      const session = (opened["structuredContent"] as { session: string }).session;
      const content = Array.from({ length: 3000 }, (_, index) => `${index + 1}`).join("\n");

      yield* callSandboxTool(provider, CALL, "write", { session, path: "big.txt", content });

      const first = textOf(
        yield* callSandboxTool(provider, CALL, "read", { session, path: "big.txt" }),
      );

      expect(
        first.endsWith("2000\n\n[Showing lines 1-2000 of 3000. Use offset=2001 to continue.]"),
      ).toBe(true);
      expect(
        textOf(
          yield* callSandboxTool(provider, CALL, "read", {
            session,
            path: "big.txt",
            offset: 2999,
          }),
        ),
      ).toBe("2999\n3000");
      expect(
        textOf(
          yield* callSandboxTool(provider, CALL, "read", {
            session,
            path: "big.txt",
            offset: 10,
            limit: 2,
          }),
        ),
      ).toBe("10\n11\n\n[2989 more lines in file. Use offset=12 to continue.]");
      expect(
        textOf(
          yield* callSandboxTool(provider, CALL, "read", {
            session,
            path: "big.txt",
            offset: 4000,
          }),
        ),
      ).toBe("Offset 4000 is beyond end of file (3000 lines total)");
    }),
  );
});

describe("the computer (#223)", () => {
  /** A provider with a computer, which records what each session opened with. */
  const withComputer = () => {
    const opened: Array<boolean> = [];
    const fake = fakeSandboxProvider();

    const provider: SandboxProvider = {
      ...fake,
      computer: true,
      open: (owner, options) => {
        opened.push(options.computer);

        return fake.open(owner, options);
      },
    };

    return { opened, provider };
  };

  it("is off unless a session asks for it, and then only within the org's ceiling", () =>
    Effect.gen(function* () {
      const { opened, provider } = withComputer();

      const plain = yield* callSandboxTool(
        provider,
        { ...CALL, ceiling: { network: NONE, computer: true } },
        "open",
        {},
      );

      expect(plain["structuredContent"]).toMatchObject({ computer: false });
      expect(textOf(plain)).toContain("the computer off");

      const refused = yield* callSandboxTool(provider, CALL, "open", { computer: true });

      expect([refused["isError"], textOf(refused)]).toEqual([
        true,
        "The org does not allow the computer: a sandbox runs every command with just-bash. An org admin may allow it on the sandbox toolkit.",
      ]);

      const allowed = yield* callSandboxTool(
        provider,
        { ...CALL, ceiling: { network: NONE, computer: true } },
        "open",
        {
          computer: true,
        },
      );

      expect(allowed["structuredContent"]).toMatchObject({ computer: true });
      expect(textOf(allowed)).toContain("the computer allowed");
      expect(opened).toEqual([false, true]);
    }).pipe(Effect.runPromise));

  it("cannot be turned on where the provider has none, and the toolkit says so", () =>
    Effect.gen(function* () {
      const result = yield* callSandboxTool(
        fakeSandboxProvider(),
        { ...CALL, ceiling: { network: NONE, computer: true } },
        "open",
        { computer: true },
      );

      expect([result["isError"], textOf(result)]).toEqual([
        true,
        'This deployment has no computer, so a sandbox runs every command with just-bash. Its operator can add one (docs/DEPLOY.md, "Optional pieces").',
      ]);
    }).pipe(Effect.runPromise));

  it("tells the model the provider's note after a command's output", () =>
    Effect.gen(function* () {
      const note = "just-bash could not run this command, and this session's computer is off.";

      const result = yield* callSandboxTool(
        running({
          exitCode: 127,
          stdout: { text: "" },
          stderr: { text: "bash: node: command not found\n" },
          note,
        }),
        CALL,
        "bash",
        { session: "fake_1", command: "node --version" },
      );

      expect(result["isError"]).toBe(true);
      expect(textOf(result).startsWith("stderr:\nbash: node: command not found")).toBe(true);
      expect(textOf(result).endsWith(`Command exited with code 127\n\n${note}`)).toBe(true);
      expect(result["structuredContent"]).toMatchObject({ exit_code: 127, note });
    }).pipe(Effect.runPromise));

  it("may download mise's tools under the package registries preset", () => {
    const registries = hosts([], true);

    for (const url of [
      "https://mise.jdx.dev/install.sh",
      "https://mise-versions.jdx.dev/node",
      "https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-x64.tar.xz",
      "https://github.com/astral-sh/python-build-standalone/releases/download/x/cpython.tar.gz",
      "https://release-assets.githubusercontent.com/github-production-release-asset/1",
      "https://objects.githubusercontent.com/github-production-release-asset-2e65be/1",
    ])
      expect([url, egressRefusal(url, registries, POLICY)]).toEqual([url, undefined]);
  });
});

describe("an edit", () => {
  it("replaces each old text found once in the original, all at once", () => {
    expect(
      applyEdits(
        "a b c",
        [
          { oldText: "a", newText: "c" },
          { oldText: "c", newText: "a" },
        ],
        "/f",
      ),
    ).toEqual(Result.succeed("c b a"));
  });

  it("refuses text it cannot find, finds twice, or edits that overlap", () => {
    expect(applyEdits("abc", [{ oldText: "x", newText: "" }], "/f")).toEqual(
      Result.fail(
        "Could not find the text in /f. It must match exactly, including whitespace and newlines.",
      ),
    );
    expect(applyEdits("aa", [{ oldText: "a", newText: "b" }], "/f")).toEqual(
      Result.fail("Found the text more than once in /f. Give more context to make it unique."),
    );
    expect(
      applyEdits(
        "abcd",
        [
          { oldText: "abc", newText: "" },
          { oldText: "cd", newText: "" },
        ],
        "/f",
      ),
    ).toEqual(Result.fail("Edits overlap in /f; merge them into one."));
  });
});

const code = (env: Record<string, unknown>) => ({
  compatibilityDate: "2026-06-17",
  compatibilityFlags: ["nodejs_compat"],
  mainModule: "shell.js",
  modules: { "shell.js": "export default {}" },
  env,
});

/** A loader that records the code it was given. */
const recording = () => {
  const loaded: Array<WorkerLoaderWorkerCode> = [];

  const loader = {
    get: (_name: string | null, getCode: () => Promise<WorkerLoaderWorkerCode>) => {
      void getCode().then((given) => loaded.push(given));

      return { getEntrypoint: () => ({}) };
    },
  } as unknown as WorkerLoader;

  return { loader, loaded };
};

describe("the shell's loader", () => {
  const gateway = { fetch: () => Promise.resolve(new Response()) } as unknown as Fetcher;

  it("gives the Dynamic Worker the egress entrypoint as its outbound, whatever the backend asked", async () => {
    const { loader, loaded } = recording();

    for (const outbound of [undefined, null, "direct"])
      guardedLoader(loader, gateway).get("shell", () => ({
        ...code({ HOST: {} }),
        ...(outbound === undefined ? {} : { globalOutbound: outbound }),
      }));

    await Promise.resolve();
    await Promise.resolve();

    expect(loaded).toHaveLength(3);

    for (const given of loaded) {
      expect(given.globalOutbound).toBe(gateway);
      expect(Object.keys(given.env)).toEqual(["HOST"]);
    }
  });

  it("refuses any binding beyond the Workspace's proxy", async () => {
    const attempts: Array<Promise<WorkerLoaderWorkerCode>> = [];

    const loader = {
      get: (_name: string | null, getCode: () => Promise<WorkerLoaderWorkerCode>) => {
        attempts.push(getCode());

        return { getEntrypoint: () => ({}) };
      },
    } as unknown as WorkerLoader;

    guardedLoader(loader, gateway).get("shell", () => code({ HOST: {}, SECRET: "token" }));

    await expect(attempts[0]).rejects.toThrow(
      "a sandbox gets no bindings beyond its files, not SECRET",
    );
  });
});

describe("a session's file failure", () => {
  const full = new Error("database or disk is full: SQLITE_FULL");

  it("names the storage limit, and says a write was not written", () => {
    expect(fileFailure(full, "/workspace/a", "write").message).toBe(
      "The sandbox's storage is full (its Durable Object's storage limit): /workspace/a was not written. Delete files to make room.",
    );
    expect(fileFailure(full, "/workspace/a", "read").message).toBe(
      "The sandbox's storage is full (its Durable Object's storage limit). Delete files to make room.",
    );
  });

  it("names what else went wrong with the path, and passes any other message on", () => {
    const coded = (code: string) => Object.assign(new Error("x"), { code });

    expect(fileFailure(coded("ENOENT"), "/a", "read").message).toBe(
      "No such file or directory: /a",
    );
    expect(fileFailure(coded("EISDIR"), "/a", "read").message).toBe("/a is a directory");
    expect(fileFailure(coded("ENOTDIR"), "/a/b", "list").message).toBe("Not a directory: /a/b");
    // Words of a limit that is not the storage's are not taken for it.
    expect(fileFailure(new Error("quota exceeded"), "/a", "write").message).toBe(
      "/a: quota exceeded",
    );
  });
});
