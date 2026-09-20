-- Auth (SPEC-CLOUD.md §2) needs somewhere to put what Google's OAuth
-- payload actually returns: §5 says the profile page's avatar comes
-- "directly from the Google OAuth payload", and admin (§6) needs to
-- identify a user before they've picked a handle — neither `email` nor
-- `avatar_url` exists on `users` in the schema as originally written, so
-- this adds both here rather than deferring to the profiles ticket (M5).
-- Both are nullable and refreshed from the OAuth payload on every login.
ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN avatar_url TEXT;
