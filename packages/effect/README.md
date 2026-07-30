# @commissary/effect

Effect-native adapters for Commissary and a bridge from Effect AI Models to the provider-neutral Commissary Model protocol.

## Install

```sh
pnpm add @commissary/core @commissary/effect effect
```

## Entry points

- `@commissary/effect` provides `EffectCommissary` and Effect-native Agent clients.
- `@commissary/effect/ai` provides `EffectAi.model` and schema adapters for Effect AI integrations.

The package keeps Effect behind the plain JavaScript contracts in `@commissary/core`. It is ESM-only and supports Node.js 22.14 or later, the current stable Bun and Deno releases, modern browsers, and Cloudflare Workers.

See the [project README](../../README.md) for the package map and development commands.
