-- Per-user data access: a branch the user belongs to (and may edit, for editors), and how many
-- generations of the rest of the tree they may see. NULL = no restriction.
ALTER TABLE users ADD COLUMN branch_root_id INTEGER;
ALTER TABLE users ADD COLUMN visible_gens INTEGER;
