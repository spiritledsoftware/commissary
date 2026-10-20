-- Tool calls (#199, ADR 0038): one usage record per call of Commissary's MCP endpoint, in this table beside the model
-- attempts, so retention (`usage-retention`) and org deletion cover them with the same statements. `area` tells them
-- apart: `models` for every record written before (the default) and every model attempt, `tools` for a tool call. A
-- tool call's record names its toolkit and the tool's stable id (`<toolkit id>:<upstream name>`), its outcome
-- (`success`, `tool_error`, `upstream_failure`, `refused`, `needs_credential`), the sizes in bytes of the call's
-- arguments and of its result, and its approval (empty until approvals exist, #201). It holds no arguments and no
-- results. The token, provider and model columns stay empty or at their defaults on a tool call's record; `auth_id` is
-- empty and `auth_type` holds which of the toolkit's credentials served the call (`shared` or `private`, empty when none
-- did).
--
-- Forward only, like every migration here: nothing drops these columns. Code from before this migration reads every
-- record as a model attempt, so reverting the code to it means first deleting the tool calls' records:
--   DELETE FROM usage_records WHERE area = 'tools';
-- The new columns and indexes may stay (the older code ignores them); its export queue reads without the index this
-- drops, so recreate that for speed:
--   CREATE INDEX IF NOT EXISTS usage_records_org_unexported ON usage_records (org_id, requested_at)
--     WHERE exported_at IS NULL;
ALTER TABLE usage_records ADD COLUMN area TEXT NOT NULL DEFAULT 'models';
ALTER TABLE usage_records ADD COLUMN toolkit_id TEXT;
ALTER TABLE usage_records ADD COLUMN tool_id TEXT;
ALTER TABLE usage_records ADD COLUMN tool_outcome TEXT;
ALTER TABLE usage_records ADD COLUMN request_bytes INTEGER;
ALTER TABLE usage_records ADD COLUMN response_bytes INTEGER;
ALTER TABLE usage_records ADD COLUMN approval TEXT;
-- The usage export (`.../usage/queue`) keeps the Go server's shape: it hands out model attempts only, and a tool call's
-- record is never marked exported. The queue's index covers what it reads, so the tool calls it skips are not scanned.
DROP INDEX IF EXISTS usage_records_org_unexported;
CREATE INDEX IF NOT EXISTS usage_records_org_unexported_models ON usage_records (org_id, requested_at)
  WHERE exported_at IS NULL AND area = 'models';
-- The reads of one area: model-only consumers read `area = 'models'` by default.
CREATE INDEX IF NOT EXISTS usage_records_org_area ON usage_records (org_id, area, requested_at);
