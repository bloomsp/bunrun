-- Areas: add min staffing requirements + rename labels
PRAGMA foreign_keys=ON;

ALTER TABLE areas ADD COLUMN min_staff INTEGER NOT NULL DEFAULT 0;

-- Rename labels
UPDATE areas SET label='Door' WHERE key='front-door';
UPDATE areas SET label='Nursery Greeter' WHERE key='greeters';

-- Set minimum staffing
UPDATE areas SET min_staff=1 WHERE key IN (
  'service-desk',
  'tool-shop',
  'nursery',
  'cafe',
  'car-park',
  'front-door',
  'greeters'
);
UPDATE areas SET min_staff=2 WHERE key IN ('registers');
