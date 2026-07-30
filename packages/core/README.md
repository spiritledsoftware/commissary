# @commissary/core

Provider-neutral Agent, Model, Tool, Hook, and durable Runtime APIs for Commissary.

## Install

```sh
pnpm add @commissary/core
```

A host creates a Commissary instance with an explicit Thread Store:

```ts
import { Agent, Model, commissary } from "@commissary/core";

const model = Model.define({
  id: "model",
  async *invoke() {
    // Yield canonical Model Events from a provider adapter.
  },
});

const agent = Agent.define({ id: "agent", fragments: model });
const app = commissary({ threadStore });
const client = app.agent(agent);
```

Use `@commissary/store-memory` for tests and local development. It is not durable.

This package is ESM-only. It supports Node.js 22.14 or later, the current stable Bun and Deno releases, modern browsers, and Cloudflare Workers.

See the [project README](../../README.md) for a complete example and package map.
