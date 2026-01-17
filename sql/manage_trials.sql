-- ============================================================
-- Trial Management SQL Scripts
-- ============================================================

-- 1. Check current trial status for all clients
-- ============================================================
SELECT
    id,
    company_name,
    email,
    status,
    image_credits,
    trial_ends_at,
    CASE
        WHEN trial_ends_at IS NULL THEN '❌ No Trial'
        WHEN trial_ends_at > NOW() THEN '✅ Active Trial'
        ELSE '⏰ Expired'
    END as trial_status,
    CASE
        WHEN trial_ends_at > NOW() THEN EXTRACT(DAY FROM (trial_ends_at - NOW()))::INTEGER
        ELSE NULL
    END as days_remaining,
    created_at
FROM clients
ORDER BY trial_ends_at DESC NULLS LAST;


-- 2. Set 1-month trial for a specific client
-- ============================================================
-- Replace 'client@example.com' with actual email
UPDATE clients
SET trial_ends_at = NOW() + INTERVAL '30 days'
WHERE email = 'client@example.com'
RETURNING company_name, email, trial_ends_at;


-- 3. Set 1-month trial for ALL existing clients without trial
-- ============================================================
-- USE WITH CAUTION! This gives trial to all existing clients
UPDATE clients
SET trial_ends_at = created_at + INTERVAL '30 days'
WHERE trial_ends_at IS NULL
  AND status = 'active'
  AND created_at > '2025-01-01'  -- Only for recent signups
RETURNING company_name, email, trial_ends_at;


-- 4. Extend trial by 7 days for specific client
-- ============================================================
-- Replace 'client@example.com' with actual email
UPDATE clients
SET trial_ends_at = COALESCE(trial_ends_at, NOW()) + INTERVAL '7 days'
WHERE email = 'client@example.com'
RETURNING company_name, email, trial_ends_at;


-- 5. Expire trial immediately (for testing)
-- ============================================================
-- Replace 'client@example.com' with actual email
UPDATE clients
SET trial_ends_at = NOW() - INTERVAL '1 day'
WHERE email = 'client@example.com'
RETURNING company_name, email, trial_ends_at;


-- 6. Remove trial (convert to credit-only)
-- ============================================================
-- Replace 'client@example.com' with actual email
UPDATE clients
SET trial_ends_at = NULL
WHERE email = 'client@example.com'
RETURNING company_name, email, trial_ends_at;


-- 7. Find clients with active trials
-- ============================================================
SELECT
    company_name,
    email,
    trial_ends_at,
    EXTRACT(DAY FROM (trial_ends_at - NOW()))::INTEGER as days_remaining,
    image_credits
FROM clients
WHERE trial_ends_at > NOW()
ORDER BY trial_ends_at ASC;


-- 8. Find clients whose trial expired recently (last 7 days)
-- ============================================================
SELECT
    company_name,
    email,
    trial_ends_at,
    EXTRACT(DAY FROM (NOW() - trial_ends_at))::INTEGER as days_since_expired,
    image_credits
FROM clients
WHERE trial_ends_at < NOW()
  AND trial_ends_at > NOW() - INTERVAL '7 days'
ORDER BY trial_ends_at DESC;


-- 9. Get trial statistics
-- ============================================================
SELECT
    COUNT(*) FILTER (WHERE trial_ends_at > NOW()) as active_trials,
    COUNT(*) FILTER (WHERE trial_ends_at < NOW()) as expired_trials,
    COUNT(*) FILTER (WHERE trial_ends_at IS NULL) as no_trial,
    COUNT(*) as total_clients
FROM clients
WHERE status = 'active';


-- 10. Add trial to specific client with custom duration
-- ============================================================
-- Replace 'client@example.com' and duration as needed
UPDATE clients
SET trial_ends_at = NOW() + INTERVAL '60 days'  -- 2 months
WHERE email = 'client@example.com'
RETURNING company_name, email, trial_ends_at;


-- 11. Find clients who might abuse trial (many renders during trial)
-- ============================================================
-- Note: You need to add a trial_renders_used column first
-- ALTER TABLE clients ADD COLUMN IF NOT EXISTS trial_renders_used INTEGER DEFAULT 0;

-- This is a placeholder query - actual implementation would require
-- tracking renders in a separate table or adding a counter column


-- 12. Reset credits for all clients after trial expires
-- ============================================================
-- Gives 100 credits to clients whose trial just expired
UPDATE clients
SET image_credits = image_credits + 100
WHERE trial_ends_at < NOW()
  AND trial_ends_at > NOW() - INTERVAL '1 day'
  AND status = 'active'
RETURNING company_name, email, image_credits;


-- 13. Create a test client with active trial
-- ============================================================
INSERT INTO clients (
    api_key,
    company_name,
    email,
    status,
    image_credits,
    trial_ends_at
)
VALUES (
    'test_' || FLOOR(RANDOM() * 1000000)::TEXT,
    'Test Company - Trial Active',
    'test_trial_' || FLOOR(RANDOM() * 1000000)::TEXT || '@example.com',
    'active',
    0,  -- Zero credits during trial
    NOW() + INTERVAL '30 days'
)
RETURNING *;


-- 14. Create a test client with expired trial
-- ============================================================
INSERT INTO clients (
    api_key,
    company_name,
    email,
    status,
    image_credits,
    trial_ends_at
)
VALUES (
    'test_' || FLOOR(RANDOM() * 1000000)::TEXT,
    'Test Company - Trial Expired',
    'test_expired_' || FLOOR(RANDOM() * 1000000)::TEXT || '@example.com',
    'active',
    50,  -- Some credits for post-trial testing
    NOW() - INTERVAL '5 days'
)
RETURNING *;


-- 15. Delete all test clients
-- ============================================================
DELETE FROM clients
WHERE email LIKE 'test_%@example.com'
RETURNING company_name, email;
