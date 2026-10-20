#!/usr/bin/env node
/**
 * Regenerates the bundled integrations.sh data of the toolkit catalog (ADR 0036, #207):
 *
 * - the snapshot (`packages/tools/src/catalog/integrations-sh.json`): the MCP servers, OpenAPI documents and GraphQL
 *   endpoints of integrations.sh's index that Commissary can build toolkits from, trimmed to the fields the catalog uses;
 * - the credentials (`packages/tools/src/catalog/integrations-sh-credentials.json`): for each of those sources, the ways
 *   it takes from the v3 document of its domain (`https://integrations.sh/api/<domain>/surface`: its credential
 *   registry, and where each credential goes), which say more than the index's note. A source matches the surface of
 *   its kind whose URL is its own (`credentials.ts`); one that matches none keeps the index's note.
 *
 * The toolkit catalog additions (`packages/tools/src/catalog/additions.json`) are maintained by hand and untouched.
 *
 * Usage: `pnpm toolkits:sync [source] [--fresh] [--no-credentials]`, where `source` is an http(s) URL or a local file
 * (for instance a saved `api.json`), by default `https://integrations.sh/api.json`. The per-domain documents are fetched
 * a few at a time (one request per domain, {@link CONCURRENCY} at once, retried with a pause on `429` and `5xx`) and
 * kept in `node_modules/.cache/integrations-sh/` (a domain without one is kept as such), so a run that stops resumes
 * where it was; `--fresh` fetches them all again. A domain whose document cannot be fetched keeps the credentials the
 * previous run wrote for it. `--no-credentials` rewrites the snapshot only.
 *
 * Run by Node directly (type stripping), so it only imports the dependency-light modules
 * `@commissary/tools/integrations-sh` and `@commissary/tools/integrations-sh-credentials`. Idempotent: syncing again
 * with the same documents rewrites both files unchanged.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { INTEGRATIONS_SH_INDEX_URL, trimIntegrationsSh } from "@commissary/tools/integrations-sh";
import {
  type CatalogAuth,
  type Discovery,
  discoveryFromText,
  sourceCredentials,
} from "@commissary/tools/integrations-sh-credentials";

const OUTPUT = fileURLToPath(
  new URL("../packages/tools/src/catalog/integrations-sh.json", import.meta.url),
);

const CREDENTIALS_OUTPUT = fileURLToPath(
  new URL("../packages/tools/src/catalog/integrations-sh-credentials.json", import.meta.url),
);

const CACHE = fileURLToPath(new URL("../node_modules/.cache/integrations-sh/", import.meta.url));

/** Where a domain's v3 document is. */
const SURFACE_URL = (domain: string) =>
  `https://integrations.sh/api/${encodeURIComponent(domain)}/surface`;

/** Requests to integrations.sh at once. */
const CONCURRENCY = 4;

const ATTEMPTS = 4;

const USER_AGENT = "commissary-toolkits-sync (+https://github.com/spiritledsoftware/commissary)";

const args = process.argv.slice(2);

const fresh = args.includes("--fresh");

const withCredentials = !args.includes("--no-credentials");

const source = args.find((arg) => !arg.startsWith("--")) ?? INTEGRATIONS_SH_INDEX_URL;

const load = async (from: string): Promise<string> => {
  if (/^https?:\/\//.test(from)) {
    const response = await fetch(from, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
    });

    if (!response.ok) throw new Error(`${from} answered HTTP ${response.status}`);

    return response.text();
  }

  return readFile(from, "utf8");
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const cacheFile = (domain: string) => `${CACHE}${encodeURIComponent(domain)}.json`;

/**
 * A domain's v3 document, from the cache unless `--fresh`: `null` when integrations.sh has none (or it does not read),
 * undefined when it could not be fetched.
 */
const surfaceOf = async (domain: string): Promise<Discovery | null | undefined> => {
  if (!fresh) {
    const cached = await readFile(cacheFile(domain), "utf8").catch(() => undefined);

    if (cached !== undefined) return discoveryFromText(cached) ?? null;
  }

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const response = await fetch(SURFACE_URL(domain), {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
    }).catch(() => undefined);

    if (response?.status === 404) {
      await writeFile(cacheFile(domain), "null\n");

      return null;
    }

    if (response?.ok === true) {
      const text = await response.text();

      await writeFile(cacheFile(domain), text);

      return discoveryFromText(text) ?? null;
    }

    // A rate limit, a server error or no answer: wait longer each time.
    await pause(attempt * 2000);
  }

  return undefined;
};

const trimmed = trimIntegrationsSh(await load(source));

if (!trimmed.ok) {
  process.stderr.write(`catalog rejected: ${trimmed.error}\n`);
  process.exit(1);
}

await writeFile(OUTPUT, `${JSON.stringify(trimmed.value, null, 2)}\n`);

const kinds = new Map<string, number>();

for (const record of trimmed.value.data) kinds.set(record.kind, (kinds.get(record.kind) ?? 0) + 1);

const counts = [...kinds].map(([kind, count]) => `${kind}: ${count}`);

process.stdout.write(
  `wrote ${OUTPUT} (${counts.join(", ")}; ${trimmed.skipped} malformed records skipped) from ${source}\n`,
);

if (withCredentials) {
  await mkdir(CACHE, { recursive: true });
  const byDomain = new Map<string, Array<(typeof trimmed.value.data)[number]>>();

  for (const record of trimmed.value.data)
    byDomain.set(record.domain, [...(byDomain.get(record.domain) ?? []), record]);
  const domains = [...byDomain.keys()].toSorted();

  const previous: Readonly<Record<string, ReadonlyArray<CatalogAuth>>> = await readFile(
    CREDENTIALS_OUTPUT,
    "utf8",
  )
    .then((text) => JSON.parse(text).sources ?? {})
    .catch(() => ({}));

  const credentials = new Map<string, ReadonlyArray<CatalogAuth>>();
  const unfetched: Array<string> = [];
  let next = 0;
  let done = 0;

  const work = async () => {
    while (next < domains.length) {
      const domain = domains[next++] ?? "";
      const records = byDomain.get(domain) ?? [];
      const surface = await surfaceOf(domain);

      if (surface === undefined) {
        unfetched.push(domain);

        for (const record of records) {
          const kept = previous[record.slug];

          if (kept !== undefined) credentials.set(record.slug, kept);
        }
      } else if (surface !== null)
        for (const [slug, auth] of sourceCredentials(surface, records)) credentials.set(slug, auth);

      done += 1;

      if (done % 100 === 0) process.stderr.write(`  ${done}/${domains.length} domains\n`);
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, work));

  const sorted = Object.fromEntries([...credentials].toSorted(([a], [b]) => (a < b ? -1 : 1)));

  // One source per line: the file stays small and its diffs readable.
  const lines = Object.entries(sorted).map(
    ([slug, auth]) => `    ${JSON.stringify(slug)}: ${JSON.stringify(auth)}`,
  );

  await writeFile(
    CREDENTIALS_OUTPUT,
    `{\n  "version": 1,\n  "sources": {\n${lines.join(",\n")}\n  }\n}\n`,
  );

  process.stdout.write(
    `wrote ${CREDENTIALS_OUTPUT} (${credentials.size} of ${trimmed.value.data.length} sources from ${domains.length} domains${
      unfetched.length === 0
        ? ""
        : `; ${unfetched.length} not fetched, kept as before: ${unfetched.slice(0, 10).join(", ")}`
    })\n`,
  );
}
