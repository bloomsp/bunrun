-- Bunrun D1 schema (MVP)

PRAGMA foreign_keys=ON;

-- Enumerations (kept as tables for easy UI use)
CREATE TABLE IF NOT EXISTS areas (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS statuses (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  blocks_coverage INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Schedule day
CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE, -- YYYY-MM-DD local
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A member working on a given schedule day
CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id INTEGER NOT NULL,
  member_id INTEGER NOT NULL,
  home_area_key TEXT NOT NULL,
  status_key TEXT NOT NULL DEFAULT 'working',
  start_time TEXT NOT NULL, -- HH:MM (24h)
  shift_minutes INTEGER NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE RESTRICT,
  FOREIGN KEY (home_area_key) REFERENCES areas(key) ON DELETE RESTRICT,
  FOREIGN KEY (status_key) REFERENCES statuses(key) ON DELETE RESTRICT,

  UNIQUE (schedule_id, member_id)
);

-- Breaks within a shift
CREATE TABLE IF NOT EXISTS breaks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id INTEGER NOT NULL,
  start_time TEXT NOT NULL, -- HH:MM
  duration_minutes INTEGER NOT NULL,
  cover_member_id INTEGER, -- nullable until assigned
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE CASCADE,
  FOREIGN KEY (cover_member_id) REFERENCES members(id) ON DELETE SET NULL
);

-- Seed areas
INSERT OR IGNORE INTO areas (key, label) VALUES
  ('service-desk', 'Service Desk'),
  ('tool-shop', 'Tool Shop'),
  ('registers', 'Registers'),
  ('nursery', 'Nursery'),
  ('cafe', 'Cafe'),
  ('car-park', 'Car Park'),
  ('front-door', 'Front Door'),
  ('greeters', 'Greeters');

-- Seed statuses
INSERT OR IGNORE INTO statuses (key, label, blocks_coverage) VALUES
  ('working', 'Working', 0),
  ('sick', 'Sick', 1),
  ('training', 'Training', 1),
  ('crc', 'CRC', 1),
  ('stocking', 'Stocking', 1);

-- Seed members (active)
INSERT OR IGNORE INTO members (name, active) VALUES
  ('Angela', 1),
  ('Billie', 1),
  ('Casey', 1),
  ('Dani', 1),
  ('Deb', 1),
  ('Gracie', 1),
  ('Griffin', 1),
  ('Isaiah', 1),
  ('Isobelle', 1),
  ('Jaiden', 1),
  ('Jason', 1),
  ('Mikki', 1),
  ('Raygene', 1),
  ('Sally', 1),
  ('Steven', 1),
  ('Tarsh', 1),
  ('Tina', 1),
  ('Wayne', 1),
  ('Will', 1);
