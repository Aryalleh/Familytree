-- Version control: every person and marriage carries a version that goes up with each change,
-- and every change is recorded with the full record after it (so any version can be compared,
-- merged against or restored).
ALTER TABLE people ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE marriages ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE history (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  entity    TEXT NOT NULL CHECK (entity IN ('person', 'marriage')),
  entity_id INTEGER NOT NULL,
  version   INTEGER NOT NULL,
  action    TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'restore')),
  user_id   INTEGER,
  user_name TEXT NOT NULL DEFAULT '',
  at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  changed   TEXT NOT NULL DEFAULT '[]',
  data      TEXT NOT NULL
);
CREATE INDEX idx_history_entity ON history(entity, entity_id, version);
CREATE INDEX idx_history_at ON history(id DESC);

-- baseline: today's data is version 1
INSERT INTO history (entity, entity_id, version, action, data)
  SELECT 'person', id, 1, 'create', json_object(
    'first_name', first_name, 'last_name', last_name, 'nickname', nickname, 'gender', gender,
    'birth_date', birth_date, 'death_date', death_date, 'is_deceased', is_deceased,
    'birth_place', birth_place, 'photo_url', photo_url, 'notes', notes,
    'father_id', father_id, 'mother_id', mother_id, 'clan_id', clan_id)
  FROM people;
INSERT INTO history (entity, entity_id, version, action, data)
  SELECT 'marriage', id, 1, 'create', json_object(
    'husband_id', husband_id, 'wife_id', wife_id, 'status', status,
    'marriage_date', marriage_date, 'end_date', end_date, 'notes', notes)
  FROM marriages;
