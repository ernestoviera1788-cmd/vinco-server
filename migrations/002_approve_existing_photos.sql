-- 002: approve all pending profile photos.
-- Photos are now auto-approved on upload (see profile.ts); this one-time
-- backfill clears the backlog so existing users' photos become visible.
UPDATE profile_photos SET status = 'approved' WHERE status = 'pending';
