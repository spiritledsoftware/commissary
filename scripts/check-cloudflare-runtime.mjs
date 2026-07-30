import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { expectedRuntimeConformance } from "./runtime-conformance-suite.mjs";

const entryPoint = fileURLToPath(
  new URL("./runtime-conformance-worker-entry.mjs", import.meta.url),
);
const bundle = await build({
  bundle: true,
  conditions: ["workerd", "worker", "browser", "import", "default"],
  entryPoints: [entryPoint],
  format: "esm",
  platform: "browser",
  target: "es2022",
  write: false,
});
const script = bundle.outputFiles[0]?.text;
if (script === undefined) {
  throw new Error("Cloudflare Workers conformance bundle was not created");
}

const miniflare = new Miniflare({
  compatibilityDate: "2026-07-22",
  modules: true,
  script,
});
try {
  const response = await miniflare.dispatchFetch("https://commissary.test/");
  const outcome = await response.json();
  if (!response.ok || !outcome.ok) {
    throw new Error(`Cloudflare Workers conformance failed: ${outcome.error}`);
  }
  assert.deepEqual(outcome.result, expectedRuntimeConformance);
  console.log(`cloudflare:${outcome.result.result};imports:${outcome.result.imports}`);
} finally {
  await miniflare.dispose();
}
