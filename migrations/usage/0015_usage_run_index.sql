-- The cost of agent runs (#234): the panel's run list and run page sum each run's records (`runCosts`,
-- `packages/models/src/usage/d1.ts`), by org and run id. A partial index over the records that name a run, so the sum
-- reads only those, however many records the org has; every other record (`run_id` NULL) stays out of it.
--
-- Forward only, like every migration here: code from before it never reads by run id this way, and the index changes
-- no result. Reverting needs nothing; to drop it: DROP INDEX IF EXISTS usage_records_org_run;
CREATE INDEX IF NOT EXISTS usage_records_org_run ON usage_records (org_id, run_id) WHERE run_id IS NOT NULL;
