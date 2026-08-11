-- Basic brute-force resistance for the single login endpoint. Flagged in
-- a pre-public-repo security review: scrypt's cost alone isn't a
-- meaningful deterrent against a horizontally-scaled Vercel Function
-- attacker, and login is now internet-reachable with its exact auth flow
-- publicly documented. A simple escalating lockout keyed by username is
-- adequate for a single-household app — not a general-purpose rate
-- limiter, and deliberately not per-IP (Vercel Functions don't give a
-- trustworthy client IP without extra config, and per-username is enough
-- protection for a one-account app).

alter table users
  add column failed_login_count integer not null default 0,
  add column locked_until timestamptz;
