# @commissary/store-memory

A process-local Thread Store for Commissary tests and local development.

## Install

```sh
pnpm add @commissary/core @commissary/store-memory
```

## Use

```ts
import { commissary } from "@commissary/core";
import { MemoryThreadStore } from "@commissary/store-memory";

const app = commissary({
  threadStore: MemoryThreadStore.make(),
});
```

The Memory Thread Store is not durable. Data is lost when the process stops. Production hosts must use a durable Thread Store adapter.

This package is ESM-only. It supports Node.js 22.14 or later, the current stable Bun and Deno releases, modern browsers, and Cloudflare Workers.
