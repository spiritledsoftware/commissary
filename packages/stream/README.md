# @commissary/stream

Bounded JavaScript and Effect stream adapters for Commissary execution events.

## Install

```sh
pnpm add @commissary/core @commissary/stream
```

## Entry points

- `@commissary/stream` exposes a JavaScript `execute` function that returns an `AsyncIterable` of execution events.
- `@commissary/stream/effect` exposes an Effect-native `execute` function and Effect `Stream`.

Streams are process-local views. They do not replace durable Run snapshots or results, and stopping a stream does not abort its Run.

This package is ESM-only. It supports Node.js 22.14 or later, the current stable Bun and Deno releases, modern browsers, and Cloudflare Workers.

See the [project README](../../README.md) for the package map and development commands.
