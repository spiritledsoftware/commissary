// A fake of the computer's container (#223): what a session object's `ctx.container` is on a deployment that attached
// the `Computer` image, for the tests that run `@cloudflare/computer`'s real container backend and host over it. It
// records what it is asked (each start's options, the idle timeouts, the outbound intercepts), and stops a launch where
// the real one would wait for computerd: when the backend sets up the intercept of all outbound traffic, which it then
// keeps, as the platform does, so a test can send the computer's requests through it.
//
// `withContainer` puts the fake in the object's `ctx.container`. `realContainerOrgs` names the
// orgs whose session objects use the real backend over the fake (the test Worker's `SandboxSession`); the others run
// the fake computer (`fake-computer.ts`).

/** Where the fake stops a launch: the backend's next step needs a running computerd, which no test has. */
export const LAUNCH_STOPPED = "the fake container stops here";

/** What a session object's fake container was asked, and what it holds. */
export interface FakeContainer {
  /** The options of each start, in order. */
  readonly starts: Array<ContainerStartupOptions>;
  /** Each idle timeout set, in ms. */
  readonly inactivityTimeouts: Array<number>;
  /** The intercept of all outbound HTTP, once set: where the computer's requests go. */
  outbound: Fetcher | undefined;
  /** When set, a start fails with this message, as Cloudflare's refusals do. */
  startFails: string | undefined;
  running: boolean;
}

/** The fake containers, by session object id. */
export const fakeContainers = new Map<string, FakeContainer>();

/** The orgs whose session objects run the real container backend over the fake container. */
export const realContainerOrgs = new Set<string>();

/** The image the deploy prepares for the `Computer` Container, as `ctx.container.images` names it. */
export const COMPUTER_IMAGE_REF = "registry.cloudflare.com/account/computer@sha256:0";

/** The fake container of the object `id`, made on first use. */
export const fakeContainerOf = (id: string): FakeContainer => {
  const existing = fakeContainers.get(id);

  if (existing !== undefined) return existing;

  const made: FakeContainer = {
    starts: [],
    inactivityTimeouts: [],
    outbound: undefined,
    startFails: undefined,
    running: false,
  };

  fakeContainers.set(id, made);

  return made;
};

const asContainer = (fake: FakeContainer): Container =>
  ({
    get running() {
      return fake.running;
    },
    images: { Computer: COMPUTER_IMAGE_REF },
    start(options: ContainerStartupOptions) {
      if (fake.startFails !== undefined) throw new Error(fake.startFails);
      fake.starts.push(options);
      fake.running = true;
    },
    // A container that never exits while the test runs.
    monitor: () => new Promise<void>(() => {}),
    destroy: async () => {
      fake.running = false;
    },
    signal: () => {},
    getTcpPort: () => ({
      fetch: () => Promise.reject(new Error("no computerd in the tests")),
      connect: () => {
        throw new Error("no computerd in the tests");
      },
    }),
    setInactivityTimeout: async (durationMs: number | bigint) => {
      fake.inactivityTimeouts.push(Number(durationMs));
    },
    interceptOutboundHttp: async () => {},
    interceptOutboundHttps: async () => {},
    interceptAllOutboundHttp: async (binding: Fetcher) => {
      fake.outbound = binding;
      throw new Error(LAUNCH_STOPPED);
    },
  }) as unknown as Container;

/**
 * `state`, with `fake` as its `container` from now on: an own property over the platform's (none, in the test Worker),
 * so the object's state stays the one value `@cloudflare/computer` keys its per-object records by.
 */
export const withContainer = (
  state: DurableObjectState,
  fake: FakeContainer,
): DurableObjectState => {
  Object.defineProperty(state, "container", { value: asContainer(fake), configurable: true });

  return state;
};
