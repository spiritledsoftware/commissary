import type { StoreAdapterConformanceProfile } from "@commissary/store/conformance";

/** Documented Store semantics exercised by the Memory adapter conformance suites. */
export const memoryConformanceProfile = {
  adapter: "MemoryStore",
  find: {
    limitMaximum: null,
    equalValueOrder: "stable",
  },
  query: {
    semantics: "javascript-fallback",
    stringCollation: "JavaScript relational comparison (case-sensitive, no locale)",
    inArrayCandidateMaximum: null,
  },
  update: {
    semantics: "javascript-fallback",
  },
} satisfies StoreAdapterConformanceProfile;
