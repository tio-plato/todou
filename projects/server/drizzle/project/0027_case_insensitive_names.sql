-- Status and label names are now one name whatever their case or Unicode
-- composition, and are stored as NFC: "Done" and "done", or a name whose
-- accented letter is written as one code point and the same name with a
-- combining accent, can no longer stand side by side in a project. The
-- unique indexes now compare lower(name); this renames the rows that would
-- break them, then rebuilds them.
--
-- Rows are taken by id. One already in NFC that no earlier row of its project
-- matches under lower() keeps its name, so the first-created of names that
-- differ only in case keeps it, and of names that differ only in composition
-- the NFC one does, even if it came later. Every other row is written in NFC
-- and, if lower() then matches another row of its project, becomes
-- "<name> (<id>)", then "<name> (<id>-2)" and so on. As in canonical_names,
-- the suffix is not cut back to fit the 60-character limit, and composing
-- can lengthen a few names too. Rows of other projects never clash.
--
-- The clash test is the index's own expression, lower(name), so the index
-- always builds whatever the database's ctype. That ctype sets which letters
-- count as case: under C (or SQL_ASCII) only ASCII ones, and two names that
-- differ only in the case of an accented letter both stay. normalize()
-- exists from PostgreSQL 13 and only in a UTF8 database, so elsewhere names
-- are not composed and two that differ only in composition both stay.
--
-- Each table's old index is dropped first: DROP INDEX holds an exclusive
-- lock on the table until the upgrade commits, so no older server still
-- running can add a name the rename pass has not seen. A plain index on the
-- same expression stands in while the pass runs, so that each row's clash
-- test is an index lookup rather than a scan of a table that, in a shared
-- database, holds every project's rows.
DROP INDEX "statuses_project_name_idx";
--> statement-breakpoint
CREATE INDEX "statuses_project_name_fold" ON "statuses" USING btree ("project_id",lower("name"));
--> statement-breakpoint
DO $$
DECLARE
  nfc CONSTANT boolean := current_setting('server_encoding') = 'UTF8'
                          AND current_setting('server_version_num')::int >= 130000;
  r record;
  target text;
  candidate text;
  n int;
BEGIN
  FOR r IN SELECT id, project_id, name FROM statuses ORDER BY id LOOP
    IF nfc THEN
      target := normalize(r.name, NFC);
    ELSE
      target := r.name;
    END IF;
    CONTINUE WHEN target = r.name AND NOT EXISTS (
      SELECT 1 FROM statuses o
       WHERE o.project_id = r.project_id
         AND o.id < r.id
         AND lower(o.name) = lower(r.name));
    candidate := target;
    n := 1;
    WHILE EXISTS (SELECT 1 FROM statuses o
                   WHERE o.project_id = r.project_id
                     AND o.id <> r.id
                     AND lower(o.name) = lower(candidate)) LOOP
      candidate := target || ' (' || r.id
                   || CASE WHEN n > 1 THEN '-' || n ELSE '' END || ')';
      n := n + 1;
    END LOOP;
    IF candidate <> r.name THEN
      UPDATE statuses SET name = candidate WHERE id = r.id;
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
DROP INDEX "statuses_project_name_fold";
--> statement-breakpoint
CREATE UNIQUE INDEX "statuses_project_name_idx" ON "statuses" USING btree ("project_id",lower("name"));
--> statement-breakpoint
DROP INDEX "labels_project_name_idx";
--> statement-breakpoint
CREATE INDEX "labels_project_name_fold" ON "labels" USING btree ("project_id",lower("name"));
--> statement-breakpoint
DO $$
DECLARE
  nfc CONSTANT boolean := current_setting('server_encoding') = 'UTF8'
                          AND current_setting('server_version_num')::int >= 130000;
  r record;
  target text;
  candidate text;
  n int;
BEGIN
  FOR r IN SELECT id, project_id, name FROM labels ORDER BY id LOOP
    IF nfc THEN
      target := normalize(r.name, NFC);
    ELSE
      target := r.name;
    END IF;
    CONTINUE WHEN target = r.name AND NOT EXISTS (
      SELECT 1 FROM labels o
       WHERE o.project_id = r.project_id
         AND o.id < r.id
         AND lower(o.name) = lower(r.name));
    candidate := target;
    n := 1;
    WHILE EXISTS (SELECT 1 FROM labels o
                   WHERE o.project_id = r.project_id
                     AND o.id <> r.id
                     AND lower(o.name) = lower(candidate)) LOOP
      candidate := target || ' (' || r.id
                   || CASE WHEN n > 1 THEN '-' || n ELSE '' END || ')';
      n := n + 1;
    END LOOP;
    IF candidate <> r.name THEN
      UPDATE labels SET name = candidate WHERE id = r.id;
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
DROP INDEX "labels_project_name_fold";
--> statement-breakpoint
CREATE UNIQUE INDEX "labels_project_name_idx" ON "labels" USING btree ("project_id",lower("name"));
