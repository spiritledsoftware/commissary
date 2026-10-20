/**
 * The local test budget (docs/DEVELOPMENT.md, "Tests"): how many Vitest workers one package's run may use, so that
 * `pnpm test` (tools/test.sh runs `turbo run test` with `--concurrency=$COMMISSARY_TEST_PACKAGES`) stays near the
 * machine's core count: packages at once × workers each. Many of the workers are workerd processes, one Miniflare
 * each (`@cloudflare/vitest-plugin`), so Vitest's default (cores - 1 per package) times Turborepo's 10 packages at
 * once starts dozens of them on a laptop.
 *
 * - `CI` set (GitHub Actions' jobs run `pnpm test --shard=N/3`): `undefined`, so Vitest keeps its defaults and CI runs
 *   exactly as before.
 * - Otherwise `COMMISSARY_TEST_WORKERS` if it is set to a positive integer, else the cores divided by the packages
 *   that run at once (`COMMISSARY_TEST_PACKAGES`, tools/test.sh exports it; {@link DEFAULT_TEST_PACKAGES} when a
 *   package's tests run on their own), at least 1.
 *
 * Imports a Node.js builtin only, as node-package.ts explains.
 */
import { availableParallelism } from "node:os";

/** Packages whose tests run at once locally (`turbo run test --concurrency`); keep equal to the default in tools/test.sh. */
export const DEFAULT_TEST_PACKAGES = 2;

/** A positive integer in `value`, else `undefined`. */
const positiveInteger = (value: string | undefined): number | undefined => {
  const parsed = Number(value);

  return value !== undefined && Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
};

/** `test.maxWorkers` for a package's Vitest config: `undefined` (Vitest's default) in CI, the local budget otherwise. */
export const testWorkers = (env: NodeJS.ProcessEnv = process.env): number | undefined => {
  if (env.CI) return undefined;

  const packages = positiveInteger(env.COMMISSARY_TEST_PACKAGES) ?? DEFAULT_TEST_PACKAGES;

  return (
    positiveInteger(env.COMMISSARY_TEST_WORKERS) ??
    Math.max(1, Math.floor(availableParallelism() / packages))
  );
};

/**
 * {@link testWorkers} as the config fragment to spread into `test`: `{ maxWorkers }`, or nothing in CI (the tsconfigs
 * set `exactOptionalPropertyTypes`, so `maxWorkers: undefined` is not accepted).
 */
export const testWorkerOptions = (
  env: NodeJS.ProcessEnv = process.env,
): { maxWorkers?: number } => {
  const maxWorkers = testWorkers(env);

  return maxWorkers === undefined ? {} : { maxWorkers };
};
