# @commissary/store-memory

A process-local generic Store and Thread Store for tests and local development.

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

## Adapter semantics

`MemoryStore.make` creates a generic Store for a supplied Record catalog.
`MemoryThreadStore.make` creates the Core Thread Store specialization.

`MemoryStore.transaction` serializes each full callback and each base CRUD call
with one process-local lock. It uses an undo journal for rollback and invokes a
transaction callback at most once. The transaction view has no nested
transaction method, savepoints, or cancellation option.

`MemoryThreadStore.make` composes this transaction backend with the Core-owned
Thread Store transitions. The Memory adapter does not own claim, fence, commit,
suspension, or finalization rules.

Both factories use the JavaScript fallback query and update operators. String
comparison uses case-sensitive JavaScript relational comparison. It does not
use locale rules. Ordered Records with equal values keep their prior order.
The adapter has no maximum `find` limit and no maximum `inArray` candidate
count. It does not expose a runtime capability registry.

This package is ESM-only. It supports Node.js 22.14 or later, the current stable Bun and Deno releases, modern browsers, and Cloudflare Workers.
