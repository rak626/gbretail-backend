-- Session revocation: User.tokenVersion embedded in JWTs as `tv`.
-- Bump to kill all sessions instantly (password change, status flip, revoke endpoint).
-- Existing rows start at 0, matching already-issued tokens that carry no `tv`.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 0;
