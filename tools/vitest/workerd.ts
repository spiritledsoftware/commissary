/**
 * Options every workerd project (`@cloudflare/vitest-plugin`) spreads into its `test`.
 *
 * `fsModuleCache: false`: Vitest 5.0.5 caches transformed modules on disk by default (5.0.3 did not) and hands
 * each fresh worker a snapshot of the modules its files import (`fetchWarmModules`); `@cloudflare/vitest-plugin` (1.6)
 * inlines every cached module's code into that one reply, which over a Worker's import graph exceeds workerd's
 * WebSocket message size, so workerd closes the runner's socket (1009, "Message is too large") and every file after a
 * worker's first fails with "Worker exited unexpectedly". Without the cache, the snapshot is empty and each module is
 * fetched on its own. Drop this once the plugin sends the snapshot in parts.
 *
 * Imports nothing: this file sits outside every package (node-package.ts explains why that matters).
 */
export const workerdTestOptions = { fsModuleCache: false } as const;
