-- Add member area restrictions
PRAGMA foreign_keys=ON;

-- Add all_areas flag (1 = can work any area)
ALTER TABLE members ADD COLUMN all_areas INTEGER NOT NULL DEFAULT 1;

-- If all_areas=0, allowed areas are enumerated here.
CREATE TABLE IF NOT EXISTS member_area_permissions (
  member_id INTEGER NOT NULL,
  area_key TEXT NOT NULL,
  PRIMARY KEY (member_id, area_key),
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
  FOREIGN KEY (area_key) REFERENCES areas(key) ON DELETE CASCADE
);
