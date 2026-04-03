CREATE TABLE IF NOT EXISTS work_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id INTEGER NOT NULL,
  member_id INTEGER NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  total_minutes INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS work_blocks_schedule_member_idx
  ON work_blocks (schedule_id, member_id, start_time);

ALTER TABLE shifts ADD COLUMN work_block_id INTEGER REFERENCES work_blocks(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS shifts_work_block_idx ON shifts (work_block_id);

ALTER TABLE breaks ADD COLUMN work_block_id INTEGER REFERENCES work_blocks(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS breaks_work_block_idx ON breaks (work_block_id);

WITH ordered AS (
  SELECT
    s.id,
    s.schedule_id,
    s.member_id,
    s.status_key,
    s.start_time,
    s.end_time,
    s.shift_minutes,
    CASE
      WHEN s.status_key <> 'working' THEN 1
      WHEN LAG(s.status_key) OVER (
        PARTITION BY s.schedule_id, s.member_id
        ORDER BY s.start_time, s.id
      ) <> 'working' THEN 1
      WHEN LAG(s.end_time) OVER (
        PARTITION BY s.schedule_id, s.member_id
        ORDER BY s.start_time, s.id
      ) IS NULL THEN 1
      WHEN LAG(s.end_time) OVER (
        PARTITION BY s.schedule_id, s.member_id
        ORDER BY s.start_time, s.id
      ) <> s.start_time THEN 1
      ELSE 0
    END AS starts_new
  FROM shifts s
),
working_groups AS (
  SELECT
    id,
    schedule_id,
    member_id,
    start_time,
    end_time,
    shift_minutes,
    SUM(starts_new) OVER (
      PARTITION BY schedule_id, member_id
      ORDER BY start_time, id
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS grp
  FROM ordered
  WHERE status_key = 'working'
),
block_rows AS (
  SELECT
    schedule_id,
    member_id,
    grp,
    MIN(start_time) AS start_time,
    MAX(end_time) AS end_time,
    SUM(shift_minutes) AS total_minutes
  FROM working_groups
  GROUP BY schedule_id, member_id, grp
)
INSERT INTO work_blocks (schedule_id, member_id, start_time, end_time, total_minutes)
SELECT schedule_id, member_id, start_time, end_time, total_minutes
FROM block_rows;

WITH ordered AS (
  SELECT
    s.id,
    s.schedule_id,
    s.member_id,
    s.status_key,
    s.start_time,
    s.end_time,
    CASE
      WHEN s.status_key <> 'working' THEN 1
      WHEN LAG(s.status_key) OVER (
        PARTITION BY s.schedule_id, s.member_id
        ORDER BY s.start_time, s.id
      ) <> 'working' THEN 1
      WHEN LAG(s.end_time) OVER (
        PARTITION BY s.schedule_id, s.member_id
        ORDER BY s.start_time, s.id
      ) IS NULL THEN 1
      WHEN LAG(s.end_time) OVER (
        PARTITION BY s.schedule_id, s.member_id
        ORDER BY s.start_time, s.id
      ) <> s.start_time THEN 1
      ELSE 0
    END AS starts_new
  FROM shifts s
),
working_groups AS (
  SELECT
    id,
    schedule_id,
    member_id,
    start_time,
    end_time,
    SUM(starts_new) OVER (
      PARTITION BY schedule_id, member_id
      ORDER BY start_time, id
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS grp
  FROM ordered
  WHERE status_key = 'working'
)
UPDATE shifts
SET work_block_id = (
  SELECT wb.id
  FROM working_groups wg
  JOIN work_blocks wb
    ON wb.schedule_id = wg.schedule_id
   AND wb.member_id = wg.member_id
   AND wb.start_time = (
     SELECT MIN(start_time)
     FROM working_groups wg2
     WHERE wg2.schedule_id = wg.schedule_id
       AND wg2.member_id = wg.member_id
       AND wg2.grp = wg.grp
   )
   AND wb.end_time = (
     SELECT MAX(end_time)
     FROM working_groups wg3
     WHERE wg3.schedule_id = wg.schedule_id
       AND wg3.member_id = wg.member_id
       AND wg3.grp = wg.grp
   )
  WHERE wg.id = shifts.id
)
WHERE status_key = 'working';

UPDATE breaks
SET work_block_id = (
  SELECT s.work_block_id
  FROM shifts s
  WHERE s.id = breaks.shift_id
)
WHERE EXISTS (
  SELECT 1
  FROM shifts s
  WHERE s.id = breaks.shift_id
    AND s.work_block_id IS NOT NULL
);
