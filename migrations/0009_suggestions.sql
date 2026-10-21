-- Users who may not edit but can send suggested changes for an admin to review.
ALTER TABLE users ADD COLUMN suggester INTEGER NOT NULL DEFAULT 0;

-- A suggestion: a note and/or a list of edits (same format as offline edits), until an admin
-- applies or rejects it; either way it is then deleted.
CREATE TABLE suggestions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  person_id  INTEGER,
  message    TEXT NOT NULL DEFAULT '',
  ops        TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_suggestions_user ON suggestions(user_id);
