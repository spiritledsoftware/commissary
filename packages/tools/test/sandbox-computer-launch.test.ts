// How a session's computer is launched (#223, `src/sandbox/cloudflare/computer.ts`): `@cloudflare/computer`'s container
// backend and host over Commissary's guard, in a real session object, against a fake container that records what it is
// asked for (`support/fake-container.ts`). The container gets no internet but through the session's egress
// (`enableInternet: false`, every outbound request intercepted), no environment beyond computerd's settings, mise's
// directories and the package's own per-container secret, the `Computer` image, and the ten-minute idle timeout;
// Cloudflare's refusal at the account's limit of containers comes back as `ComputerAtLimit`.
import type {
  ContainerLaunchSpec,
  IWorkspaceContainerAPI,
} from "@cloudflare/computer/backends/container";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  atLimit,
  COMPUTER_ENV,
  COMPUTER_IDLE_MS,
  computerBackend,
  guardedContainer,
} from "../src/sandbox/cloudflare/computer.ts";
import {
  COMPUTER_IMAGE_REF,
  type FakeContainer,
  fakeContainerOf,
  LAUNCH_STOPPED,
  withContainer,
} from "./support/fake-container.ts";

/** Launches the computer of a fresh session object over its fake container, and answers how the launch ended. */
const launch = async (prepare: (container: FakeContainer) => void = () => {}) => {
  const object = env.SANDBOX_SESSION.getByName(`launch:${crypto.randomUUID()}`);

  return await runInDurableObject(object, async (_instance, state) => {
    const container = fakeContainerOf(state.id.toString());

    prepare(container);

    const backend = await computerBackend({
      state: withContainer(state, container),
      workspace: { binding: "SANDBOX_SESSION", id: state.id.toString() },
      gateway: { fetch: () => Promise.reject(new Error("no egress here")) } as unknown as Fetcher,
      instance: "standard-1",
    });

    const failure = await backend.connect().then(
      () => undefined,
      (error: Error) => error,
    );

    return { container, failure };
  });
};

describe("the computer's launch", () => {
  it("has no internet but through the egress, nothing in its environment but its own, and the idle timeout", async () => {
    const { container, failure } = await launch();

    // The launch went as far as the intercept of all outbound traffic, where the fake stops it.
    expect(failure?.message).toContain(LAUNCH_STOPPED);
    expect(container.outbound).toBeDefined();

    const [start, ...others] = container.starts;

    expect(others).toEqual([]);
    expect(start).toMatchObject({
      enableInternet: false,
      image: COMPUTER_IMAGE_REF,
      instance: "standard-1",
    });
    expect(Object.keys(start?.env ?? {}).toSorted()).toEqual(
      ["PORT", "MOUNT_POINT", "RPC_CLIENT_SECRET", ...Object.keys(COMPUTER_ENV)].toSorted(),
    );
    expect(start?.env).toMatchObject({ ...COMPUTER_ENV, MOUNT_POINT: "/workspace" });
    expect(container.inactivityTimeouts).toEqual([COMPUTER_IDLE_MS]);
    expect(COMPUTER_IDLE_MS).toBe(10 * 60 * 1000);
  });

  it("says when Cloudflare refuses it at the account's limit of containers", async () => {
    const { container, failure } = await launch((fake) => {
      fake.startFails =
        "There is no Container instance that can be provided to this Durable Object, try again later";
    });

    expect(container.starts).toEqual([]);
    expect(failure && atLimit(failure)?.message).toBe(
      "Cloudflare refused to start the computer: the deployment's account is at its limit of containers (There is no Container instance that can be provided to this Durable Object, try again later).",
    );

    const other = await launch((fake) => {
      fake.startFails = "the image is missing";
    });

    expect(other.failure && atLimit(other.failure)).toBeUndefined();
  });

  it("is held to its own whatever the backend asks: enableInternet false, and no environment beyond it", async () => {
    const asked: Array<ContainerLaunchSpec | number> = [];

    const host = {
      start: async (spec: ContainerLaunchSpec) => {
        asked.push(spec);

        return { runtimeId: "r", clientSecret: "s", outcome: "launched" as const };
      },
      restart: async (spec: ContainerLaunchSpec) => {
        asked.push(spec);

        return { runtimeId: "r", clientSecret: "s", outcome: "launched" as const };
      },
      setInactivityTimeout: async (ms: number) => {
        asked.push(ms);
      },
    } as unknown as IWorkspaceContainerAPI;

    const guarded = guardedContainer(host);

    await guarded.restart({ env: { PORT: "8080" }, enableInternet: true, name: "Computer" });
    expect(asked).toEqual([
      { env: { PORT: "8080" }, enableInternet: false, name: "Computer" },
      COMPUTER_IDLE_MS,
    ]);

    await expect(
      guarded.start({
        env: { PORT: "8080", OPENAI_API_KEY: "sk-x" },
        enableInternet: false,
        name: "Computer",
      }),
    ).rejects.toThrow("the computer gets no environment beyond its own, not OPENAI_API_KEY");
    expect(asked).toHaveLength(2);
  });
});
