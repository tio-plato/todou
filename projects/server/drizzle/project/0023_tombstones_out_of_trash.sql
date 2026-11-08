-- A delete used to mark a tombstone rather than refuse when it reached a card
-- at the address it had moved away from, or raced the move, and restoring now
-- refuses a tombstone as every other write does. Clear those marks, so that no
-- tombstone sits in the trash for good. The cards that moved stay as they are.
UPDATE "issues" SET "deleted_at" = NULL, "deleted_by" = NULL
 WHERE "moved_at" IS NOT NULL AND "deleted_at" IS NOT NULL;
