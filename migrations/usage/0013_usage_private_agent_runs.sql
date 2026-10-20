-- Private agent runs' records (#228, ADR 0040): a private agent's run is its member's alone, as private-credential
-- traffic is, so its records are written `private = 1` and left out of org-wide reads. The records #227 wrote before
-- that are marked here: a run's record (`agent_id`) that names a member (`member_id`, which only a private agent's run
-- acts as; a shared agent's run names none).
--
-- Forward only, like every migration here: code from before it reads the records as their member's private traffic.
UPDATE usage_records SET private = 1
WHERE agent_id IS NOT NULL AND member_id IS NOT NULL AND private = 0;
