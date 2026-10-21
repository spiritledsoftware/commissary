// A fake second sandbox provider (#222, ADR 0041): sessions in memory, keyed by org and id and owned by a principal as
// any provider's are, with files in a map. Its shell knows `cat <file>` only, and names itself on stderr, so a test tells
// which provider served a call. It shows that the sandbox toolkit's tools are the same whatever provider is behind them.
import { Effect } from "effect";
import {
  type Metered,
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

/** A file (`unreachable`, written by a test) that makes the fake provider fail to answer for its session: `status` and `purge`. */
const UNREACHABLE_FILE = "/workspace/unreachable";

/** A file (`vanished`) that makes the fake provider say it knows no such session (`status`), as one lost on its side. */
const VANISHED_FILE = "/workspace/vanished";

/** An answer with no computer time: the fake provider has no computer to meter (#224). */
const unmetered = <A, E>(answer: Effect.Effect<A, E>): Effect.Effect<Metered<A>, E> =>
  Effect.map(answer, (value) => ({ value }));

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
      unmetered(
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
      ),
    readFile: (owner, id, path) =>
      unmetered(
        Effect.flatMap(session(owner, id), ({ files }) => {
          const text = files.get(path);

          return text === undefined ? Effect.fail(missing(path)) : Effect.succeed(text);
        }),
      ),
    stat: (owner, id, path) =>
      unmetered(
        Effect.map(session(owner, id), ({ files }) => {
          const text = files.get(path);

          return text === undefined
            ? null
            : {
                kind: "file" as const,
                size: new TextEncoder().encode(text).byteLength,
                mtimeMs: 0,
              };
        }),
      ),
    readBytes: (owner, id, path, { offset, length }) =>
      unmetered(
        Effect.flatMap(session(owner, id), ({ files }) => {
          const text = files.get(path);

          return text === undefined
            ? Effect.fail(missing(path))
            : Effect.succeed(new TextEncoder().encode(text).slice(offset, offset + length));
        }),
      ),
    writeFile: (owner, id, path, text) =>
      unmetered(
        Effect.map(session(owner, id), ({ files }) => {
          files.set(path, text);
        }),
      ),
    list: (owner, id, path) =>
      unmetered(
        Effect.map(session(owner, id), ({ files }) =>
          [...files.keys()].flatMap((file) =>
            file.startsWith(`${path}/`)
              ? [{ name: file.slice(path.length + 1), directory: false }]
              : [],
          ),
        ),
      ),
    close: (owner, id) =>
      unmetered(
        Effect.map(session(owner, id), (found) => {
          found.closed = true;
          found.files.clear();
        }),
      ),
    // It has no computer: there is none to stop, and no computer time to meter (#224).
    stopComputer: (owner, id) => unmetered(Effect.as(session(owner, id), false)),
    status: (org, id) => {
      const found = sessions.get(`${org}:${id}`);

      if (found === undefined)
        return Effect.fail(new SandboxError({ reason: "unknown_session", message: "" }));

      if (found.files.has(UNREACHABLE_FILE))
        return Effect.fail(new SandboxError({ reason: "unavailable", message: "" }));

      if (found.files.has(VANISHED_FILE))
        return Effect.fail(new SandboxError({ reason: "unknown_session", message: "" }));

      return found.closed
        ? Effect.fail(new SandboxError({ reason: "closed", message: "" }))
        : Effect.succeed({ network: { kind: "none" }, computer: "off" });
    },
    purge: (org, id) =>
      unmetered(
        Effect.suspend(() => {
          if (sessions.get(`${org}:${id}`)?.files.has(UNREACHABLE_FILE) === true)
            return Effect.fail(new SandboxError({ reason: "unavailable", message: "" }));

          sessions.delete(`${org}:${id}`);

          return Effect.void;
        }),
      ),
  };
};
