-- Status and label names stored before they were kept canonical (trimmed,
-- runs of whitespace collapsed to one space) may still hold " Done" or
-- "In  Review": the CLI's list filters trim each name they are given and can
-- never select the first, and both sit beside names the API now treats as
-- the same one. This rewrites each such name to its canonical form.
--
-- Whitespace is the explicit set JavaScript's \s and trim() match, not
-- PostgreSQL's \s, which follows the database locale. Outside UTF8 only the
-- ASCII part of it is used: there an escape such as \u00a0 matches a byte,
-- and byte 0xA0 is part of a multi-byte character in SQL_ASCII (the "a" with
-- a grave accent among them) or another character in an encoding such as
-- KOI8-R, so the wider class would garble the name. The classes are E''
-- strings with doubled backslashes so that the regular expression engine
-- reads the escapes whatever standard_conforming_strings says: with it off,
-- a plain string would have them decoded first, which fails outside UTF8.
--
-- A canonical name always stays as it is. A row whose canonical name another
-- row of the same project already holds becomes "<name> (<id>)", then
-- "<name> (<id>-2)" and so on; a name that is all whitespace becomes
-- "Status <id>" or "Label <id>". The suffix is not cut back to fit the
-- 60-character limit, as 0013 does not cut its own: a longer name still
-- lists, works and can be renamed, and docs/deploy.md says what it holds up
-- until then.
--
-- An older server may still be writing while this runs. A name another
-- session commits after the clash check saw it free makes the rename trip
-- the unique index; the rename is then worked out again, now that the other
-- row is visible, up to three times before the error stands. A row another
-- session renamed meanwhile keeps the name that session gave it. A write of
-- the canonical name that races a rename can fail on the writer's side.
DO $$
DECLARE
  utf8 CONSTANT boolean := current_setting('server_encoding') = 'UTF8';
  ws text;
  r record;
  target text;
  suffix text;
  candidate text;
  n int;
  tries int;
BEGIN
  IF utf8 THEN
    ws := E'[\\u0009-\\u000d\\u0020\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]';
  ELSE
    ws := E'[\\u0009-\\u000d\\u0020]';
  END IF;
  FOR r IN SELECT id, project_id, name FROM statuses ORDER BY id LOOP
    target := regexp_replace(
      regexp_replace(r.name, '^' || ws || '+|' || ws || '+$', '', 'g'),
      ws || '+', ' ', 'g');
    CONTINUE WHEN target = r.name;
    IF target = '' THEN target := 'Status ' || r.id; END IF;
    tries := 0;
    LOOP
      candidate := target;
      n := 1;
      WHILE EXISTS (SELECT 1 FROM statuses o
                     WHERE o.project_id = r.project_id
                       AND o.id <> r.id
                       AND o.name = candidate) LOOP
        suffix := ' (' || r.id
                  || CASE WHEN n > 1 THEN '-' || n ELSE '' END || ')';
        candidate := target || suffix;
        n := n + 1;
      END LOOP;
      BEGIN
        UPDATE statuses SET name = candidate WHERE id = r.id AND name = r.name;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        tries := tries + 1;
        IF tries >= 3 THEN RAISE; END IF;
      END;
    END LOOP;
  END LOOP;
END $$;
--> statement-breakpoint
DO $$
DECLARE
  utf8 CONSTANT boolean := current_setting('server_encoding') = 'UTF8';
  ws text;
  r record;
  target text;
  suffix text;
  candidate text;
  n int;
  tries int;
BEGIN
  IF utf8 THEN
    ws := E'[\\u0009-\\u000d\\u0020\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]';
  ELSE
    ws := E'[\\u0009-\\u000d\\u0020]';
  END IF;
  FOR r IN SELECT id, project_id, name FROM labels ORDER BY id LOOP
    target := regexp_replace(
      regexp_replace(r.name, '^' || ws || '+|' || ws || '+$', '', 'g'),
      ws || '+', ' ', 'g');
    CONTINUE WHEN target = r.name;
    IF target = '' THEN target := 'Label ' || r.id; END IF;
    tries := 0;
    LOOP
      candidate := target;
      n := 1;
      WHILE EXISTS (SELECT 1 FROM labels o
                     WHERE o.project_id = r.project_id
                       AND o.id <> r.id
                       AND o.name = candidate) LOOP
        suffix := ' (' || r.id
                  || CASE WHEN n > 1 THEN '-' || n ELSE '' END || ')';
        candidate := target || suffix;
        n := n + 1;
      END LOOP;
      BEGIN
        UPDATE labels SET name = candidate WHERE id = r.id AND name = r.name;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        tries := tries + 1;
        IF tries >= 3 THEN RAISE; END IF;
      END;
    END LOOP;
  END LOOP;
END $$;
