PRAGMA foreign_keys=ON;

ALTER TABLE members ADD COLUMN break_preference TEXT NOT NULL DEFAULT '15+30';

CREATE TABLE IF NOT EXISTS shift_cover_priorities (
  shift_id INTEGER NOT NULL,
  member_id INTEGER NOT NULL,
  priority INTEGER NOT NULL,
  PRIMARY KEY (shift_id, priority),
  UNIQUE (shift_id, member_id),
  FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
);

CREATE INDEX idx_shift_cover_priorities_shift ON shift_cover_priorities (shift_id, priority);
