USE tutoriq;
-- Add an active/inactive flag for accounts (deactivated users cannot log in).
ALTER TABLE users
  ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1;
