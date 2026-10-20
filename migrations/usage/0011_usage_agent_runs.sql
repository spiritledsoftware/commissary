-- Agent runs (#227, ADR 0040): a record a hosted agent's run causes (a model attempt or a tool call) names the run's
-- agent, the run, and who started it (`member:<member id>`; child runs, #229, will write `run:<run id>`, and runs no one
-- started, #231, nothing). The principal of such a record is the run's (`run:<run id>`), and `member_id` is the member a
-- private agent's run acts as. `NULL` on every other record. Filtering the usage reads by them, and the records of
-- browser and computer time, come with #228.
--
-- Forward only, like every migration here: code from before it ignores the columns.
ALTER TABLE usage_records ADD COLUMN agent_id TEXT;
ALTER TABLE usage_records ADD COLUMN run_id TEXT;
ALTER TABLE usage_records ADD COLUMN starter TEXT;
