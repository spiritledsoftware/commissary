/**
 * One operation of an agent run's gated sandbox call (#230) on the sandbox provider: the operations pi's coding tools
 * make (`@commissary/contract/sandbox-env`), each on the provider's interface, so any provider serves them. A command
 * runs as `sandbox_bash` runs it (the fallback rule, the computer, the output cut to its tail and saved whole), with
 * the provider's note after its error output; a file's bytes and what a path is are the provider's. Each operation
 * passes the call's computer metering (#224, `meter`), as each of the sandbox toolkit's calls does, and answers the
 * session's computer time with its value.
 */
import { Effect } from "effect";
import {
  SANDBOX_MAX_TIMEOUT_MS,
  type SandboxEnvRequest,
  type SandboxEnvValues,
} from "@commissary/contract/sandbox-env";
import type {
  ComputerMeter,
  Metered,
  SandboxError,
  SandboxOwner,
  SandboxProvider,
} from "./provider.ts";

/** `request` on `session` of `owner`'s at `now`, metered with `meter`, as `provider` answers it. */
export const sandboxOperation = (
  provider: SandboxProvider,
  owner: SandboxOwner,
  session: string,
  request: SandboxEnvRequest,
  now: number,
  meter: ComputerMeter,
): Effect.Effect<Metered<SandboxEnvValues[SandboxEnvRequest["op"]]>, SandboxError> => {
  switch (request.op) {
    case "exec":
      return provider
        .run(
          owner,
          session,
          {
            command: request.command,
            timeoutMs: Math.min(Math.max(1, request.timeoutMs), SANDBOX_MAX_TIMEOUT_MS),
            now,
          },
          meter,
        )
        .pipe(
          Effect.map(({ value: result, ...metered }) => {
            const savedAt = result.stdout.cut?.savedAt ?? result.stderr.cut?.savedAt;
            const stderr = [result.stderr.text, result.note ?? ""].filter((part) => part !== "");

            return {
              ...metered,
              value: {
                exitCode: result.exitCode,
                stdout: result.stdout.text,
                stderr: stderr.join(result.stderr.text.endsWith("\n") ? "" : "\n"),
                ...(savedAt === undefined ? {} : { savedAt }),
              },
            };
          }),
        );
    case "stat":
      return provider.stat(owner, session, request.path, now, meter);
    case "read":
      return provider.readBytes(
        owner,
        session,
        request.path,
        { offset: request.offset, length: request.length },
        now,
        meter,
      );
    case "readText":
      return provider.readFile(owner, session, request.path, now, meter);
    case "write":
      return provider
        .writeFile(owner, session, request.path, request.content, now, meter)
        .pipe(Effect.map((metered) => ({ ...metered, value: null })));
  }
};
