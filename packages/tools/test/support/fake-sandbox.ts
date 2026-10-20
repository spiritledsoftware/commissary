// A fake second sandbox provider (#222, ADR 0041): sessions in memory, keyed by org and id and owned by a principal as
// any provider's are, with files in a map. Its shell knows `cat <file>` only, and names itself on stderr, so a test tells
// which provider served a call. It shows that the sandbox toolkit's tools are the same whatever provider is behind them.
import { Effect } from "effect";
import {
  SandboxError,
  type SandboxOwner,
  type SandboxProvider,
} from "../../src/sandbox/provider.ts";

interface FakeSession {
  readonly owner: string;
  readonly files: Map<string, string>;
  closed: boolean;
}

/** The fake provider's source. */
export const FAKE_SANDBOX = "fake-sandbox";

const missing = (path: string) =>
  new SandboxError({ reason: "file", message: `No such file or directory: ${path}` });

export const fakeSandboxProvider = (): SandboxProvider => {
  const sessions = new Map<string, FakeSession>();
  let next = 0;

  const session = (owner: SandboxOwner, id: string): Effect.Effect<FakeSession, SandboxError> => {
    const found = sessions.get(`${owner.org}:${id}`);

    if (found === undefined || found.owner !== owner.principal)
      return Effect.fail(new SandboxError({ reason: "unknown_session", message: "" }));

    return found.closed
      ? Effect.fail(new SandboxError({ reason: "closed", message: "" }))
      : Effect.succeed(found);
  };

  return {
    id: FAKE_SANDBOX,
    // It runs every command on its own machine: it has no computer to fall back to (#223).
    computer: false,
    open: (owner) =>
      Effect.sync(() => {
        next += 1;
        const id = `fake_${next}`;

        sessions.set(`${owner.org}:${id}`, {
          owner: owner.principal,
          files: new Map(),
          closed: false,
        });

        return id;
      }),
    run: (owner, id, { command }) =>
      Effect.map(session(owner, id), ({ files }) => {
        const [verb, path] = command.split(" ");
        const file = path === undefined ? undefined : files.get(`/workspace/${path}`);

        return verb === "cat" && file !== undefined
          ? { exitCode: 0, stdout: { text: file }, stderr: { text: FAKE_SANDBOX } }
          : {
              exitCode: 127,
              stdout: { text: "" },
              stderr: { text: `${FAKE_SANDBOX}: ${command}` },
            };
      }),
    readFile: (owner, id, path) =>
      Effect.flatMap(session(owner, id), ({ files }) => {
        const text = files.get(path);

        return text === undefined ? Effect.fail(missing(path)) : Effect.succeed(text);
      }),
    writeFile: (owner, id, path, text) =>
      Effect.map(session(owner, id), ({ files }) => {
        files.set(path, text);
      }),
    list: (owner, id, path) =>
      Effect.map(session(owner, id), ({ files }) =>
        [...files.keys()].flatMap((file) =>
          file.startsWith(`${path}/`)
            ? [{ name: file.slice(path.length + 1), directory: false }]
            : [],
        ),
      ),
    close: (owner, id) =>
      Effect.map(session(owner, id), (found) => {
        found.closed = true;
        found.files.clear();
      }),
    purge: (org, id) =>
      Effect.sync(() => {
        sessions.delete(`${org}:${id}`);
      }),
  };
};
