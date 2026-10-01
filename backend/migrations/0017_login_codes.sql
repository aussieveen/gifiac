-- Email one-time-passcode login (SPEC-EMAIL-AUTH.md §2). One row per
-- requested code. `code_hash` is HMAC-SHA256(LOGIN_CODE_HMAC_KEY, email +
-- ":" + code), hex-encoded — the plaintext code is never stored: a
-- 6-digit space is brute-forceable offline in milliseconds against a
-- plain unkeyed hash.
CREATE TABLE login_codes (
    id          TEXT PRIMARY KEY,
    email       TEXT NOT NULL,
    code_hash   TEXT NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    request_ip  TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    consumed_at TEXT
);

CREATE INDEX idx_login_codes_email_created_at ON login_codes (email, created_at);
CREATE INDEX idx_login_codes_ip_created_at ON login_codes (request_ip, created_at);

-- `users.email` (0003_user_profile_fields.sql) had no uniqueness
-- constraint — email-login account resolution and Google/email identity
-- linking (SPEC-EMAIL-AUTH.md §5) both depend on at most one user owning
-- a given address. Partial (`WHERE email IS NOT NULL`) since most users
-- predate this column being populated for everyone.
CREATE UNIQUE INDEX idx_users_email_unique ON users (email) WHERE email IS NOT NULL;
