import { expectedRuntimeConformance, runRuntimeConformance } from "./runtime-conformance-suite.mjs";

const result = await runRuntimeConformance();
if (
  result.imports !== expectedRuntimeConformance.imports ||
  result.result !== expectedRuntimeConformance.result
) {
  throw new Error("Runtime conformance returned an incorrect result");
}

console.log(`${result.result};imports:${result.imports}`);
