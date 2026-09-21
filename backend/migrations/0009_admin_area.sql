-- Admin area (SPEC-CLOUD.md §7): the one urgent action if a bad actor
-- shows up, cheap to spec now rather than needing an emergency DB edit.
ALTER TABLE users ADD COLUMN disabled BOOLEAN NOT NULL DEFAULT false;
