// `@commissary/models/testing`: what the Worker's tests need of Models (docs/DEVELOPMENT.md, "Tests"). Test files only.
// The Worker's tests go through its router or `fetch` (the Access gate, the role table, org addressing, the composed
// management routes); they seed and inspect Models through these helpers and constants instead of its modules.

// --- harnesses and fakes ---------------------------------------------------------------------------------------------

export { comparable } from "./support/config-entries.ts";

export {
  claudeFile,
  controlPlane,
  jsonInit,
  resetControlPlane,
  resetOrgControlPlane,
} from "./support/control-plane.ts";

export { authIndexOf, emptyKeyAuthIndexOf, unkeyedAuthIndexOf } from "./support/auth-index.ts";

export { documentText, mdModel } from "./support/models-dev.ts";

export { withModelsPart } from "./support/models-part.ts";

export { jsonResponse, loadConfig, makePipeline, postJson } from "./support/pipeline.ts";

export { makePool, MemoryPoolStore } from "./support/pool.ts";

export {
  type MockHandler,
  type MockReply,
  mockHttp,
  type RecordedRequest,
  routes,
} from "./support/refresh.ts";

export { asBeforeEncryption } from "./support/secrets.ts";

export { USD } from "./support/spend.ts";

export { HELD, spendingOrg, spendRows } from "./support/spending-org.ts";

export { resetUsageDb, sampleRecord, statementsOf } from "./support/usage.ts";

export { makeServiceAccount, type TestServiceAccount } from "./support/vertex.ts";

export { zstdRleBomb } from "./support/zstd.ts";

// --- fixtures ------------------------------------------------------------------------------------------------------

/** The Go `NormalizeServiceAccountMap` cases (test/fixtures/session.json, tools/fixturegen/session). */
export { default as sessionFixtures } from "./fixtures/session.json";

// --- Models' services with a replaced outbound HTTP client -----------------------------------------------------------

export { managementServicesWith } from "./support/management-services.ts";

// --- what the Worker's tests seed, read or call of Models ------------------------------------------------------------

export { decodeConfig, encodeConfig } from "../src/config/codec.ts";

export { ConfigStoreError } from "../src/config/errors.ts";

export { ConfigReader, ConfigSource } from "../src/config/reader.ts";

export { Config } from "../src/config/schema.ts";

export { MIGRATION_PRINCIPAL } from "../src/config/store.ts";

export { configKeyIds } from "../src/credentials/key-ids.ts";

export { emptyState } from "../src/credentials/model.ts";

export { FULL_ACCESS } from "../src/credentials/ownership.ts";

export { normalizePrivateKey } from "../src/credentials/refresh/vertex.ts";

export { unknownModelBody } from "../src/credentials/selection/failures.ts";

export { makeControlPlanePicker } from "../src/executor/control-plane-picker.ts";

export { loadVideoBinding, saveVideoBinding } from "../src/handlers/openai/video-binding.ts";

export { AuthIndexKeyError, orgAuthIndexer } from "../src/management/auth-index.ts";

export { LEASE_RENEW_INTERVAL_MS, runQuotaSweep, sweepQuotas } from "../src/quota/check.ts";

export { CLAUDE_PROFILE_URL, CLAUDE_USAGE_URL } from "../src/quota/claude.ts";

export { claimResetGrant } from "../src/quota/reset-grant-flow.ts";

export {
  parseResetGrantStatus,
  RESET_GRANT_STATUS_URL,
  resetGrantClaimUrl,
} from "../src/quota/reset-grants.ts";

export { CATALOG_KEYS } from "../src/registry/catalog-store.ts";

export { MODELS_DEV_URL } from "../src/registry/refresh.ts";

export { GROUP_BY, insertUsageRecord, listUsageRecords, summarizeUsage } from "../src/usage/d1.ts";

export { isolateSignatureCache } from "@commissary/translation/signature";

export {
  antigravityStateFor,
  makeMemoryAntigravityState,
} from "../src/executor/antigravity/state.ts";

export { loadAntigravityHints } from "../src/executor/antigravity/models.ts";

export { makeKvSignatureStore } from "../src/signature/store.ts";
