-- Users & sessions -----------------------------------------------------------
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Family data ------------------------------------------------------------------
CREATE TABLE people (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name  TEXT NOT NULL,
  last_name   TEXT NOT NULL DEFAULT '',
  nickname    TEXT NOT NULL DEFAULT '',
  gender      TEXT NOT NULL CHECK (gender IN ('male', 'female')),
  birth_date  TEXT NOT NULL DEFAULT '',
  death_date  TEXT NOT NULL DEFAULT '',
  is_deceased INTEGER NOT NULL DEFAULT 0,
  birth_place TEXT NOT NULL DEFAULT '',
  photo_url   TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',
  father_id   INTEGER REFERENCES people(id) ON DELETE SET NULL,
  mother_id   INTEGER REFERENCES people(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_people_father ON people(father_id);
CREATE INDEX idx_people_mother ON people(mother_id);

CREATE TABLE marriages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  husband_id    INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  wife_id       INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'married' CHECK (status IN ('married', 'divorced', 'widowed')),
  marriage_date TEXT NOT NULL DEFAULT '',
  end_date      TEXT NOT NULL DEFAULT '',
  notes         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (husband_id, wife_id)
);
CREATE INDEX idx_marriages_wife ON marriages(wife_id);
