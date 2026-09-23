-- Reverts SPEC-CLOUD.md §4/§8's cross-user template sharing: too many
-- real problems surfaced in practice (locked-caption enforcement gaps,
-- confusing UX) relative to the value, and the decision was made to make
-- templates strictly private to their creator again — no public/private
-- state, no Global Library listing, no cross-user "use this template"
-- export. The original SPEC.md §12 single-user mechanism (a video's own
-- saved export template — GET/PUT/DELETE /api/videos/{id}/template) is
-- unaffected; this only removes the sharing layer 0008 added on top of it.
ALTER TABLE templates DROP COLUMN is_public;
ALTER TABLE templates DROP COLUMN use_count;

-- gifs.template_id tracked lineage from a cross-user "use this template"
-- export — with that flow gone, it can only ever be NULL going forward.
ALTER TABLE gifs DROP COLUMN template_id;
