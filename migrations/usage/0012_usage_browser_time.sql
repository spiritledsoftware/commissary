-- Browser time (#214, ADR 0039): the browser toolkit's records carry the browser time they used, in milliseconds. A
-- Quick Action's call record holds what Browser Run reported for the call (`X-Browser-Ms-Used`); a browser session
-- writes one record of its own when it closes (`area = 'tools'`, its toolkit, no tool, no outcome, its id as
-- `request_id`), holding its browser time from opening to closing, whose cost (at the org's price per browser hour,
-- prorated) is its `cost_micros`, and `browser_profile_id` the browser profile it opened from (#215), `NULL` when it
-- opened from none. `NULL` on every other record. No record holds a URL, page content or a screenshot.
--
-- Forward only, like every migration here: code from before it ignores the column. Reverting the code to before it
-- leaves the sessions' records, which that code reads as tool calls of no tool; delete them first if that matters:
--   DELETE FROM usage_records WHERE area = 'tools' AND tool_id IS NULL AND browser_ms IS NOT NULL;
ALTER TABLE usage_records ADD COLUMN browser_ms INTEGER;
ALTER TABLE usage_records ADD COLUMN browser_profile_id TEXT;
