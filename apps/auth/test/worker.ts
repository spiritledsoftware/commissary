// The test Worker's entry (vitest.config.ts): the auth Worker and the state Worker's Durable Objects in one isolate
// (#135, ADR 0030). Deployed, the auth Worker binds the state Worker's namespaces by script name; here they are the test
// Worker's own, so global `fetch` stubs reach them, with no auxiliary Worker.
export { AuthWorker, default } from "../src/index.ts";

export {
  ControlPlane,
  Platform,
  SandboxEgress,
  SandboxSession,
  SessionState,
  WorkspaceServiceProxy,
} from "@commissary/state-worker";
