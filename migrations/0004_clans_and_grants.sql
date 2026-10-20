-- Clans (طایفه‌ها): every person belongs to one. Existing people go into a default clan.
CREATE TABLE clans (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO clans (id, name) VALUES (1, 'خاندان اصلی');
ALTER TABLE people ADD COLUMN clan_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX idx_people_clan ON people(clan_id);

-- Access groups and grants. A grant belongs to a user or to a group:
--   clan_id  NULL = every clan
--   root_id  NULL = the whole clan; otherwise that person's branch (them, descendants, spouses)
--   level    view | edit (add + edit) | delete (add + edit + delete)
--   max_gen  NULL = all generations; otherwise only down to that generation
CREATE TABLE access_groups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT ''
);
CREATE TABLE user_groups (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES access_groups(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, group_id)
);
CREATE TABLE grants (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id  INTEGER REFERENCES users(id) ON DELETE CASCADE,
  group_id INTEGER REFERENCES access_groups(id) ON DELETE CASCADE,
  clan_id  INTEGER,
  root_id  INTEGER,
  level    TEXT NOT NULL CHECK (level IN ('view', 'edit', 'delete')),
  max_gen  INTEGER,
  CHECK ((user_id IS NULL) <> (group_id IS NULL))
);
CREATE INDEX idx_grants_user ON grants(user_id);
CREATE INDEX idx_grants_group ON grants(group_id);

-- Carry over the per-user access from 0003 (branch + "rest of the tree down to generation n").
INSERT INTO grants (user_id, root_id, level)
  SELECT id, branch_root_id, CASE role WHEN 'editor' THEN 'delete' ELSE 'view' END
  FROM users WHERE role != 'admin' AND branch_root_id IS NOT NULL;
INSERT INTO grants (user_id, level, max_gen)
  SELECT id, CASE WHEN role = 'editor' AND branch_root_id IS NULL THEN 'delete' ELSE 'view' END, visible_gens
  FROM users WHERE role != 'admin' AND (visible_gens IS NULL OR visible_gens > 0);
