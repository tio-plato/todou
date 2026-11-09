/**
 * The cosmetic half of the T-269 rename, owed to every deployment that ran
 * migration 0013.
 *
 * The migration made filenames unique within a card; it could not touch the
 * text around the links, so a body that wrote out the old name still shows it.
 * Nothing is broken by that — an attachment URL addresses `(project, id)` and
 * the last segment is decoration — which is why this is an operator command
 * run once after the deploy rather than part of the migration.
 *
 * A second run finds nothing left to do, which is what makes a real run after
 * a `--dry-run` safe.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import {
  attachments,
  comments,
  issueEvents,
  issues,
  specVersionFiles,
  specVersions,
} from "../db/project-schema.ts";
import { projects } from "../db/system-schema.ts";
import { type ProjectRow, routeInfoOf } from "./access.ts";
import {
  ATTACHMENT_LINK as LINK,
  ATTACHMENT_OWNER as OWNER,
} from "./attachment-links.ts";
import { encodeNameSegment } from "./attachment-names.ts";
import { formerSlugsOf } from "./projects.ts";
import { recordRevision } from "./revisions.ts";
import { utf8Size } from "./spec.ts";
import { gateColumns } from "./trash.ts";

export type RelabelReport = {
  projects: number;
  segments: number;
  links: number;
  skipped: number;
};

export type RelabelOptions = {
  dryRun: boolean;
  /** One project only; the whole deployment when absent. */
  slug?: string;
  log: (line: string) => void;
};

/** What a renamed attachment used to be called, and is called now. */
type Rename = { before: string; after: string };

/**
 * Link text that is itself nothing but an attachment URL, split before its
 * last segment. T-266 stores a bare pasted address as `[<the URL as typed>](
 * <the id-anchored href>)`, so for those links the filename a reader actually
 * sees is in the text, not the destination. The origin is optional and kept
 * verbatim because that is the spelling the author used — an autolinked URL
 * is always absolute, a hand-written one need not be.
 */
const TEXT_URL =
  /^((?:[a-z][a-z0-9+.-]*:\/\/[^/\s]+)?\/api\/projects\/([^/\s]+)\/attachments\/(\d+)\/(?:download|view)\/)([^\s?#]+)$/i;

const unescapeText = (raw: string): string => raw.replaceAll(/\\(.)/g, "$1");
const escapeText = (text: string): string =>
  text.replaceAll(/[[\]\\]/g, "\\$&");

export type SegmentContext = {
  renames: ReadonlyMap<number, Rename>;
  /** Every attachment id the project still holds, renamed or not. */
  known: ReadonlySet<number>;
  /** The spellings this project answers to in a destination. */
  owners: ReadonlySet<string>;
};

export type SegmentResult = {
  text: string;
  /** One entry per rewritten link, in the order they appear. */
  changes: Array<{ id: number } & Rename>;
  skipped: number;
};

/**
 * Rewrite one piece of markdown.
 *
 * Only the old filename moves, in the two places a reader can see it: the
 * link text (see `relabelLabel`) and the destination's last segment. A
 * caption someone wrote themselves reads the same after a rename as before,
 * so equality is the test rather than "looks like a filename" — and
 * everything outside a matched span stays byte-for-byte, which is why the
 * pieces are spliced instead of run through a global replace.
 */
export function relabelSegment(
  text: string,
  ctx: SegmentContext,
): SegmentResult {
  const changes: SegmentResult["changes"] = [];
  let skipped = 0;
  const pieces: string[] = [];
  let cut = 0;

  for (const match of text.matchAll(LINK)) {
    const [whole, bang = "", label = "", url = "", rawId = "", segment] = match;
    const owner = OWNER.exec(url)?.[1];
    if (owner === undefined || !ctx.owners.has(owner)) continue;

    const id = Number(rawId);
    const rename = ctx.renames.get(id);
    if (rename === undefined) {
      // The row is gone, so there is no name to compare against; a link to an
      // attachment that simply kept its name is not a miss.
      if (!ctx.known.has(id)) skipped += 1;
      continue;
    }

    const label2 = relabelLabel(label, id, rename, ctx);
    const segment2 =
      segment !== undefined && decodeSegment(segment) === rename.before
        ? encodeNameSegment(rename.after)
        : segment;
    if (label2 === label && segment2 === segment) continue;

    const url2 =
      segment2 === segment
        ? url
        : `${url.slice(0, url.length - (segment as string).length)}${segment2}`;
    pieces.push(text.slice(cut, match.index), `${bang}[${label2}](${url2})`);
    cut = match.index + whole.length;
    changes.push({ id, ...rename });
  }

  if (changes.length === 0) return { text, changes, skipped };
  pieces.push(text.slice(cut));
  return { text: pieces.join(""), changes, skipped };
}

/** A malformed escape is not a filename; leave the link alone. */
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * What this link should read as. Two shapes carry a stale name, and both are
 * decided by equality rather than by looking filename-shaped:
 *
 * - the text IS the old filename, which is what the editors write;
 * - the text is the whole old URL, which is what T-266 leaves behind when it
 *   wraps a bare pasted address. Only the filename segment inside it moves —
 *   the project spelling there is the author's own, kept verbatim on purpose.
 */
function relabelLabel(
  label: string,
  id: number,
  rename: Rename,
  ctx: SegmentContext,
): string {
  const plain = unescapeText(label);
  if (plain === rename.before) return escapeText(rename.after);

  const parts = TEXT_URL.exec(plain);
  if (parts === null) return label;
  const [, prefix = "", owner = "", rawId = "", segment = ""] = parts;
  // Three gates, all exact: the text names this project, it names the very
  // attachment the destination does, and its last segment is that
  // attachment's old name. Requiring the two sides to agree is what keeps a
  // URL pointing at some other deployment out of reach — the wrapper T-266
  // writes always names one attachment twice.
  if (
    !ctx.owners.has(owner) ||
    Number(rawId) !== id ||
    decodeSegment(segment) !== rename.before
  ) {
    return label;
  }
  return escapeText(`${prefix}${encodeNameSegment(rename.after)}`);
}

export async function relabelAttachments(
  ctx: DbContext,
  opts: RelabelOptions,
): Promise<RelabelReport> {
  const report: RelabelReport = {
    projects: 0,
    segments: 0,
    links: 0,
    skipped: 0,
  };
  const system = ctx.router.system();
  const rows =
    opts.slug === undefined
      ? await system.select().from(projects)
      : await system
          .select()
          .from(projects)
          .where(eq(projects.slug, opts.slug));

  for (const project of rows as ProjectRow[]) {
    report.projects += 1;
    const db = await ctx.router.forProject(routeInfoOf(project));
    const one = await relabelProject(db, system, project, opts);
    report.segments += one.segments;
    report.links += one.links;
    report.skipped += one.skipped;
  }
  return report;
}

/**
 * What each attachment was called when it was uploaded, for those whose name
 * has changed since. The `attachment_added` event is the only record of the
 * old name and the migration deliberately left it alone — rewriting it would
 * have destroyed the very mapping this walk runs on.
 */
async function renamesOf(
  db: Db,
  projectId: number,
): Promise<{ renames: Map<number, Rename>; known: Set<number> }> {
  const rows = await db
    .select({
      id: attachments.id,
      after: attachments.filename,
      before: sql<
        string | null
      >`${issueEvents.payload} -> 'attachment' ->> 'filename'`,
    })
    .from(attachments)
    .leftJoin(
      issueEvents,
      and(
        eq(issueEvents.projectId, projectId),
        eq(issueEvents.type, "attachment_added"),
        sql`(${issueEvents.payload} -> 'attachment' ->> 'id')::bigint = ${attachments.id}`,
      ),
    )
    .where(eq(attachments.projectId, projectId));

  const renames = new Map<number, Rename>();
  const known = new Set<number>();
  for (const row of rows) {
    known.add(row.id);
    if (row.before === null || row.before === row.after) continue;
    renames.set(row.id, { before: row.before, after: row.after });
  }
  return { renames, known };
}

type Subject =
  | { kind: "issue_body"; issueId: number; actorId: number; number: number }
  | {
      kind: "comment";
      commentId: number;
      issueId: number;
      actorId: number;
      number: number;
    }
  | { kind: "spec_file"; fileId: number; issueId: number; number: number };

async function relabelProject(
  db: Db,
  system: Db,
  project: ProjectRow,
  opts: RelabelOptions,
): Promise<Omit<RelabelReport, "projects">> {
  const tally = { segments: 0, links: 0, skipped: 0 };
  const { renames, known } = await renamesOf(db, project.id);
  if (known.size === 0) return tally;

  const owners = new Set<string>([
    String(project.id),
    project.slug,
    ...(await formerSlugsOf(system, project)),
  ]);
  const ctx: SegmentContext = { renames, known, owners };

  const issueRows = await db
    .select({
      id: issues.id,
      number: issues.number,
      authorId: issues.authorId,
      body: issues.body,
    })
    .from(issues)
    .where(eq(issues.projectId, project.id));
  const numberOf = new Map(issueRows.map((row) => [row.id, row.number]));

  const segments: Array<{ subject: Subject; text: string }> = issueRows.map(
    (row) => ({
      subject: {
        kind: "issue_body",
        issueId: row.id,
        actorId: row.authorId,
        number: row.number,
      },
      text: row.body,
    }),
  );

  const commentRows = await db
    .select({
      id: comments.id,
      issueId: comments.issueId,
      authorId: comments.authorId,
      body: comments.body,
    })
    .from(comments)
    .where(eq(comments.projectId, project.id));
  for (const row of commentRows) {
    segments.push({
      subject: {
        kind: "comment",
        commentId: row.id,
        issueId: row.issueId,
        actorId: row.authorId,
        number: numberOf.get(row.issueId) ?? 0,
      },
      text: row.body,
    });
  }

  const versionRows = await db
    .select({ id: specVersions.id, issueId: specVersions.issueId })
    .from(specVersions)
    .where(eq(specVersions.projectId, project.id));
  if (versionRows.length > 0) {
    const fileRows = await db
      .select({
        id: specVersionFiles.id,
        versionId: specVersionFiles.versionId,
        body: specVersionFiles.body,
      })
      .from(specVersionFiles)
      .where(
        inArray(
          specVersionFiles.versionId,
          versionRows.map((row) => row.id),
        ),
      );
    const cardOf = new Map(
      versionRows.map((row) => [
        row.id,
        { issueId: row.issueId, number: numberOf.get(row.issueId) ?? 0 },
      ]),
    );
    for (const row of fileRows) {
      const card = cardOf.get(row.versionId);
      if (card === undefined) continue;
      segments.push({
        subject: { kind: "spec_file", fileId: row.id, ...card },
        text: row.body,
      });
    }
  }

  for (const segment of segments) {
    const scanned = relabelSegment(segment.text, ctx);
    tally.skipped += scanned.skipped;
    // The scan only picks the texts worth a lock; a real run writes what it
    // finds under the card's lock, which is also what it reports.
    if (scanned.changes.length === 0) continue;
    const { number, kind } = segment.subject;
    const result = opts.dryRun
      ? scanned
      : await write(db, project.id, segment.subject, ctx);
    if (result === "moving") {
      opts.log(
        `${project.slug}/${number} ${kind}: left as it is, the card is ` +
          "being moved to another project; run this again once the move is done",
      );
      continue;
    }
    if (result === null) continue;
    tally.segments += 1;
    tally.links += result.changes.length;
    for (const change of result.changes) {
      opts.log(
        `${project.slug}/${number} ${kind} ` +
          `#${change.id}: "${change.before}" → "${change.after}"`,
      );
    }
  }
  return tally;
}

/**
 * Rewrite one text as it stands under its card's lock, so an edit committed
 * since the scan is rewritten rather than overwritten. Returns what was
 * written; `"moving"` when the card is being moved to another project and
 * was left alone; null when there was nothing left to write: the text is
 * gone, or someone already changed its links.
 *
 * The card's row is locked before the text, the order every write to a card
 * takes (rule 1 on `lockIssueRows`), and FOR NO KEY UPDATE like theirs, so
 * this queues behind them instead of deadlocking with them. A comment or a
 * spec file is read again FOR NO KEY UPDATE as well, the mode of the update
 * that follows: the text read is then the latest committed one even if a
 * writer reached it without locking the card. A card being moved is frozen
 * while its rows are copied, and a rewrite now would be lost with the
 * source; one already moved holds no text left to rewrite. The trash is no
 * reason to skip: a card restored from it reads the new name.
 */
async function write(
  db: Db,
  projectId: number,
  subject: Subject,
  ctx: SegmentContext,
): Promise<SegmentResult | "moving" | null> {
  return db.transaction(async (tx) => {
    const [card] = await tx
      .select({ ...gateColumns, body: issues.body })
      .from(issues)
      .where(eq(issues.id, subject.issueId))
      .for("no key update");
    if (card === undefined) return null;
    if (card.movingSince !== null) return "moving";

    let before: string | undefined;
    switch (subject.kind) {
      case "issue_body":
        before = card.body;
        break;
      case "comment": {
        const [row] = await tx
          .select({ body: comments.body })
          .from(comments)
          .where(eq(comments.id, subject.commentId))
          .for("no key update");
        before = row?.body;
        break;
      }
      case "spec_file": {
        const [row] = await tx
          .select({ body: specVersionFiles.body })
          .from(specVersionFiles)
          .where(eq(specVersionFiles.id, subject.fileId))
          .for("no key update");
        before = row?.body;
        break;
      }
    }
    if (before === undefined) return null;
    const result = relabelSegment(before, ctx);
    if (result.changes.length === 0) return null;
    await store(tx, projectId, subject, before, result.text);
    return result;
  });
}

/**
 * The revision holds the text as its author typed it and `edited_at` stays
 * untouched: the "(edited)" mark means the author changed their words, which
 * a filename normalisation must not claim to have done. Spec files record
 * nothing — a spec version IS its own history.
 */
async function store(
  db: Db,
  projectId: number,
  subject: Subject,
  before: string,
  after: string,
): Promise<void> {
  switch (subject.kind) {
    case "issue_body":
      await db
        .update(issues)
        .set({ body: after })
        .where(eq(issues.id, subject.issueId));
      await recordRevision(db, {
        projectId,
        subjectType: "issue_body",
        subjectId: subject.issueId,
        body: before,
        actorId: subject.actorId,
        agentContext: null,
      });
      break;
    case "comment":
      await db
        .update(comments)
        .set({ body: after })
        .where(eq(comments.id, subject.commentId));
      await recordRevision(db, {
        projectId,
        subjectType: "comment",
        subjectId: subject.commentId,
        body: before,
        actorId: subject.actorId,
        agentContext: null,
      });
      break;
    case "spec_file":
      await db
        .update(specVersionFiles)
        .set({ body: after, size: utf8Size(after) })
        .where(eq(specVersionFiles.id, subject.fileId));
      break;
  }
}
