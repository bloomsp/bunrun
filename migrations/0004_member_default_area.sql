-- Members: default/home area preference (used as default when adding shifts)
PRAGMA foreign_keys=ON;

ALTER TABLE members ADD COLUMN default_area_key TEXT;

-- Optional FK constraint can't be added via ALTER TABLE easily in SQLite/D1.
-- We enforce valid keys in application logic.
