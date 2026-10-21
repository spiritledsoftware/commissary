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
  type FileStat,
  type Metered,
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

/**
 * The answer of one object call, as the interface answers it, with the computer time it answers (#224): a failure
 * carries it too, and a refusal for want of room whether the session stopped its computer. An object from before #224
 * answers none.
 */
const replied = <A>(
  call: () => Promise<SessionReply<A>>,
): Effect.Effect<Metered<A>, SandboxError> =>
  Effect.tryPromise({
    try: call,
    catch: (cause) =>
      new SandboxError({
        reason: "unavailable",
        message: `Commissary could not reach the sandbox: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  }).pipe(
    Effect.flatMap((reply) => {
      const { computerTime, computerStopped } = reply;

      const metered = {
        ...(computerTime === undefined ? {} : { computerTime }),
        ...(computerStopped === true ? { computerStopped } : {}),
      };

      return reply.ok
        ? Effect.succeed({ value: reply.value, ...metered })
        : Effect.fail(
            new SandboxError({ reason: reply.reason, message: reply.message, ...metered }),
          );
    }),
  );

/** The caller as the session's object takes it. */
const caller = (owner: SandboxOwner, now: number): SessionCaller => ({
  org: owner.org,
  owner: owner.principal,
  now,
});

/**
 * Cloudflare's sandbox over `namespace`, the state Worker's `SANDBOX_SESSION`; `computer`: whether the deployment
 * attached the computer's container to its class (#223, ADR 0043).
 */
export const cloudflareSandbox = (
  namespace: DurableObjectNamespace<SandboxSession>,
  { computer }: { readonly computer: boolean },
): SandboxProvider => {
  /** The session `id`'s object in `owner`'s org, or `unknown_session` for an id no session could have. */
  const object = <A>(
    owner: SandboxOwner,
    id: string,
    call: (stub: DurableObjectStub<SandboxSession>) => Promise<SessionReply<A>>,
  ): Effect.Effect<Metered<A>, SandboxError> =>
    SESSION_ID.test(id)
      ? replied(() => call(namespace.getByName(`${owner.org}:${id}`)))
      : Effect.fail(new SandboxError({ reason: "unknown_session", message: "" }));

  return {
    id: CLOUDFLARE_SANDBOX,
    computer,
    open: (owner, { network, computer: asked, policy, now, meter, opener, untilPurged }) => {
      const id = newSessionId();

      return object(owner, id, (stub) =>
        stub.open(
          caller(owner, now),
          { network, computer: asked && computer },
          policy,
          meter,
          opener,
          untilPurged,
        ),
      ).pipe(Effect.as(id));
    },
    run: (owner, id, { command, timeoutMs, now }, meter) =>
      object<CommandResult>(owner, id, (stub) =>
        stub.run(caller(owner, now), command, timeoutMs, meter),
      ),
    readFile: (owner, id, path, now, meter) =>
      object(owner, id, (stub) => stub.readFile(caller(owner, now), path, meter)),
    stat: (owner, id, path, now, meter) =>
      object<FileStat | null>(owner, id, (stub) => stub.stat(caller(owner, now), path, meter)),
    readBytes: (owner, id, path, { offset, length }, now, meter) =>
      object<Uint8Array>(owner, id, (stub) =>
        stub.readBytes(caller(owner, now), path, offset, length, meter),
      ),
    writeFile: (owner, id, path, text, now, meter) =>
      object(owner, id, (stub) => stub.writeFile(caller(owner, now), path, text, meter)).pipe(
        Effect.map((metered) => ({ ...metered, value: undefined })),
      ),
    list: (owner, id, path, now, meter) =>
      object<ReadonlyArray<DirectoryEntry>>(owner, id, (stub) =>
        stub.list(caller(owner, now), path, meter),
      ),
    close: (owner, id, now, meter) =>
      object(owner, id, (stub) => stub.close(caller(owner, now), meter)).pipe(
        Effect.map((metered) => ({ ...metered, value: undefined })),
      ),
    stopComputer: (owner, id, now, meter) =>
      object<boolean>(owner, id, (stub) => stub.stopForLimit(caller(owner, now), meter)),
    purge: (org, id, settle) =>
      SESSION_ID.test(id)
        ? replied(() => namespace.getByName(`${org}:${id}`).purge(org, settle)).pipe(
            Effect.map((metered) => ({ ...metered, value: undefined })),
          )
        : Effect.succeed({ value: undefined }),
  };
};
