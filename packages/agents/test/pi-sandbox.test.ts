// A run's coding tools (#230) tell the model what the session's operations noted (#224): a call that stopped the
// session's running computer, as a Spend limit its time counts toward has no room, goes on, with a warning on its
// answer. The first call opens the run's session with exactly its definition's sandbox settings, and tells the model
// why the run left its previous session, if it did.
import { describe, expect, it } from "vitest";
import type { Context } from "@earendil-works/chord";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { AgentSandbox } from "@commissary/contract/agents";
import type { RunToolReport, SandboxEnvRequest } from "@commissary/contract/sandbox-env";
import type { JsonObject } from "@earendil-works/pi-ai";
import { type RunSandboxPort, sandboxTools } from "../src/runs/pi-sandbox.ts";
import { SandboxExecutionEnv } from "../src/runs/sandbox-env.ts";

const STOPPED = "The sandbox session's computer was stopped.";

/**
 * A run's sandbox whose every gate passes and whose writes answer `note`, with the session `known` (none: the first
 * call opens one) and the notice `notice`; what it settled, and what each opening asked for.
 */
const port = (
  note: string | undefined,
  { known, notice }: { readonly known?: string; readonly notice?: string } = { known: "sbx_1" },
) => {
  const settled: Array<RunToolReport> = [];
  const operations: Array<SandboxEnvRequest> = [];
  const opens: Array<JsonObject> = [];
  let session = known;
  let pending = notice;

  const sandbox: RunSandboxPort = {
    open: async (_name, args) => {
      opens.push(args);

      return { output: [], isError: false, session: "sbx_2" };
    },
    gate: async () => ({ ticket: "rtc_1" }),
    operate: async (_ticket, request) => {
      operations.push(request);

      return { ok: true, value: null, note };
    },
    settle: async (_ticket, report) => {
      settled.push(report);

      return { recorded: true };
    },
    session: () => session,
    opened: (opened) => {
      session = opened;
    },
    notice: () => {
      const taken = pending;

      pending = undefined;

      return taken;
    },
  };

  return { sandbox, settled, operations, opens };
};

/** pi's `write` tool over `sandbox`, as a run whose definition names `definition` offers it. */
const writeTool = (sandbox: RunSandboxPort, definition: AgentSandbox = { toolkit: "sandbox" }) => {
  const listed = new Map([
    ["sandbox_open", undefined],
    ["sandbox_write", "Writes a file."],
  ]);

  const tool = sandboxTools(definition, listed, sandbox).find(
    (registered) => registered.name === "write",
  );

  if (tool === undefined) throw new Error("no write tool");

  return tool;
};

// SAFETY: pi's write tool reads only `env` of the API, which the run's tool sets itself.
const api = {} as ToolExecutionApi;

// SAFETY: pi's write tool reads only the abort signal of the context.
const context = {} as Context;

describe("a run's coding tool", () => {
  it("warns the model when its call stopped the session's computer, and settles its call once", async () => {
    const { sandbox, settled, operations } = port(STOPPED);
    const done = await writeTool(sandbox).execute({ path: "a.txt", content: "a" }, api, context);

    expect(operations).toEqual([{ op: "write", path: "/workspace/a.txt", content: "a" }]);
    expect(done.diagnostics).toEqual([
      { severity: "warn", code: "sandbox_computer", message: STOPPED },
    ]);
    expect(settled).toMatchObject([{ outcome: "success" }]);
  });

  it("adds nothing when no operation noted anything", async () => {
    const { sandbox } = port(undefined);
    const done = await writeTool(sandbox).execute({ path: "a.txt", content: "a" }, api, context);

    expect(done.diagnostics).toBeUndefined();
  });

  it("opens the run's session with exactly its definition's sandbox settings, on the first call only", async () => {
    const { sandbox, opens, operations } = port(undefined, {});

    const tool = writeTool(sandbox, {
      toolkit: "sandbox",
      network: { kind: "hosts", hosts: ["example.com"] },
      computer: true,
    });

    await tool.execute({ path: "a.txt", content: "a" }, api, context);
    await tool.execute({ path: "b.txt", content: "b" }, api, context);

    expect(opens).toEqual([{ network: { kind: "hosts", hosts: ["example.com"] }, computer: true }]);
    expect(operations).toHaveLength(2);
  });

  it("asks for no computer, nor network, when the definition names none", async () => {
    const { sandbox, opens } = port(undefined, {});

    await writeTool(sandbox).execute({ path: "a.txt", content: "a" }, api, context);

    expect(opens).toEqual([{}]);
  });

  it("tells the model, once, why the run left its previous session", async () => {
    const LEFT = "The agent's sandbox settings narrowed.";
    const { sandbox } = port(undefined, { notice: LEFT });
    const tool = writeTool(sandbox);
    const first = await tool.execute({ path: "a.txt", content: "a" }, api, context);
    const second = await tool.execute({ path: "b.txt", content: "b" }, api, context);

    expect(first.diagnostics).toEqual([
      { severity: "warn", code: "sandbox_session", message: LEFT },
    ]);
    expect(second.diagnostics).toBeUndefined();
  });
});

describe("a run's sandbox environment", () => {
  it("writes bytes as UTF-8 text, and refuses bytes that are not UTF-8 without writing them", async () => {
    const { sandbox, operations } = port(undefined);

    const env = new SandboxExecutionEnv(
      "sbx_1",
      // SAFETY: the fake answers a write with `null`, the value of a write.
      async (request) => (await sandbox.operate("rtc_1", request)) as never,
    );

    expect(
      (await env.writeFile("/workspace/a.txt", new TextEncoder().encode("é"), context)).ok,
    ).toBe(true);

    const refused = await env.writeFile("/workspace/b.bin", new Uint8Array([0xff, 0xfe]), context);

    expect(refused.ok ? undefined : refused.error.code).toBe("not_supported");
    expect(operations).toEqual([{ op: "write", path: "/workspace/a.txt", content: "é" }]);
  });
});
