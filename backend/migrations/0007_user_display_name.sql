-- SPEC-CLOUD.md §5: the handle picker pre-fills its suggestion from the
-- Google display name — captured here alongside email/avatar_url
-- (0003_user_profile_fields.sql), refreshed on every login the same way.
ALTER TABLE users ADD COLUMN display_name TEXT;
