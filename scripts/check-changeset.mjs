import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const changeSetFile = /^\.changeset\/(?!README\.md$)[^/]+\.md$/;
const publishablePackageFile =
  /^packages\/[^/]+\/(?:package\.json$|src\/|tsconfig(?:\.[^/]+)?\.json$)/;

export function checkChangesetPolicy({ changedFiles, labels, headRef }) {
  if (headRef === "changeset-release/main") {
    return {
      ok: true,
      message: "The Version Packages pull request does not need a Changeset.",
    };
  }
  if (labels.includes("no-changeset")) {
    return { ok: true, message: "The no-changeset label allows this change." };
  }
  if (!changedFiles.some((file) => publishablePackageFile.test(file))) {
    return { ok: true, message: "No publishable package code changed." };
  }
  if (changedFiles.some((file) => changeSetFile.test(file))) {
    return { ok: true, message: "Changeset found." };
  }
  return {
    ok: false,
    message:
      "Publishable package code changed without a Changeset. Add one with 'pnpm changeset' or apply the 'no-changeset' label.",
  };
}

function changedFilesSince(baseRef) {
  return execFileSync(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMR", `origin/${baseRef}...HEAD`],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean);
}

function labelsFromEnvironment() {
  const value = JSON.parse(process.env.PR_LABELS ?? "[]");
  if (!Array.isArray(value) || !value.every((label) => typeof label === "string")) {
    throw new TypeError("PR_LABELS must be a JSON array of strings");
  }
  return value;
}

function main() {
  const result = checkChangesetPolicy({
    changedFiles: changedFilesSince(process.env.GITHUB_BASE_REF ?? "main"),
    labels: labelsFromEnvironment(),
    headRef: process.env.GITHUB_HEAD_REF ?? "",
  });
  console.log(result.message);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
