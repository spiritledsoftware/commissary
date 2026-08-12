import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const specifiers = [
  "@commissary/core",
  "@commissary/core/internal",
  "@commissary/drizzle",
  "@commissary/drizzle/postgres",
  "@commissary/drizzle/mysql",
  "@commissary/drizzle/sqlite",
  "@commissary/store-memory",
  "@commissary/effect",
  "@commissary/effect/ai",
  "@commissary/stream",
  "@commissary/stream/effect",
];

async function collectRelativeModuleGraph(url, visited = new Set()) {
  if (visited.has(url.href)) return "";
  visited.add(url.href);
  const source = await readFile(url, "utf8");
  const relativeSpecifiers = [...source.matchAll(/(?:from\s*|import\s*)["'](\.[^"']+)["']/g)].map(
    ([, specifier]) => specifier,
  );
  const dependencies = await Promise.all(
    relativeSpecifiers.map((specifier) =>
      collectRelativeModuleGraph(new URL(specifier, url), visited),
    ),
  );
  return [source, ...dependencies].join("\n");
}

const drizzleRootGraph = await collectRelativeModuleGraph(
  new URL(import.meta.resolve("@commissary/drizzle")),
);
if (/drizzle-orm\/(?:pg|mysql|sqlite)-core/.test(drizzleRootGraph)) {
  throw new Error("Built package '@commissary/drizzle' root must not load a dialect module");
}
const drizzleDistUrl = new URL(".", import.meta.resolve("@commissary/drizzle"));
for (const path of await readdir(fileURLToPath(drizzleDistUrl), { recursive: true })) {
  if (!path.endsWith(".d.ts")) continue;
  const declaration = await readFile(new URL(path, drizzleDistUrl), "utf8");
  if (/\bany\b|declare\s+global|\$Infer/.test(declaration)) {
    throw new Error(`Built @commissary/drizzle declaration '${path}' leaks a forbidden type`);
  }
}

for (const specifier of specifiers) {
  const module = await import(specifier);
  if (Object.keys(module).length === 0) {
    throw new Error(`Built package '${specifier}' has no exports`);
  }
}

console.log(`imports:${specifiers.length}`);
