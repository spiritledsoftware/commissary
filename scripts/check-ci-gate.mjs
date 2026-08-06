import { pathToFileURL } from "node:url";

const successfulResult = "success";
const skippedResult = "skipped";

/** Validate that every CI job produced the result required for its change classification. */
export function checkCiGate({
  documentationOnly,
  policyResult,
  documentationResult,
  nodeVerificationResult,
  serverRuntimeResult,
  chromiumResult,
}) {
  const expectedResults = documentationOnly
    ? {
        policy: successfulResult,
        documentation: successfulResult,
        nodeVerification: skippedResult,
        serverRuntime: skippedResult,
        chromium: skippedResult,
      }
    : {
        policy: successfulResult,
        documentation: skippedResult,
        nodeVerification: successfulResult,
        serverRuntime: successfulResult,
        chromium: successfulResult,
      };
  const actualResults = {
    policy: policyResult,
    documentation: documentationResult,
    nodeVerification: nodeVerificationResult,
    serverRuntime: serverRuntimeResult,
    chromium: chromiumResult,
  };
  const rejectedResults = Object.entries(expectedResults)
    .filter(([job, expected]) => actualResults[job] !== expected)
    .map(
      ([job, expected]) =>
        `${job} expected ${expected}, received ${actualResults[job] ?? "missing"}`,
    );

  if (rejectedResults.length > 0) {
    return {
      ok: false,
      message: `CI gate rejected job results: ${rejectedResults.join("; ")}`,
    };
  }
  return {
    ok: true,
    message: documentationOnly
      ? "CI gate accepted documentation-only verification."
      : "CI gate accepted full verification.",
  };
}

function documentationOnlyFromEnvironment() {
  const value = process.env.DOCUMENTATION_ONLY;
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`CI gate requires DOCUMENTATION_ONLY to be true or false, received ${value}`);
}

function requiredJobResult(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`CI gate requires ${name}`);
  }
  return value;
}

function main() {
  const result = checkCiGate({
    documentationOnly: documentationOnlyFromEnvironment(),
    policyResult: requiredJobResult("POLICY_RESULT"),
    documentationResult: requiredJobResult("DOCUMENTATION_RESULT"),
    nodeVerificationResult: requiredJobResult("NODE_VERIFICATION_RESULT"),
    serverRuntimeResult: requiredJobResult("SERVER_RUNTIME_RESULT"),
    chromiumResult: requiredJobResult("CHROMIUM_RESULT"),
  });
  console.log(result.message);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
