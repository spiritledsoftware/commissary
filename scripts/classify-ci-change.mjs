import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const documentationFilePatterns = [
  /^docs\//,
  /^[^/]+\.md$/,
  /^LICENSE$/,
  /^packages\/[^/]+\/(?:README\.md$|CONTEXT\.md$|docs\/)/,
  /^\.github\/.*\.md$/,
  /^\.agents\/.*\.md$/,
  /^\.changeset\/README\.md$/,
];

/** Classify a documentation-only change from its complete changed-file list. */
export function isDocumentationOnlyChange(changedFiles) {
  return (
    changedFiles.length > 0 &&
    changedFiles.every((file) => documentationFilePatterns.some((pattern) => pattern.test(file)))
  );
}

function requiredEnvironmentVariable(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`CI change classification requires ${name}`);
  }
  return value;
}

function comparisonForCiEvent() {
  const eventName = requiredEnvironmentVariable("GITHUB_EVENT_NAME");
  if (eventName === "pull_request") {
    return `origin/${requiredEnvironmentVariable("GITHUB_BASE_REF")}...HEAD`;
  }
  if (eventName === "push") {
    const baseSha = requiredEnvironmentVariable("CI_BASE_SHA");
    return /^0+$/.test(baseSha) ? undefined : `${baseSha}..HEAD`;
  }
  throw new Error(`CI change classification received unsupported event: ${eventName}`);
}

function changedFilesForComparison(comparison) {
  if (comparison === undefined) {
    return [];
  }
  return execFileSync("git", ["diff", "--name-only", "--diff-filter=ACDMR", comparison], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
}

function main() {
  const changedFiles = changedFilesForComparison(comparisonForCiEvent());
  const documentationOnly = isDocumentationOnlyChange(changedFiles);
  const outputPath = requiredEnvironmentVariable("GITHUB_OUTPUT");
  appendFileSync(outputPath, `documentation_only=${documentationOnly}\n`, "utf8");
  console.log(
    documentationOnly
      ? "CI change classification: documentation-only change"
      : "CI change classification: full verification required",
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
