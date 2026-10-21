/**
 * `/v9/management/browser-sessions` (`BrowserSessionsGroup` in `@commissary/contract/browser-sessions`): the panel's
 * Browser sessions page (#216, ADR 0039, ADR 0044). Every member may call them (`access-rules.ts`); the Tools part decides
 * from the viewer: a member's own sessions, which they watch and end, and for an org admin every session of the org,
 * which they may end but not watch. A Live View link answers `Cache-Control: no-store`: it is a bearer link to the
 * session's browser, for this page only, and nothing logs it.
 */
import { Effect } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { currentViewer } from "@commissary/auth";
import { jsonReply, type Reply } from "@commissary/core";
import type { ToolsResult } from "../control-plane-part.ts";
import { toolsControlPlane } from "../env.ts";

/** The session's id in the path. */
const idParam = Effect.map(HttpRouter.params, ({ id }) => id ?? "");

/** The Browser sessions page's handlers, which `routes.ts` mounts; `orRefuse` answers a refusal as the other Tools routes do. */
export const browserSessionHandlers = (
  orRefuse: <A>(result: ToolsResult<A>) => Effect.Effect<A, Reply>,
) => {
  const list = Effect.gen(function* () {
    const viewer = yield* currentViewer;

    return jsonReply(
      200,
      yield* toolsControlPlane("listBrowserSessions", (stub) =>
        stub.tools().listBrowserSessions(viewer),
      ),
    );
  });

  const get = Effect.gen(function* () {
    const viewer = yield* currentViewer;
    const id = yield* idParam;

    const result = yield* toolsControlPlane("browserSession", (stub) =>
      stub.tools().browserSession(viewer, id),
    );

    return jsonReply(200, yield* orRefuse(result));
  });

  const liveView = Effect.gen(function* () {
    const viewer = yield* currentViewer;
    const id = yield* idParam;

    const result = yield* toolsControlPlane("browserLiveView", (stub) =>
      stub.tools().browserLiveView(viewer, id),
    );

    // A bearer link to the session's browser: no cache keeps it.
    return HttpServerResponse.setHeader(
      jsonReply(200, yield* orRefuse(result)),
      "cache-control",
      "no-store",
    );
  });

  const end = Effect.gen(function* () {
    const viewer = yield* currentViewer;
    const id = yield* idParam;

    const result = yield* toolsControlPlane("endBrowserSession", (stub) =>
      stub.tools().endBrowserSession(viewer, id),
    );

    return jsonReply(200, yield* orRefuse(result));
  });

  return { list, get, liveView, end };
};
