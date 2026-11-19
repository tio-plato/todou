-- Status and label names stored before they were kept canonical (trimmed,
-- runs of whitespace collapsed to one space) may still hold " Done" or
-- "In  Review": the CLI trims every name it is given and can never select
-- them, and they sit beside names the API now treats as the same one. This
-- rewrites each such name to its canonical form.
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
-- 60-character limit: the name stays listable, usable and renameable, and
-- cutting it could make another clash.
DO $$
DECLARE
  utf8 CONSTANT boolean := current_setting('server_encoding') = 'UTF8';
  ws text;
  r record;
  target text;
  suffix text;
  candidate text;
  n int;
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
    UPDATE statuses SET name = candidate WHERE id = r.id;
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
    UPDATE labels SET name = candidate WHERE id = r.id;
  END LOOP;
END $$;
