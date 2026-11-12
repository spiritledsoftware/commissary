// A caller's calls to the state Worker are retried once when a deploy of its code resets the Durable Object
// (`retryOnCodeUpdate`, ADR 0030, #128). The wrapped stubs are checked on the test Worker's real ControlPlane (calls and
// pipelined part calls answer as the runtime's do) and on fake stubs whose first calls fail as a reset does.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { OrgId } from "@commissary/core";
import { isCodeUpdateReset, retryingNamespace, retryOnCodeUpdate } from "../src/index.ts";

const RESET = "Durable Object reset because its code was updated.";

/**
 * `call` settled as a promise. The wrapped calls are callable like the runtime's RPC promises, and Vitest's `rejects`
 * would call a function it is given.
 */
const settled = async <T>(call: PromiseLike<T>): Promise<T> => await call;

const freshOrg = () => OrgId.make(`retry-${crypto.randomUUID().slice(0, 8)}`);

/** A fake Models-like part whose calls are recorded; `fail` decides what each call does instead of answering. */
interface FakeCall {
  readonly stub: number;
  readonly method: string;
  readonly args: ReadonlyArray<string>;
}

/**
 * A fake namespace: stub `n` (counted from 1, one per `getByName`) answers `echo(x)` and `part().echo(x)` with
 * `"<n>:<x>"`, unless `failure(n)` names an error, which every call of that stub rejects with.
 */
const fakeNamespace = (failure: (stub: number) => Error | undefined) => {
  const calls: FakeCall[] = [];
  let stubs = 0;

  const answer = (stub: number, method: string, args: ReadonlyArray<string>) => {
    calls.push({ stub, method, args });
    const error = failure(stub);

    return error === undefined
      ? Promise.resolve(`${stub}:${args.join(",")}`)
      : Promise.reject(error);
  };

  const namespace = {
    getByName: (name: string) => {
      stubs += 1;
      const stub = stubs;

      return {
        name,
        echo: (...args: string[]) => answer(stub, "echo", args),
        part: () => ({ echo: (...args: string[]) => answer(stub, "part.echo", args) }),
      };
    },
  };

  interface FakeStub {
    readonly name: string;
    echo(...args: string[]): Promise<string>;
    part(): { echo(...args: string[]): Promise<string> };
  }

  return {
    namespace: retryingNamespace(
      namespace as unknown as DurableObjectNamespace<FakeStub & Rpc.DurableObjectBranded>,
    ),
    calls,
    stubs: () => stubs,
  };
};

describe("isCodeUpdateReset", () => {
  it("is the runtime's failure of a call a deploy cut off, and nothing else", () => {
    expect(isCodeUpdateReset(new Error(RESET))).toBe(true);
    expect(isCodeUpdateReset(new Error("Durable Object is overloaded."))).toBe(false);
    expect(isCodeUpdateReset(RESET)).toBe(false);
    expect(isCodeUpdateReset(undefined)).toBe(false);
  });
});

describe("a stub of a retrying namespace", () => {
  it("answers calls and pipelined part calls of the real ControlPlane, with the stub's own id and name", async () => {
    const org = freshOrg();
    const namespace = retryingNamespace(env.CONTROL_PLANE);
    const stub = namespace.getByName(org);

    expect(await stub.dummy().add("a")).toBe(1);
    expect(await stub.dummy().addLater("b")).toBe(2);
    const part = stub.dummy();
    expect(await part.list()).toEqual(["a", "b"]);
    expect(await env.CONTROL_PLANE.getByName(org).dummy().list()).toEqual(["a", "b"]);
    expect(stub.name).toBe(org);
    expect(stub.id.equals(env.CONTROL_PLANE.idFromName(org))).toBe(true);
    expect(namespace.idFromName(org).equals(env.CONTROL_PLANE.idFromName(org))).toBe(true);
  });

  it("passes other failures of the real ControlPlane on unchanged", async () => {
    const stub = retryingNamespace(env.CONTROL_PLANE).getByName(freshOrg());

    await expect(settled(stub.dummy().fail("the part failed"))).rejects.toThrow("the part failed");
  });

  it("sends a call when it is made, before anything awaits it", async () => {
    const fake = fakeNamespace(() => undefined);
    const stub = fake.namespace.getByName("org");

    const pending = stub.part().echo("x");

    expect(fake.calls).toEqual([{ stub: 1, method: "part.echo", args: ["x"] }]);
    expect(await pending).toBe("1:x");
    expect(fake.calls).toHaveLength(1);
  });

  it("sends a call cut off by a code-update reset once more on a new stub, the pipelined chain included", async () => {
    const fake = fakeNamespace((stub) => (stub === 1 ? new Error(RESET) : undefined));
    const stub = fake.namespace.getByName("org");

    expect(await stub.part().echo("a", "b")).toBe("2:a,b");
    // The stub that threw is not used again: a later call goes to the new one.
    expect(await stub.echo("c")).toBe("2:c");
    expect(fake.stubs()).toBe(2);
    expect(fake.calls).toEqual([
      { stub: 1, method: "part.echo", args: ["a", "b"] },
      { stub: 2, method: "part.echo", args: ["a", "b"] },
      { stub: 2, method: "echo", args: ["c"] },
    ]);
  });

  it("retries only once: a second reset reaches the caller", async () => {
    const fake = fakeNamespace(() => new Error(RESET));

    await expect(settled(fake.namespace.getByName("org").echo("a"))).rejects.toThrow(RESET);
    expect(fake.calls.map((call) => call.stub)).toEqual([1, 2]);
  });

  it("does not retry any other failure", async () => {
    const fake = fakeNamespace(() => new Error("Durable Object is overloaded."));

    await expect(settled(fake.namespace.getByName("org").part().echo("a"))).rejects.toThrow(
      "overloaded",
    );
    expect(fake.stubs()).toBe(1);
    expect(fake.calls).toHaveLength(1);
  });

  it("answers the members every object has itself, sending no call", () => {
    const fake = fakeNamespace(() => undefined);
    const stub = fake.namespace.getByName("org") as unknown as Record<string, unknown>;
    const call = fake.namespace.getByName("org").echo("a") as unknown as Record<string, unknown>;

    expect(stub["toJSON"]).toBeUndefined();
    expect(typeof stub["toString"]).toBe("function");
    expect(call["toJSON"]).toBeUndefined();
    expect(fake.calls).toEqual([{ stub: 2, method: "echo", args: ["a"] }]);
  });

  it("settles a call once however often it is awaited", async () => {
    const fake = fakeNamespace((stub) => (stub === 1 ? new Error(RESET) : undefined));
    const call = fake.namespace.getByName("org").echo("a");

    expect(await call).toBe("2:a");
    expect(await call).toBe("2:a");
    expect(fake.calls).toHaveLength(2);
  });
});

describe("retryOnCodeUpdate", () => {
  it("wraps the state namespaces, keeps the other bindings, and answers the same copy for the same env", async () => {
    const bindings = { ...env, OTHER: "kept" };
    const wrapped = retryOnCodeUpdate(bindings);

    expect(wrapped).not.toBe(bindings);
    expect(retryOnCodeUpdate(bindings)).toBe(wrapped);
    expect(wrapped.OTHER).toBe("kept");
    expect(wrapped.SECRETS_KEY).toBe(env.SECRETS_KEY);
    expect(wrapped.CONTROL_PLANE).not.toBe(env.CONTROL_PLANE);
    expect(wrapped.PLATFORM).not.toBe(env.PLATFORM);
    expect(wrapped.SESSION_STATE).not.toBe(env.SESSION_STATE);
    expect(await wrapped.CONTROL_PLANE.getByName(freshOrg()).dummy().add("a")).toBe(1);
  });
});
