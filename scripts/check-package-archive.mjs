import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const requiredPaths = [
  "dist/index.d.ts",
  "dist/index.js",
  "LICENSE",
  "package.json",
  "README.md",
  "src/index.ts",
];

function exportTargets(value) {
  if (typeof value === "string") return value.startsWith("./") ? [value.slice(2)] : [];
  if (value === null || typeof value !== "object") return [];
  return Object.values(value).flatMap(exportTargets);
}

export function validatePackageArchive(packageName, files, exports = {}) {
  const paths = files.map((file) => file.path);
  const includedPaths = new Set(paths);

  for (const requiredPath of requiredPaths) {
    if (!includedPaths.has(requiredPath)) {
      throw new Error(`${packageName} archive is missing '${requiredPath}'`);
    }
  }

  for (const target of exportTargets(exports)) {
    if (!includedPaths.has(target)) {
      throw new Error(`${packageName} archive is missing export target '${target}'`);
    }
  }

  const unwantedPath = paths.find(
    (path) =>
      path === ".env" ||
      path.startsWith(".env.") ||
      path.startsWith("node_modules/") ||
      path.startsWith("test/") ||
      path.includes("/test/") ||
      path.endsWith(".tgz"),
  );
  if (unwantedPath !== undefined) {
    throw new Error(`${packageName} archive must not include '${unwantedPath}'`);
  }
}

function main() {
  const archive = JSON.parse(
    execFileSync("pnpm", ["pack", "--dry-run", "--json"], {
      encoding: "utf8",
    }),
  );
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  validatePackageArchive(archive.name, archive.files, manifest.exports);
  console.log(`${archive.name}@${archive.version}: ${archive.files.length} files checked`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
