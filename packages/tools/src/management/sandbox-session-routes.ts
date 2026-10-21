/**
 * `/v9/management/sandbox-sessions` (`SandboxSessionsGroup` in `@commissary/contract/sandbox-sessions`): the sandbox
 * toolkit's open sessions on its page in the panel (#225, ADR 0041). Every member may call them (`access-rules.ts`); the
 * Tools part decides from the viewer: a member's own sessions, which they may end, and for an org admin every session of
 * the org, which they may end too. Nothing of a session's files is read or answered.
 */
import { Effect } from "effect";
import { currentViewer } from "@commissary/auth";
import { jsonReply, type Reply } from "@commissary/core";
import { HttpRouter } from "effect/http";
import type { ToolsResult } from "../control-plane-part.ts";
import { toolsControlPlane } from "../env.ts";

/** The session's id in the path. */
const idParam = Effect.map(HttpRouter.params, ({ id }) => id ?? "");

/** The sandbox sessions' handlers, which `routes.ts` mounts; `orRefuse` answers a refusal as the other Tools routes do. */
export const sandboxSessionHandlers = (
  orRefuse: <A>(result: ToolsResult<A>) => Effect.Effect<A, Reply>,
) => {
  const list = Effect.gen(function* () {
    const viewer = yield* currentViewer;

    return jsonReply(
      200,
      yield* toolsControlPlane("listSandboxSessions", (stub) =>
        stub.tools().listSandboxSessions(viewer),
      ),
    );
  });

  const end = Effect.gen(function* () {
    const viewer = yield* currentViewer;
    const id = yield* idParam;

    const result = yield* toolsControlPlane("endSandboxSession", (stub) =>
      stub.tools().endSandboxSession(viewer, id),
    );

    return jsonReply(200, yield* orRefuse(result));
  });

  return { list, end };
};
