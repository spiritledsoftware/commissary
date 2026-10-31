#!/usr/bin/env node
/**
 * Regenerates the bundled models.dev snapshot (`packages/models/src/registry/catalog/models-dev.json`): the providers
 * Commissary reads from the models.dev document, trimmed to the fields it uses (ADR 0020). The catalog additions
 * (`packages/models/src/registry/catalog/additions.json`) are maintained by hand and untouched.
 *
 * Usage: `bun run catalog:sync [source]`, where `source` is an http(s) URL or a local file (for instance a saved
 * `api.json`). Defaults to `https://models.dev/api.json`. Run by Node directly (type stripping), so it only imports the
 * dependency-light trim module (`@commissary/models/models-dev`). Idempotent: syncing a trimmed document rewrites it unchanged.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { trimModelsDev } from "@commissary/models/models-dev";

const DEFAULT_SOURCE = "https://models.dev/api.json";

const OUTPUT = fileURLToPath(
  new URL("../packages/models/src/registry/catalog/models-dev.json", import.meta.url),
);

const source = process.argv[2] ?? DEFAULT_SOURCE;

const load = async (from: string): Promise<string> => {
  if (/^https?:\/\//.test(from)) {
    const response = await fetch(from, { headers: { accept: "application/json" } });

    if (!response.ok) throw new Error(`${from} answered HTTP ${response.status}`);

    return response.text();
  }

  return readFile(from, "utf8");
};

const trimmed = trimModelsDev(await load(source));

if (!trimmed.ok) {
  process.stderr.write(`catalog rejected: ${trimmed.error}\n`);
  process.exit(1);
}

await writeFile(OUTPUT, `${JSON.stringify(trimmed.value, null, 2)}\n`);

const counts = Object.values(trimmed.value).map(
  (provider) => `${provider.id}: ${Object.keys(provider.models).length} models`,
);

process.stdout.write(`wrote ${OUTPUT} (${counts.join(", ")}) from ${source}\n`);
