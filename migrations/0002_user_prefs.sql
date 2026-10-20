-- Per-user display preferences (JSON): name generations, tree orientation, note display.
ALTER TABLE users ADD COLUMN prefs TEXT NOT NULL DEFAULT '{}';
