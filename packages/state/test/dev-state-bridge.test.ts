// The dev-only state bridge (`alchemy dev`, cloudflare/workerd#7286): the app, API and auth Workers' dev entries record
// the call chains their callers write on bridged stubs and the state Worker's dev entrypoint replays them on its own
// stubs. Checked
// here on the test Worker's real ControlPlane, with a bridge that replays in the same isolate and records each chain
// it is sent.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { OrgId } from "@commissary/core";
import {
  type DevChainStep,
  devBridgedEnv,
  devBridgedNamespace,
  type DevStateBinding,
  type DevStateBridgeRpc,
  replayDevChain,
} from "../src/dev-state-bridge.ts";
import type { StateBindings } from "../src/env.ts";

const freshOrg = () => OrgId.make(`bridge-${crypto.randomUUID().slice(0, 8)}`);

/** A bridge that replays on the test Worker's namespaces, as the state Worker's `DevStateBridge` does, and records. */
const recordingBridge = () => {
  const sent: Array<{
    binding: DevStateBinding;
    name: string;
    chain: ReadonlyArray<DevChainStep>;
  }> = [];

  const bridge: DevStateBridgeRpc = {
    call: async (binding, name, chain) => {
      sent.push({ binding, name, chain });

      return await replayDevChain(env[binding], name, chain);
    },
  };

  return { bridge, sent };
};

/** The test Worker's ControlPlane namespace over `bridge`. */
const bridgedControlPlane = (bridge: DevStateBridgeRpc) =>
  devBridgedNamespace<typeof env.CONTROL_PLANE extends DurableObjectNamespace<infer T> ? T : never>(
    bridge,
    "CONTROL_PLANE",
  );

/** `call` settled as a promise: Vitest's `rejects` would call the callable RPC promise it is given. */
const settled = async <T>(call: PromiseLike<T>): Promise<T> => await call;

/** The end of the current turn, when bridged calls nobody chained onto are sent. */
const endOfTurn = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("replayDevChain", () => {
  it("replays member reads and calls on the stub of the name, the member's owner as receiver", async () => {
    const org = freshOrg();

    const chain: DevChainStep[] = [
      { kind: "member", key: "dummy" },
      { kind: "call", args: [] },
      { kind: "member", key: "add" },
      // SAFETY: the argument is only recorded and replayed; the dummy part's method takes a string.
      { kind: "call", args: ["a" as never] },
    ];

    expect(await replayDevChain(env.CONTROL_PLANE, org, chain)).toBe(1);
    expect(await env.CONTROL_PLANE.getByName(org).dummy().list()).toEqual(["a"]);
  });

  it("refuses a call of no member", async () => {
    await expect(
      replayDevChain({ getByName: () => ({}) }, "x", [
        { kind: "member", key: "missing" },
        { kind: "call", args: [] },
      ]),
    ).rejects.toThrow("missing is not an RPC method");
  });
});

describe("a bridged stub", () => {
  it("reaches the same object as a direct caller, calls and pipelined part calls alike", async () => {
    const { bridge } = recordingBridge();
    const org = freshOrg();
    const stub = bridgedControlPlane(bridge).getByName(org);

    expect(await stub.dummy().add("a")).toBe(1);
    expect(await stub.dummy().addLater("b")).toBe(2);
    const part = stub.dummy();
    expect(await part.list()).toEqual(["a", "b"]);
    expect(await env.CONTROL_PLANE.getByName(org).dummy().list()).toEqual(["a", "b"]);
    expect(stub.name).toBe(org);
  });

  it("sends a call with the calls chained onto it in the same turn as one chain, once however often awaited", async () => {
    const { bridge, sent } = recordingBridge();
    const org = freshOrg();
    const stub = bridgedControlPlane(bridge).getByName(org);

    const call = stub.dummy().add("a");

    expect(await call).toBe(1);
    expect(await call).toBe(1);
    expect(sent).toEqual([
      {
        binding: "CONTROL_PLANE",
        name: org,
        chain: [
          { kind: "member", key: "dummy" },
          { kind: "call", args: [] },
          { kind: "member", key: "add" },
          { kind: "call", args: ["a"] },
        ],
      },
    ]);
  });

  it("sends a call nobody awaits at the end of the turn, and no member read nobody awaits", async () => {
    const { bridge, sent } = recordingBridge();
    const org = freshOrg();
    const stub = bridgedControlPlane(bridge).getByName(org);

    void stub.dummy().add("a");
    void stub.other;

    expect(sent).toEqual([]);
    await endOfTurn();
    expect(sent.map(({ chain }) => chain.length)).toEqual([4]);
    expect(await env.CONTROL_PLANE.getByName(org).dummy().list()).toEqual(["a"]);
  });

  it("passes the object's failures on", async () => {
    const { bridge } = recordingBridge();
    const stub = bridgedControlPlane(bridge).getByName(freshOrg());

    await expect(settled(stub.dummy().fail("the part failed"))).rejects.toThrow("the part failed");
  });

  it("carries only getByName and RPC calls, never the members every object has", () => {
    const { bridge, sent } = recordingBridge();
    const namespace = bridgedControlPlane(bridge);
    // SAFETY: the bridged stub is a Proxy that answers any member name; the test reads members it never declared.
    const stub = namespace.getByName("org") as unknown as Record<string, unknown>;

    expect(() => namespace.idFromName("org")).toThrow("not bridged");
    expect(() => stub["id"]).toThrow("not bridged");
    expect(() => stub["fetch"]).toThrow("not bridged");
    expect(stub["then"]).toBeUndefined();
    expect(stub["toJSON"]).toBeUndefined();
    expect(sent).toEqual([]);
  });
});

describe("devBridgedNamespace", () => {
  it("sends the calls of each state namespace under its binding", async () => {
    const { bridge, sent } = recordingBridge();

    const platform = devBridgedNamespace<
      typeof env.PLATFORM extends DurableObjectNamespace<infer T> ? T : never
    >(bridge, "PLATFORM").getByName(`platform-${crypto.randomUUID()}`);

    expect(Array.isArray(await platform.listOrgs())).toBe(true);
    expect(sent.map(({ binding }) => binding)).toEqual(["PLATFORM"]);
  });
});

describe("devBridgedEnv", () => {
  it("puts the state namespaces over the bridge, keeps the other bindings, and makes one copy per env", async () => {
    const { bridge, sent } = recordingBridge();
    const dev = { DEV_STATE_BRIDGE: bridge, OTHER: "kept" };
    const bridged = devBridgedEnv<StateBindings & { readonly OTHER: string }>(dev);

    expect(bridged.OTHER).toBe("kept");
    expect(devBridgedEnv<StateBindings & { readonly OTHER: string }>(dev)).toBe(bridged);
    expect(
      Array.isArray(await bridged.PLATFORM.getByName(`p-${crypto.randomUUID()}`).listOrgs()),
    ).toBe(true);
    expect(sent.map(({ binding }) => binding)).toEqual(["PLATFORM"]);
  });
});
