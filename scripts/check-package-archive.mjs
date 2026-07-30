import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const requiredPaths = [
  "dist/index.d.ts",
  "dist/index.js",
  "LICENSE",
  "package.json",
  "README.md",
  "src/index.ts",
];

export function validatePackageArchive(packageName, files) {
  const paths = files.map((file) => file.path);
  const includedPaths = new Set(paths);

  for (const requiredPath of requiredPaths) {
    if (!includedPaths.has(requiredPath)) {
      throw new Error(`${packageName} archive is missing '${requiredPath}'`);
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
  validatePackageArchive(archive.name, archive.files);
  console.log(`${archive.name}@${archive.version}: ${archive.files.length} files checked`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
