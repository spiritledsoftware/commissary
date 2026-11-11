-- Hosted agents are removed (ADR 0048, #449): no record names an agent, a run or a starter any more, and the release before
-- this one stopped writing and reading the columns of `0011_usage_agent_runs.sql`. They go now, a release later,
-- because D1 migrations apply before the Workers deploy: an API Worker from before the removal still wrote them.
-- The partial index of `0015_usage_run_index.sql` goes first, as SQLite refuses to drop a column an index names.
--
-- Forward only, like every migration here: code since the removal neither writes nor reads them.
DROP INDEX IF EXISTS usage_records_org_run;
ALTER TABLE usage_records DROP COLUMN agent_id;
ALTER TABLE usage_records DROP COLUMN run_id;
ALTER TABLE usage_records DROP COLUMN starter;
