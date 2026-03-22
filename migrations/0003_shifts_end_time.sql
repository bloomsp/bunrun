-- Shifts: store explicit end time (HH:MM) as entered by coordinator
PRAGMA foreign_keys=ON;

ALTER TABLE shifts ADD COLUMN end_time TEXT;

-- Backfill if needed (leave NULL for existing rows; future writes should set it)
