/**
 * The Workspace's proxy (#222): the entrypoint a session's Dynamic Worker reaches its files through, its one binding
 * (`HOST`). `@cloudflare/computer`'s worker-shell backend binds `ctx.exports.WorkspaceServiceProxy` with the session
 * object's namespace and id as props, so the Worker that defines `SandboxSession` exports this class under that name.
 *
 * It does what `@cloudflare/computer`'s own `WorkspaceServiceProxy` does for the shell (`getWorkspace`), without
 * importing the package: the state Worker's main module exports it, and every ControlPlane's cold start would evaluate
 * the package with it (`session.ts` loads it only when a session runs). Artifacts are not offered: a sandbox has none
 * (they would fetch from the host, not through the sandbox's egress point).
 */
import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { SANDBOX_SESSION_BINDING, type SandboxSession } from "./session.ts";

/** What the backend binds the proxy with: the session object's namespace binding and its id. */
interface ProxyProps {
  readonly binding: string;
  readonly id: string;
}

/** What the proxies read of the Worker's env: the session objects' namespace. */
interface ProxyEnv {
  readonly SANDBOX_SESSION: DurableObjectNamespace<SandboxSession>;
}

/** The session object the props name, or undefined when they name another binding than the sessions'. */
const sessionOf = (env: ProxyEnv, { binding, id }: ProxyProps) =>
  binding === SANDBOX_SESSION_BINDING
    ? env.SANDBOX_SESSION.get(env.SANDBOX_SESSION.idFromString(id))
    : undefined;

/** The answer to an Artifacts CLI call: a sandbox has no Artifacts. */
class NoArtifacts extends RpcTarget {
  cli() {
    return {
      stdout: "",
      stderr: "artifacts: not available in a Commissary sandbox\n",
      exitCode: 1,
    };
  }
}

export class WorkspaceServiceProxy extends WorkerEntrypoint<ProxyEnv, ProxyProps> {
  /** The session's Workspace, from the session object (`SandboxSession.__getWorkspaceStub`). */
  async getWorkspace() {
    const session = sessionOf(this.env, this.ctx.props);

    if (session === undefined)
      throw new Error(`no sandbox session behind ${this.ctx.props.binding}`);

    return await session.__getWorkspaceStub();
  }

  getArtifacts(): NoArtifacts {
    return new NoArtifacts();
  }

  artifactsCLI(): ReturnType<NoArtifacts["cli"]> {
    return new NoArtifacts().cli();
  }
}

/** What the computer's outbound intercept binds the container proxy with (`@cloudflare/computer`'s container host). */
interface ContainerProxyProps extends ProxyProps {
  /** Present for the intercept of all of the computer's traffic: the token the computer's backend checks. */
  readonly egressToken?: string;
}

/**
 * The headers `@cloudflare/computer`'s container backend reads an intercepted request's token and URL from (the package
 * does not export their names).
 */
const EGRESS_TOKEN_HEADER = "x-workspace-egress-token";

const EGRESS_URL_HEADER = "x-workspace-egress-url";

/**
 * The computer's way back to its session (#223): the entrypoint its container's outbound HTTP and HTTPS are intercepted
 * to (`@cloudflare/computer`'s container host binds `ctx.exports.WorkspaceProxy`, so the Worker that defines
 * `SandboxSession` exports this class under that name). It does what the package's own `WorkspaceProxy` does, without
 * importing the package: computerd's dial-back (`/health`, `/api`) and every other request of the computer go to the
 * session object, whose computer backend hands the latter to the sandbox's egress point (`SandboxEgress`), and nowhere
 * else.
 */
export class WorkspaceProxy extends WorkerEntrypoint<ProxyEnv, ContainerProxyProps> {
  override async fetch(request: Request): Promise<Response> {
    const { egressToken } = this.ctx.props;
    const session = sessionOf(this.env, this.ctx.props);

    if (session === undefined)
      return new Response(`no sandbox session behind ${this.ctx.props.binding}`, { status: 500 });
    const url = new URL(request.url);

    if (egressToken !== undefined) {
      // An outbound request of the computer: to its session's backend, which checks the token and sends it on to the
      // egress point.
      const headers = new Headers(request.headers);

      headers.set(EGRESS_TOKEN_HEADER, egressToken);
      headers.set(EGRESS_URL_HEADER, request.url);
      url.pathname = "/api";
      url.search = "";

      return await session.fetch(new Request(url, new Request(request, { headers })));
    }

    const callback = /^\/__workspace_connect\/([0-9a-f-]{36})\/(health|api)$/.exec(url.pathname);

    if (url.pathname === "/health" || callback?.[2] === "health")
      return new Response("ok\n", { headers: { "content-type": "text/plain; charset=utf-8" } });

    if (url.pathname === "/api" || callback?.[2] === "api") {
      if (callback?.[1] !== undefined) {
        url.pathname = "/api";
        url.searchParams.set("token", callback[1]);
      }

      return await session.fetch(new Request(url, request));
    }

    return new Response("not found", { status: 404 });
  }
}
