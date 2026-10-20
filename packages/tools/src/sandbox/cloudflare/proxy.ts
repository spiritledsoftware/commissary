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
import type { SandboxSession } from "./session.ts";

/** What the backend binds the proxy with: the session object's namespace binding and its id. */
interface ProxyProps {
  readonly binding: string;
  readonly id: string;
}

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

export class WorkspaceServiceProxy extends WorkerEntrypoint<
  Record<string, DurableObjectNamespace<SandboxSession> | undefined>,
  ProxyProps
> {
  /** The session's Workspace, from the session object (`SandboxSession.__getWorkspaceStub`). */
  async getWorkspace() {
    const { binding, id } = this.ctx.props;
    const namespace = this.env[binding];

    if (namespace === undefined) throw new Error(`the Worker binds no ${binding}`);

    return await namespace.get(namespace.idFromString(id)).__getWorkspaceStub();
  }

  getArtifacts(): NoArtifacts {
    return new NoArtifacts();
  }

  artifactsCLI(): ReturnType<NoArtifacts["cli"]> {
    return new NoArtifacts().cli();
  }
}
