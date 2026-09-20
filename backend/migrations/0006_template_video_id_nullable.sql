-- SPEC-CLOUD.md §6: "supersedes SPEC.md §12's 'a video can only be
-- deleted if it has no template' guard entirely" — deleting a video's
-- template used to be a hard block (application-level), and the schema
-- backed that up with an implicit ON DELETE NO ACTION FK, which would
-- still raise a raw constraint-violation error even with the
-- application-level guard removed. `templates.video_id` gets the exact
-- same treatment `gifs.video_id` already has: nullable, ON DELETE SET
-- NULL — a template is a self-contained clipped asset (§4) that doesn't
-- need its source video to keep existing.
ALTER TABLE templates ALTER COLUMN video_id DROP NOT NULL;
ALTER TABLE templates DROP CONSTRAINT templates_video_id_fkey;
ALTER TABLE templates ADD CONSTRAINT templates_video_id_fkey
    FOREIGN KEY (video_id) REFERENCES videos (id) ON DELETE SET NULL;
