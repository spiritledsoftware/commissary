/**
 * Local `$ref` inlining for JSON schemas (`InlineLocalRefs`).
 *
 * The implementation lives in `@commissary/translation` (`common/schema-refs.ts`), shared with the Gemini/Antigravity
 * schema cleaners: references are resolved against the original schema before definition containers are stripped,
 * each expansion receives its own copy while the expansion budget lasts, conflicting sibling assertions stay
 * conjunctive and cycles end as a typed hint instead of recursing.
 */
export { inlineLocalRefs } from "@commissary/translation";
