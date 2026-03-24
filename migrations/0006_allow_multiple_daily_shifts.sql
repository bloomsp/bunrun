PRAGMA foreign_keys=OFF;

CREATE TABLE shifts_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id INTEGER NOT NULL,
  member_id INTEGER NOT NULL,
  home_area_key TEXT NOT NULL,
  status_key TEXT NOT NULL DEFAULT 'working',
  start_time TEXT NOT NULL,
  shift_minutes INTEGER NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  end_time TEXT,

  FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE RESTRICT,
  FOREIGN KEY (home_area_key) REFERENCES areas(key) ON DELETE RESTRICT,
  FOREIGN KEY (status_key) REFERENCES statuses(key) ON DELETE RESTRICT
);

INSERT INTO shifts_new (
  id, schedule_id, member_id, home_area_key, status_key, start_time, shift_minutes, notes, created_at, end_time
)
SELECT
  id, schedule_id, member_id, home_area_key, status_key, start_time, shift_minutes, notes, created_at, end_time
FROM shifts;

DROP TABLE shifts;
ALTER TABLE shifts_new RENAME TO shifts;

CREATE INDEX idx_shifts_schedule_member ON shifts (schedule_id, member_id);
CREATE INDEX idx_shifts_schedule_status ON shifts (schedule_id, status_key);
CREATE INDEX idx_shifts_schedule_time ON shifts (schedule_id, start_time, end_time);

PRAGMA foreign_keys=ON;
