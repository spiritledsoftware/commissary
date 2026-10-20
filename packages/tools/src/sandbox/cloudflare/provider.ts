/**
 * Cloudflare's sandbox provider (ADR 0041, #222): the adapter behind the sandbox-provider interface over the state
 * Worker's `SandboxSession` namespace. Each session is one object, named `<org>:<session id>`, so an id names nothing in
 * another org; the object checks the caller's org and principal on every call (`session.ts`). Nothing outside this
 * folder imports `@cloudflare/computer` or just-bash.
 */
import { Effect } from "effect";
import {
  type CommandResult,
  type DirectoryEntry,
  SandboxError,
  type SandboxOwner,
  type SandboxProvider,
} from "../provider.ts";
import type { SandboxSession, SessionCaller, SessionReply } from "./session.ts";

/** The sandbox toolkit's source with Cloudflare's sandbox behind it. */
export const CLOUDFLARE_SANDBOX = "cloudflare";

/** A new session's id: `sbx_` and 32 random hex digits. */
const newSessionId = (): string => `sbx_${crypto.randomUUID().replaceAll("-", "")}`;

/** What an id that was never a session's looks like; any other is unknown without asking. */
const SESSION_ID = /^sbx_[0-9a-f]{32}$/;

/** The answer of one object call, as the interface answers it. */
const replied = <A>(call: () => Promise<SessionReply<A>>): Effect.Effect<A, SandboxError> =>
  Effect.tryPromise({
    try: call,
    catch: (cause) =>
      new SandboxError({
        reason: "unavailable",
        message: `Commissary could not reach the sandbox: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  }).pipe(
    Effect.flatMap((reply) =>
      reply.ok
        ? Effect.succeed(reply.value)
        : Effect.fail(new SandboxError({ reason: reply.reason, message: reply.message })),
    ),
  );

/** The caller as the session's object takes it. */
const caller = (owner: SandboxOwner, now: number): SessionCaller => ({
  org: owner.org,
  owner: owner.principal,
  now,
});

/** Cloudflare's sandbox over `namespace`, the state Worker's `SANDBOX_SESSION`. */
export const cloudflareSandbox = (
  namespace: DurableObjectNamespace<SandboxSession>,
): SandboxProvider => {
  /** The session `id`'s object in `owner`'s org, or `unknown_session` for an id no session could have. */
  const object = <A>(
    owner: SandboxOwner,
    id: string,
    call: (stub: DurableObjectStub<SandboxSession>) => Promise<SessionReply<A>>,
  ): Effect.Effect<A, SandboxError> =>
    SESSION_ID.test(id)
      ? replied(() => call(namespace.getByName(`${owner.org}:${id}`)))
      : Effect.fail(new SandboxError({ reason: "unknown_session", message: "" }));

  return {
    id: CLOUDFLARE_SANDBOX,
    open: (owner, { network, policy, now }) => {
      const id = newSessionId();

      return object(owner, id, (stub) => stub.open(caller(owner, now), network, policy)).pipe(
        Effect.as(id),
      );
    },
    run: (owner, id, { command, timeoutMs, now }) =>
      object<CommandResult>(owner, id, (stub) => stub.run(caller(owner, now), command, timeoutMs)),
    readFile: (owner, id, path, now) =>
      object(owner, id, (stub) => stub.readFile(caller(owner, now), path)),
    writeFile: (owner, id, path, text, now) =>
      object(owner, id, (stub) => stub.writeFile(caller(owner, now), path, text)).pipe(
        Effect.asVoid,
      ),
    list: (owner, id, path, now) =>
      object<ReadonlyArray<DirectoryEntry>>(owner, id, (stub) =>
        stub.list(caller(owner, now), path),
      ),
    close: (owner, id, now) =>
      object(owner, id, (stub) => stub.close(caller(owner, now))).pipe(Effect.asVoid),
    purge: (org, id) =>
      SESSION_ID.test(id)
        ? replied(() => namespace.getByName(`${org}:${id}`).purge(org)).pipe(Effect.asVoid)
        : Effect.void,
  };
};
