import { and, eq, inArray, max, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Db } from "../../db/driver.ts";
import {
  attachments,
  comments,
  issueAssignees,
  issueEvents,
  issueLabels,
  issueMentions,
  issueMetadata,
  issueMutes,
  issueReads,
  issues,
  revisions,
  specVersionFiles,
  specVersions,
} from "../../db/project-schema.ts";
import { microIso } from "../timeline.ts";

/**
 * Rows per statement, read or insert. What is read still accumulates in
 * memory: the whole card is read before its first row is written.
 */
const BATCH = 500;

/** Destination-local ids, captured before this move's `moved_in` event. */
export type ActivityImportedMaxIds = {
  v: 1;
  events: number | null;
  comments: number | null;
  revisions: number | null;
};

export type IdMap = {
  issueId: number;
  /** Old comment id → new. Also what the `moved_ids` aliases are built from. */
  comments: Map<number, number>;
  attachments: Map<number, number>;
  /** Absent only when recovering a move written before watermarks existed. */
  activityImportedMaxIds?: ActivityImportedMaxIds;
};

/**
 * Every table hanging off an issue, and what a move does with it.
 *
 * One list, walked twice: once to copy into the destination and once to
 * clear the source. Keeping them on the same list is the point — the source
 * row survives as a tombstone, so none of these cascade, and a table missed
 * on the delete side leaves rows under a tombstone forever.
 *
 * `issue_reads` is on the list precisely because it is NOT copied: a read
 * position is per reader and does not follow a card across projects, and it
 * still has to be deleted.
 *
 * `pending_uploads` is neither copied nor cleared — the one exception to a
 * bare tombstone. A ticket keeps accepting PUTs until it expires, wherever
 * the card has gone, and its row is the only inventory of what it writes:
 * `gcPendingUploads` reaps the upload key from it a day past expiry (T-671).
 * Completing against the tombstone is refused as a write to a moved card.
 */
export const ISSUE_CHILD_TABLES: ReadonlyArray<{
  name: string;
  copied: boolean;
  clearSource(db: Db, issueId: number): Promise<unknown>;
}> = [
  {
    name: "issue_assignees",
    copied: true,
    clearSource: (db, id) =>
      db.delete(issueAssignees).where(eq(issueAssignees.issueId, id)),
  },
  {
    name: "issue_labels",
    copied: true,
    clearSource: (db, id) =>
      db.delete(issueLabels).where(eq(issueLabels.issueId, id)),
  },
  {
    name: "comments",
    copied: true,
    clearSource: (db, id) =>
      db.delete(comments).where(eq(comments.issueId, id)),
  },
  {
    name: "issue_events",
    copied: true,
    // Including any `moved_out` a previous attempt wrote: the replacement is
    // inserted after this runs, so a replay still leaves exactly one.
    clearSource: (db, id) =>
      db.delete(issueEvents).where(eq(issueEvents.issueId, id)),
  },
  {
    name: "spec_version_files",
    copied: true,
    // Hangs off the version, not the issue; deleted first for that reason.
    clearSource: (db, id) =>
      db
        .delete(specVersionFiles)
        .where(
          inArray(
            specVersionFiles.versionId,
            db
              .select({ id: specVersions.id })
              .from(specVersions)
              .where(eq(specVersions.issueId, id)),
          ),
        ),
  },
  {
    name: "spec_versions",
    copied: true,
    clearSource: (db, id) =>
      db.delete(specVersions).where(eq(specVersions.issueId, id)),
  },
  {
    name: "attachments",
    copied: true,
    clearSource: (db, id) =>
      db.delete(attachments).where(eq(attachments.issueId, id)),
  },
  {
    name: "revisions",
    copied: true,
    clearSource: async (db, id) => {
      const commentIds = await db
        .select({ id: comments.id })
        .from(comments)
        .where(eq(comments.issueId, id));
      await db
        .delete(revisions)
        .where(
          and(
            eq(revisions.subjectType, "issue_body"),
            eq(revisions.subjectId, id),
          ),
        );
      if (commentIds.length > 0) {
        await db.delete(revisions).where(
          and(
            eq(revisions.subjectType, "comment"),
            inArray(
              revisions.subjectId,
              commentIds.map((c) => c.id),
            ),
          ),
        );
      }
    },
  },
  {
    name: "issue_metadata",
    copied: true,
    clearSource: (db, id) =>
      db.delete(issueMetadata).where(eq(issueMetadata.issueId, id)),
  },
  {
    name: "issue_reads",
    copied: false,
    clearSource: (db, id) =>
      db.delete(issueReads).where(eq(issueReads.issueId, id)),
  },
  {
    // A mute is the reader's own relation to this card in this project
    // (T-372); like the read position above, it does not follow a move —
    // but the source row must go so the tombstone holds nothing.
    name: "issue_mutes",
    copied: false,
    clearSource: (db, id) =>
      db.delete(issueMutes).where(eq(issueMutes.issueId, id)),
  },
  {
    // A mention is notification state, not content: like the read position
    // and the mute, it belongs to this card in this project and does not
    // follow a move — but the source rows must go so the tombstone holds
    // nothing (T-373).
    name: "issue_mentions",
    copied: false,
    clearSource: (db, id) =>
      db.delete(issueMentions).where(eq(issueMentions.issueId, id)),
  },
  {
    // Listed so the schema coverage test counts it as considered; kept for
    // the reaper, as the header explains. Moving back in walks this list
    // over the tombstone again, which must not clear it either.
    name: "pending_uploads",
    copied: false,
    clearSource: async () => {},
  },
];

/**
 * Delete every child row of a source issue but its pending uploads.
 * Walks the same list the copy does, so the two cannot drift apart.
 *
 * Revisions come before comments: they are found through the comment rows
 * they belong to, which a polymorphic subject gives them no foreign key for.
 */
export async function clearIssueChildren(
  db: Db,
  issueId: number,
): Promise<void> {
  const ordered = [...ISSUE_CHILD_TABLES].sort((a, b) =>
    a.name === "revisions" ? -1 : b.name === "revisions" ? 1 : 0,
  );
  for (const table of ordered) await table.clearSource(db, issueId);
}

/**
 * `created_at` and friends at full microsecond precision. The driver's Date
 * only holds milliseconds, and the timeline cursor is
 * `(created_at µs, kind, id)` — a copy that rounds would reorder the card's
 * own history against cursors clients already hold.
 */
const micro = (column: AnyPgColumn) => microIso(column);

/** The reverse: microsecond text back into a timestamptz, nulls preserved. */
const atMicro = (text: string | null) =>
  text === null ? null : sql`${text}::timestamptz`;

type Payload = Record<string, unknown>;

/** What the copy needs to know of a move's plan. */
export type CopyPlan = {
  row: typeof issues.$inferSelect;
  source: { project: { id: number } };
  target: { project: { id: number } };
  status: { to: { id: number } };
  labelIds: number[];
  assigneeIds: number[];
  movedAt: Date;
  sameProjectDb: boolean;
};

/** Microsecond text as `micro` reads it, null where the column is. */
type Micro = string | null;

type CommentRow = Pick<
  typeof comments.$inferSelect,
  | "id"
  | "authorId"
  | "body"
  | "kind"
  | "component"
  | "agentContext"
  | "resolvedBy"
  | "hiddenBy"
> & { createdAt: Micro; editedAt: Micro; resolvedAt: Micro; hiddenAt: Micro };

type SpecVersionRow = Pick<
  typeof specVersions.$inferSelect,
  "id" | "number" | "authorId" | "message" | "agentContext"
> & { createdAt: Micro };

type SpecFileRow = Pick<
  typeof specVersionFiles.$inferSelect,
  "versionId" | "path" | "body" | "size"
>;

type AttachmentRow = Pick<
  typeof attachments.$inferSelect,
  | "id"
  | "uploaderId"
  | "filename"
  | "contentType"
  | "size"
  | "storageKey"
  | "draft"
> & { createdAt: Micro };

/** The edits of one subject: the issue body, or one of its comments. */
type RevisionGroup = {
  type: "issue_body" | "comment";
  oldId: number;
  rows: Array<
    Pick<typeof revisions.$inferSelect, "body" | "actorId" | "agentContext"> & {
      createdAt: Micro;
    }
  >;
};

type EventRow = Pick<
  typeof issueEvents.$inferSelect,
  "id" | "actorId" | "type" | "payload" | "agentContext"
> & { createdAt: Micro };

type MetadataRow = Pick<
  typeof issueMetadata.$inferSelect,
  "namespace" | "key" | "value" | "updatedBy"
> & { updatedAt: Micro };

/** Everything a move copies of one card, as read from its source. */
export type IssueTree = {
  stamps: { createdAt: Micro; bodyEditedAt: Micro };
  comments: CommentRow[];
  specVersions: SpecVersionRow[];
  specFiles: SpecFileRow[];
  attachments: AttachmentRow[];
  /** Only the subjects that have any. */
  revisions: RevisionGroup[];
  events: EventRow[];
  metadata: MetadataRow[];
};

/**
 * Copy an issue and everything under it into the destination database. The
 * whole card is read before the first row is written.
 *
 * Returns the id map, which the caller also writes into the `moved_in`
 * payload: across databases that event is the only durable record of which
 * copy became which, and the recovery sweep has nothing else to go on.
 */
export async function copyIssueTree(
  src: Db,
  dst: Db,
  plan: CopyPlan,
  opts: { number: number; reinhabit: boolean },
): Promise<IdMap> {
  return writeIssueTree(dst, await readIssueTree(src, plan), plan, opts);
}

/** Read everything `writeIssueTree` writes. Writes nothing. */
export async function readIssueTree(
  src: Db,
  plan: CopyPlan,
): Promise<IssueTree> {
  const oldIssueId = plan.row.id;

  const [stamps] = await src
    .select({
      createdAt: micro(issues.createdAt),
      bodyEditedAt: micro(issues.bodyEditedAt),
    })
    .from(issues)
    .where(eq(issues.id, oldIssueId));
  if (stamps === undefined) throw new Error("issue row vanished mid-copy");

  const commentRows = await readComments(src, oldIssueId);
  const versionRows = await readSpecVersions(src, oldIssueId);
  const specFiles = await readSpecFiles(
    src,
    versionRows.map((row) => row.id),
  );
  const attachmentRows = await readAttachments(src, oldIssueId);
  const revisionGroups = await readRevisions(src, {
    sourceId: plan.source.project.id,
    oldIssueId,
    commentIds: commentRows.map((row) => row.id),
  });
  const events = await readEvents(src, oldIssueId);
  const metadata = await readMetadata(src, oldIssueId);
  return {
    stamps,
    comments: commentRows,
    specVersions: versionRows,
    specFiles,
    attachments: attachmentRows,
    revisions: revisionGroups,
    events,
    metadata,
  };
}

/**
 * Write a card `readIssueTree` read into the destination. Comments and
 * attachments go in before the events, whose payloads are rewritten
 * through the ids they get.
 */
export async function writeIssueTree(
  dst: Db,
  tree: IssueTree,
  plan: CopyPlan,
  opts: { number: number; reinhabit: boolean },
): Promise<IdMap> {
  const targetId = plan.target.project.id;

  const fields = {
    projectId: targetId,
    number: opts.number,
    title: plan.row.title,
    body: plan.row.body,
    statusId: plan.status.to.id,
    authorId: plan.row.authorId,
    createdAt: atMicro(tree.stamps.createdAt),
    // A move is activity: the card belongs at the top of its new list.
    updatedAt: plan.movedAt,
    bodyEditedAt: atMicro(tree.stamps.bodyEditedAt),
    openQuestions: plan.row.openQuestions,
    specVersion: plan.row.specVersion,
    specReviewStatus: plan.row.specReviewStatus,
    specUnresolvedComments: plan.row.specUnresolvedComments,
    deletedAt: null,
    deletedBy: null,
    movingSince: null,
    movedAt: null,
    // biome-ignore lint/suspicious/noExplicitAny: SQL expressions for µs stamps
  } as any;

  let issueId: number;
  if (opts.reinhabit) {
    // Moving back in: the tombstone already holds this number, so the copy
    // lands on that row rather than colliding with it.
    const updated = await dst
      .update(issues)
      .set(fields)
      .where(
        and(eq(issues.projectId, targetId), eq(issues.number, opts.number)),
      )
      .returning({ id: issues.id });
    const id = updated[0]?.id;
    if (id === undefined) throw new Error("no tombstone to move back into");
    issueId = id;
    await clearIssueChildren(dst, issueId);
  } else {
    const inserted = await dst.insert(issues).values(fields).returning({
      id: issues.id,
    });
    const id = inserted[0]?.id;
    if (id === undefined) throw new Error("issue copy returned no row");
    issueId = id;
  }

  if (plan.assigneeIds.length > 0) {
    await dst
      .insert(issueAssignees)
      .values(plan.assigneeIds.map((userId) => ({ issueId, userId })));
  }
  if (plan.labelIds.length > 0) {
    await dst
      .insert(issueLabels)
      .values(plan.labelIds.map((labelId) => ({ issueId, labelId })));
  }

  const commentMap = await writeComments(dst, tree.comments, {
    targetId,
    issueId,
  });
  const specMap = await writeSpecVersions(dst, tree.specVersions, {
    targetId,
    issueId,
  });
  await writeSpecFiles(dst, tree.specFiles, { targetId, specMap });
  const attachmentMap = await writeAttachments(dst, tree.attachments, {
    targetId,
    oldIssueId: plan.row.id,
    issueId,
    deleteSourceFirst: plan.sameProjectDb,
  });
  await writeRevisions(dst, tree.revisions, { targetId, issueId, commentMap });
  await writeEvents(dst, tree.events, {
    targetId,
    issueId,
    commentMap,
    attachmentMap,
  });
  await writeMetadata(dst, tree.metadata, { targetId, issueId });

  // Revisions have polymorphic subjects rather than an issue foreign key.
  // All maxima describe this destination issue only, including no-row nulls.
  const revisionSubjects = or(
    and(
      eq(revisions.subjectType, "issue_body"),
      eq(revisions.subjectId, issueId),
    ),
    and(
      eq(revisions.subjectType, "comment"),
      inArray(
        revisions.subjectId,
        dst
          .select({ id: comments.id })
          .from(comments)
          .where(eq(comments.issueId, issueId)),
      ),
    ),
  );
  const [eventRows, commentRows, revisionRows] = await Promise.all([
    dst
      .select({ id: max(issueEvents.id) })
      .from(issueEvents)
      .where(eq(issueEvents.issueId, issueId)),
    dst
      .select({ id: max(comments.id) })
      .from(comments)
      .where(eq(comments.issueId, issueId)),
    dst
      .select({ id: max(revisions.id) })
      .from(revisions)
      .where(and(eq(revisions.projectId, targetId), revisionSubjects)),
  ]);
  return {
    issueId,
    comments: commentMap,
    attachments: attachmentMap,
    activityImportedMaxIds: {
      v: 1,
      events: eventRows[0]?.id ?? null,
      comments: commentRows[0]?.id ?? null,
      revisions: revisionRows[0]?.id ?? null,
    },
  };
}

/**
 * Metadata (T-282). Read whole rather than in batches: the table has no
 * surrogate id for `readBatches` to page on, and the per-issue quota bounds
 * one card's rows at namespaces × keys — a single read either way.
 *
 * `updated_at` travels at microsecond precision like every other stamp in
 * this file. It is not part of any cursor; two precisions inside one copy
 * routine is just the next bug waiting to be written.
 */
async function readMetadata(
  src: Db,
  oldIssueId: number,
): Promise<MetadataRow[]> {
  return src
    .select({
      namespace: issueMetadata.namespace,
      key: issueMetadata.key,
      value: issueMetadata.value,
      updatedAt: micro(issueMetadata.updatedAt),
      updatedBy: issueMetadata.updatedBy,
    })
    .from(issueMetadata)
    .where(eq(issueMetadata.issueId, oldIssueId));
}

async function writeMetadata(
  dst: Db,
  rows: MetadataRow[],
  ids: { targetId: number; issueId: number },
): Promise<void> {
  if (rows.length === 0) return;

  await dst.insert(issueMetadata).values(
    rows.map((row) => ({
      projectId: ids.targetId,
      issueId: ids.issueId,
      namespace: row.namespace,
      key: row.key,
      value: row.value,
      updatedAt: atMicro(row.updatedAt),
      updatedBy: row.updatedBy,
      // biome-ignore lint/suspicious/noExplicitAny: SQL expressions for µs
    })) as any,
  );
}

async function readComments(
  src: Db,
  oldIssueId: number,
): Promise<CommentRow[]> {
  return readBatches<CommentRow>(src, comments, oldIssueId, {
    id: comments.id,
    authorId: comments.authorId,
    body: comments.body,
    kind: comments.kind,
    component: comments.component,
    agentContext: comments.agentContext,
    resolvedBy: comments.resolvedBy,
    hiddenBy: comments.hiddenBy,
    createdAt: micro(comments.createdAt),
    editedAt: micro(comments.editedAt),
    resolvedAt: micro(comments.resolvedAt),
    hiddenAt: micro(comments.hiddenAt),
  });
}

/**
 * Rows are inserted one at a time on purpose. A multi-row insert would have
 * to pair the ids it gets back by position, and `RETURNING` is under no
 * obligation to preserve the order rows were supplied in — a mispairing here
 * produces no error at all, just permalinks that quietly land on the wrong
 * comment.
 */
async function writeComments(
  dst: Db,
  rows: CommentRow[],
  ids: { targetId: number; issueId: number },
): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  for (const row of rows) {
    const inserted = await dst
      .insert(comments)
      .values({
        projectId: ids.targetId,
        issueId: ids.issueId,
        authorId: row.authorId,
        body: row.body,
        kind: row.kind,
        component: row.component,
        agentContext: row.agentContext,
        resolvedBy: row.resolvedBy,
        hiddenBy: row.hiddenBy,
        createdAt: atMicro(row.createdAt),
        editedAt: atMicro(row.editedAt),
        resolvedAt: atMicro(row.resolvedAt),
        hiddenAt: atMicro(row.hiddenAt),
        // biome-ignore lint/suspicious/noExplicitAny: SQL expressions for µs
      } as any)
      .returning({ id: comments.id });
    const id = inserted[0]?.id;
    if (id === undefined) throw new Error("comment copy returned no row");
    map.set(row.id, id);
  }
  return map;
}

async function readAttachments(
  src: Db,
  oldIssueId: number,
): Promise<AttachmentRow[]> {
  return readBatches<AttachmentRow>(src, attachments, oldIssueId, {
    id: attachments.id,
    uploaderId: attachments.uploaderId,
    filename: attachments.filename,
    contentType: attachments.contentType,
    size: attachments.size,
    storageKey: attachments.storageKey,
    draft: attachments.draft,
    createdAt: micro(attachments.createdAt),
  });
}

async function writeAttachments(
  dst: Db,
  rows: AttachmentRow[],
  ids: {
    targetId: number;
    oldIssueId: number;
    issueId: number;
    deleteSourceFirst: boolean;
  },
): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  if (rows.length === 0) return map;

  // The blob is not copied, so the copy keeps the same storage key — and
  // `attachments_storage_key_idx` is unique per DATABASE, not per project.
  // Where both projects live in one database the source rows have to go
  // first, or the copy collides with the rows it is copying. That one
  // database is the destination, so they go through it.
  if (ids.deleteSourceFirst) {
    await dst
      .delete(attachments)
      .where(eq(attachments.issueId, ids.oldIssueId));
  }

  for (const row of rows) {
    const inserted = await dst
      .insert(attachments)
      .values({
        projectId: ids.targetId,
        issueId: ids.issueId,
        uploaderId: row.uploaderId,
        filename: row.filename,
        contentType: row.contentType,
        size: row.size,
        storageKey: row.storageKey,
        draft: row.draft,
        createdAt: atMicro(row.createdAt),
        // biome-ignore lint/suspicious/noExplicitAny: SQL expressions for µs
      } as any)
      .returning({ id: attachments.id });
    const id = inserted[0]?.id;
    if (id === undefined) throw new Error("attachment copy returned no row");
    map.set(row.id, id);
  }
  return map;
}

async function readSpecVersions(
  src: Db,
  oldIssueId: number,
): Promise<SpecVersionRow[]> {
  return readBatches<SpecVersionRow>(src, specVersions, oldIssueId, {
    id: specVersions.id,
    number: specVersions.number,
    authorId: specVersions.authorId,
    message: specVersions.message,
    agentContext: specVersions.agentContext,
    createdAt: micro(specVersions.createdAt),
  });
}

async function writeSpecVersions(
  dst: Db,
  rows: SpecVersionRow[],
  ids: { targetId: number; issueId: number },
): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  for (const row of rows) {
    const inserted = await dst
      .insert(specVersions)
      .values({
        projectId: ids.targetId,
        issueId: ids.issueId,
        number: row.number,
        authorId: row.authorId,
        message: row.message,
        agentContext: row.agentContext,
        createdAt: atMicro(row.createdAt),
        // biome-ignore lint/suspicious/noExplicitAny: SQL expressions for µs
      } as any)
      .returning({ id: specVersions.id });
    const id = inserted[0]?.id;
    if (id === undefined) throw new Error("spec version copy returned no row");
    map.set(row.id, id);
  }
  return map;
}

/** Hangs off the version, so it is read `BATCH` versions at a time. */
async function readSpecFiles(
  src: Db,
  oldVersionIds: number[],
): Promise<SpecFileRow[]> {
  const rows: SpecFileRow[] = [];
  for (let i = 0; i < oldVersionIds.length; i += BATCH) {
    const slice = oldVersionIds.slice(i, i + BATCH);
    const found = await src
      .select()
      .from(specVersionFiles)
      .where(inArray(specVersionFiles.versionId, slice));
    for (const row of found) rows.push(row);
  }
  return rows;
}

/**
 * `BATCH` rows per insert, not one insert per slice of versions read: a
 * version holds up to 64 files, and that many rows of five columns each
 * would pass the 65535 parameters one statement can carry.
 */
async function writeSpecFiles(
  dst: Db,
  rows: SpecFileRow[],
  ids: { targetId: number; specMap: Map<number, number> },
): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) {
    await dst.insert(specVersionFiles).values(
      rows.slice(i, i + BATCH).map((row) => ({
        projectId: ids.targetId,
        versionId: ids.specMap.get(row.versionId) as number,
        path: row.path,
        body: row.body,
        size: row.size,
      })),
    );
  }
}

async function readRevisions(
  src: Db,
  ids: { sourceId: number; oldIssueId: number; commentIds: number[] },
): Promise<RevisionGroup[]> {
  const subjects: Array<{ type: "issue_body" | "comment"; oldId: number }> = [
    { type: "issue_body", oldId: ids.oldIssueId },
    ...ids.commentIds.map((oldId) => ({ type: "comment", oldId }) as const),
  ];
  const groups: RevisionGroup[] = [];
  for (const subject of subjects) {
    const rows = await src
      .select({
        body: revisions.body,
        actorId: revisions.actorId,
        agentContext: revisions.agentContext,
        createdAt: micro(revisions.createdAt),
      })
      .from(revisions)
      .where(
        and(
          eq(revisions.projectId, ids.sourceId),
          eq(revisions.subjectType, subject.type),
          eq(revisions.subjectId, subject.oldId),
        ),
      );
    if (rows.length > 0) groups.push({ ...subject, rows });
  }
  return groups;
}

async function writeRevisions(
  dst: Db,
  groups: RevisionGroup[],
  ids: {
    targetId: number;
    issueId: number;
    commentMap: Map<number, number>;
  },
): Promise<void> {
  for (const group of groups) {
    const newSubjectId =
      group.type === "issue_body"
        ? ids.issueId
        : (ids.commentMap.get(group.oldId) as number);
    await dst.insert(revisions).values(
      group.rows.map(
        (row) =>
          ({
            projectId: ids.targetId,
            subjectType: group.type,
            subjectId: newSubjectId,
            body: row.body,
            actorId: row.actorId,
            agentContext: row.agentContext,
            createdAt: atMicro(row.createdAt),
            // biome-ignore lint/suspicious/noExplicitAny: SQL expressions for µs
          }) as any,
      ),
    );
  }
}

async function readEvents(src: Db, oldIssueId: number): Promise<EventRow[]> {
  return readBatches<EventRow>(src, issueEvents, oldIssueId, {
    id: issueEvents.id,
    actorId: issueEvents.actorId,
    type: issueEvents.type,
    payload: issueEvents.payload,
    agentContext: issueEvents.agentContext,
    createdAt: micro(issueEvents.createdAt),
  });
}

async function writeEvents(
  dst: Db,
  rows: EventRow[],
  ids: {
    targetId: number;
    issueId: number;
    commentMap: Map<number, number>;
    attachmentMap: Map<number, number>;
  },
): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) {
    const values = rows.slice(i, i + BATCH).map((row) => ({
      projectId: ids.targetId,
      issueId: ids.issueId,
      actorId: row.actorId,
      type: row.type,
      payload: remapPayload(row.type, row.payload as Payload, ids),
      agentContext: row.agentContext,
      createdAt: atMicro(row.createdAt),
    }));
    // biome-ignore lint/suspicious/noExplicitAny: SQL expressions for µs
    await dst.insert(issueEvents).values(values as any);
  }
}

/**
 * Rewrite the row ids our own event payloads carry. Not a general rule — the
 * exhaustive list is short, and getting it wrong is silent, so it is spelled
 * out rather than inferred.
 *
 * `by_comment` on a reference event is deliberately absent: on this card's
 * own timeline it names the comment that did the referencing, which belongs
 * to some other card and does not move.
 */
export function remapPayload(
  type: string,
  payload: Payload,
  ids: { commentMap: Map<number, number>; attachmentMap: Map<number, number> },
): Payload {
  const comment = (id: unknown) =>
    typeof id === "number" ? (ids.commentMap.get(id) ?? id) : id;
  switch (type) {
    case "question_answered":
    case "question_withdrawn":
    case "spec_review":
      return { ...payload, comment_id: comment(payload.comment_id) };
    case "spec_comments_resolved":
      return {
        ...payload,
        comment_ids: Array.isArray(payload.comment_ids)
          ? payload.comment_ids.map(comment)
          : payload.comment_ids,
      };
    case "attachment_added": {
      const attachment = payload.attachment as { id?: unknown } | undefined;
      if (attachment?.id === undefined) return payload;
      return {
        ...payload,
        attachment: {
          ...attachment,
          id:
            typeof attachment.id === "number"
              ? (ids.attachmentMap.get(attachment.id) ?? attachment.id)
              : attachment.id,
        },
      };
    }
    default:
      return payload;
  }
}

/**
 * Read one issue's rows from a table in id order, `BATCH` per query, and
 * return all of them.
 */
async function readBatches<Row>(
  db: Db,
  // biome-ignore lint/suspicious/noExplicitAny: any project-tier child table
  table: any,
  issueId: number,
  // biome-ignore lint/suspicious/noExplicitAny: a drizzle selection object
  selection: any,
): Promise<Row[]> {
  const rows: Row[] = [];
  let after = 0;
  for (;;) {
    const batch = await db
      .select(selection)
      .from(table)
      .where(and(eq(table.issueId, issueId), sql`${table.id} > ${after}`))
      .orderBy(table.id)
      .limit(BATCH);
    if (batch.length === 0) return rows;
    rows.push(...batch);
    const last = batch.at(-1) as { id?: number } | undefined;
    if (last?.id === undefined) return rows;
    after = last.id;
  }
}
