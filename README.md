# Commissary

Commissary is a durable, provider-neutral agent runtime for TypeScript. It separates durable Run admission from process-bound execution and keeps Models, Tools, Hooks, and storage behind typed interfaces.

Commissary is in `0.x`. Public APIs can change between minor releases.

## Packages

| Package                                             | Purpose                                                     |
| --------------------------------------------------- | ----------------------------------------------------------- |
| [`@commissary/core`](packages/core)                 | Provider-neutral Agent, Model, Tool, Hook, and Runtime APIs |
| [`@commissary/store`](packages/store)               | Typed persistence, SQL Record, and SQL Store contracts      |
| [`@commissary/store-memory`](packages/store-memory) | Process-local Thread Store for tests and local development  |
| [`@commissary/drizzle`](packages/drizzle)           | Connection-free PostgreSQL, MySQL, and SQLite definitions   |
| [`@commissary/effect`](packages/effect)             | Effect client adapters and the Effect AI bridge             |
| [`@commissary/stream`](packages/stream)             | JavaScript and Effect execution stream adapters             |

## Supported runtimes

- Node.js 22.14 or later
- The current stable Bun
- The current stable Deno
- Modern browsers
- Cloudflare Workers

Repository development requires Node.js 22.14 or later and pnpm 11.16.

## Quick start

Install the core runtime and the development Thread Store:

```sh
pnpm add @commissary/core @commissary/store-memory
```

Create and execute one Agent Run:

```ts
import { Agent, Content, Model, commissary } from "@commissary/core";
import { MemoryThreadStore } from "@commissary/store-memory";

const model = Model.define({
  id: "example-model",
  async *invoke() {
    yield {
      type: "finish",
      response: {
        message: { role: "assistant", content: [Content.text("Hello")] },
        finishReason: "stop",
      },
    };
  },
});

const agent = Agent.define({ id: "example-agent", fragments: model });
const app = commissary({ threadStore: MemoryThreadStore.make() });
const thread = await app.createThread();
const branch = await app.createBranch({ threadId: thread.id, name: "main" });
const client = app.agent(agent);
const created = await client.createRun({
  threadId: thread.id,
  branchId: branch.id,
  message: { role: "user", content: [Content.text("Start")] },
});

if (created.type === "accepted") {
  const execution = await client.execute(created.runId);
  console.log(await execution.result);
}
```

`MemoryThreadStore` is not durable. Production hosts must provide a durable Thread Store adapter.

## Development

```sh
pnpm run bootstrap
pnpm run verify
pnpm run build
pnpm run check:imports
pnpm run smoke
```

Package changes must include a Changeset:

```sh
pnpm changeset
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full contribution process.

Maintainers can use the [release setup and bootstrap guide](docs/releasing.md) for the first npm publication and remote repository settings.

## Policies

- [Security policy](SECURITY.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [MIT license](LICENSE)
