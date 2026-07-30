import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { expectedRuntimeConformance } from "./runtime-conformance-suite.mjs";

const entryPoint = fileURLToPath(
  new URL("./runtime-conformance-browser-entry.mjs", import.meta.url),
);
const bundle = await build({
  bundle: true,
  entryPoints: [entryPoint],
  format: "iife",
  platform: "browser",
  target: "es2022",
  write: false,
});
const script = bundle.outputFiles[0]?.text;
if (script === undefined) {
  throw new Error("Browser conformance bundle was not created");
}

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.route("https://commissary.test/", (route) =>
    route.fulfill({
      body: "<!doctype html><html><body></body></html>",
      contentType: "text/html",
    }),
  );
  await page.goto("https://commissary.test/");
  await page.addScriptTag({ content: script });
  const outcome = await page.evaluate(() => globalThis.commissaryRuntimeConformance);
  if (!outcome.ok) {
    throw new Error(`Chromium conformance failed: ${outcome.error}`);
  }
  assert.deepEqual(outcome.result, expectedRuntimeConformance);
  console.log(`chromium:${outcome.result.result};imports:${outcome.result.imports}`);
} finally {
  await browser.close();
}
