import { createHash } from "node:crypto";
import {
  type ChangeRow,
  defaultInsightsRole,
  type Role,
  type StatusRef,
  type TemplateApplyInput,
  type TemplateApplyPlan,
  type TemplateApplyProject,
  type TemplateApplyResult,
  type TemplateBody,
  type TemplateRef,
  type TemplateStatus,
} from "@todou/shared";
import {
  type ApplyResult,
  applyLayout,
  applyResult,
  pairByName,
  pairStatuses,
  type StatusKey,
  statusMovers,
} from "@todou/shared/template-apply";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { UserRow } from "../auth/pat.ts";
import { uniqueViolation } from "../auth/provision.ts";
import type { AppContext } from "../bootstrap.ts";
import type { Db } from "../db/driver.ts";
import {
  insightsSettings,
  issueLabels,
  issues,
  LABEL_NAME_INDEX,
  labels,
  projectMeta,
  STATUS_NAME_INDEX,
  statuses,
} from "../db/project-schema.ts";
import {
  ConflictError,
  DrawnMismatchError,
  ValidationFailedError,
} from "../errors.ts";
import { requireCapability, routeInfoOf } from "./access.ts";
import { announceBlockChanges, reevaluateProjectBlocks } from "./blocks.ts";
import {
  ensureSettingsRow,
  inSerializableTransaction,
  insightsSettingsResponse,
  type RoleChange,
  storedRoles,
  swapRoles,
  type Tx,
} from "./insights-settings.ts";
import { labelUsageRows } from "./labels.ts";
import { resolveTemplate } from "./project-templates.ts";
import { statusUsageRows } from "./statuses.ts";

/** A project's statuses and labels as an apply plan reads them. */
export type ProjectState = {
  /** In board order. */
  statuses: Array<{
    id: number;
    name: string;
    category: "open" | "closed";
    color: string;
    position: number;
    isDefault: boolean;
    /** The chart role it counts as now, saved or default. */
    role: Role;
    issues: number;
    trashed: number;
  }>;
  lineId: number | null;
  /** The stored insights row, when there is one. */
  saved: { revision: number; roles: Record<string, string> } | null;
  /** `issues` out of the trash, as the Labels page counts; `trashed` apart. */
  labels: Array<{
    id: number;
    name: string;
    color: string;
    issues: number;
    trashed: number;
  }>;
};

/** What carrying out the selected rows comes to. */
export type ApplyOutcome = {
  deleteLabelIds: number[];
  deleteStatusIds: number[];
  /** Selected status deletions left undone because issues are in them. */
  skipped: string[];
  addStatuses: TemplateStatus[];
  updateStatuses: Array<{
    id: number;
    color?: string;
    category?: "open" | "closed";
  }>;
  /** Every status that stays, in its new board order. */
  order: StatusKey[];
  /** Undefined when the default is left as it is. */
  defaultStatus?: StatusKey | null;
  line: StatusKey | null;
  lineChanged: boolean;
  roleChanges: Array<
    | { kind: "added"; key: StatusKey; status: TemplateStatus; role: Role }
    | { kind: "edited"; key: StatusKey; role: Role }
    | { kind: "deleted"; key: StatusKey }
  >;
  addLabels: Array<{ name: string; color: string }>;
  updateLabels: Array<{ id: number; color: string }>;
};

const sameColor = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The project as a plan hands it to the page, and as the order rules read
 * it: the page draws the table from this, so the apply reads it too.
 */
export function projectSnapshot(state: ProjectState): TemplateApplyProject {
  return {
    statuses: state.statuses.map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color,
      category: s.category,
      role: s.role,
      is_default: s.isDefault,
    })),
    line: state.lineId,
    labels: state.labels.map((l) => ({
      id: l.id,
      name: l.name,
      color: l.color,
    })),
  };
}

type Pairing = Pick<ReturnType<typeof pairStatuses>, "keyOf">;

function refOf(
  state: ProjectState,
  pairing: Pairing,
  template: TemplateBody,
  key: StatusKey | null,
): StatusRef | null {
  if (key === null) return null;
  if (typeof key === "number") {
    const status = state.statuses.find((s) => s.id === key);
    return status ? { name: status.name, color: status.color } : null;
  }
  const status = template.statuses.find((s) => pairing.keyOf(s) === key);
  return status ? { name: status.name, color: status.color } : null;
}

const base = (
  id: string,
  section: "statuses" | "labels",
  action: ChangeRow["action"],
  extra: { selectable?: boolean; requires?: string[] } = {},
) => ({
  id,
  section,
  action,
  // A deletion cannot be undone, so it is never one of the defaults.
  default_selected: action !== "delete",
  selectable: extra.selectable ?? true,
  requires: extra.requires ?? [],
});

/**
 * Every difference between a project and a template, one row each. Rows
 * changing, moving or deleting what the project has are named by its id
 * there; rows adding something by the template's name for it.
 */
export function planTemplateApply(
  state: ProjectState,
  template: TemplateBody,
): ChangeRow[] {
  const rows: ChangeRow[] = [];
  const pairing = pairStatuses(state.statuses, template);
  const { paired, extras, keyOf } = pairing;
  const addId = (name: string) => `status.add:${name}`;

  for (const [index, status] of template.statuses.entries()) {
    if (paired.has(status.name)) continue;
    const before = index === 0 ? undefined : template.statuses[index - 1];
    rows.push({
      ...base(addId(status.name), "statuses", "add"),
      type: "status_add",
      name: status.name,
      category: status.category,
      color: status.color,
      chart_role: status.chart_role,
      after:
        before === undefined
          ? null
          : (refOf(state, pairing, template, keyOf(before))?.name ?? null),
    });
  }

  // A colour apart from what the status means, so either can be left out.
  for (const status of template.statuses) {
    const current = paired.get(status.name);
    if (current === undefined) continue;
    if (!sameColor(current.color, status.color)) {
      rows.push({
        ...base(`status.recolour:${current.id}`, "statuses", "recolour"),
        type: "status_recolour",
        name: current.name,
        from: current.color,
        to: status.color,
      });
    }
    const category = current.category !== status.category;
    const role = current.role !== status.chart_role;
    if (!category && !role) continue;
    rows.push({
      ...base(`status.change:${current.id}`, "statuses", "change"),
      type: "status_change",
      name: current.name,
      color_now: current.color,
      ...(category && {
        category: { from: current.category, to: status.category },
      }),
      ...(role && {
        chart_role: { from: current.role, to: status.chart_role },
      }),
    });
  }

  const movers = statusMovers(state.statuses, template);
  for (const status of state.statuses) {
    if (!movers.has(status.id)) continue;
    rows.push({
      ...base(`status.move:${status.id}`, "statuses", "move"),
      type: "status_move",
    });
  }

  // Which status is the default changes what it means; where the line is,
  // like a status's place, is the order.
  for (const [id, type, action, now, wanted] of [
    [
      "status.default",
      "status_default",
      "change",
      state.statuses.find((s) => s.isDefault)?.id ?? null,
      template.statuses.find((s) => s.is_default),
    ],
    [
      "status.line",
      "status_line",
      "move",
      state.lineId,
      template.statuses.find((s) => s.block_clear),
    ],
  ] as const) {
    const target = wanted === undefined ? null : keyOf(wanted);
    if (target === now) continue;
    rows.push({
      ...base(id, "statuses", action, {
        requires: typeof target === "string" ? [addId(target)] : [],
      }),
      type,
      from: refOf(state, pairing, template, now),
      to: refOf(state, pairing, template, target),
    });
  }

  for (const status of extras) {
    rows.push({
      ...base(`status.delete:${status.id}`, "statuses", "delete", {
        // The foreign key counts trashed issues too.
        selectable: status.issues + status.trashed === 0,
      }),
      type: "status_delete",
      name: status.name,
      color: status.color,
      issues: status.issues,
      trashed: status.trashed,
    });
  }

  const byId = [...state.labels].sort((a, b) => a.id - b.id);
  const labelPairing = pairByName(
    byId,
    template.labels.map((l) => l.name),
  );
  for (const label of template.labels) {
    const current = labelPairing.paired.get(label.name);
    if (current === undefined) {
      rows.push({
        ...base(`label.add:${label.name}`, "labels", "add"),
        type: "label_add",
        name: label.name,
        color: label.color,
      });
    } else if (!sameColor(current.color, label.color)) {
      rows.push({
        ...base(`label.change:${current.id}`, "labels", "recolour"),
        type: "label_change",
        name: current.name,
        from: current.color,
        to: label.color,
      });
    }
  }
  for (const label of labelPairing.leftover) {
    rows.push({
      ...base(`label.delete:${label.id}`, "labels", "delete"),
      type: "label_delete",
      name: label.name,
      color: label.color,
      issues: label.issues,
      trashed: label.trashed,
    });
  }
  return rows;
}

/** Whether `result` is what the page drew. */
function asDrawn(
  result: ApplyResult,
  drawn: NonNullable<TemplateApplyInput["drawn"]>,
): boolean {
  return (
    result.line === drawn.line &&
    result.default === drawn.default &&
    result.order.length === drawn.order.length &&
    result.order.every((key, i) => drawn.order[i] === key)
  );
}

/**
 * What carrying out `selected` of `rows` does to the project. Refuses an id
 * no row has, and a row selected without the rows it requires; a status
 * deletion whose status holds issues is skipped rather than refused, since
 * whether it held them when previewed cannot be told any more.
 *
 * Refuses too a selection that comes to anything but `drawn`, what the page
 * drew the project as once applied, when it sent that. It is compared
 * before any deletion is skipped: a status that took issues since the
 * preview is not the page drawing it wrong.
 */
export function applySelection(
  state: ProjectState,
  template: TemplateBody,
  rows: readonly ChangeRow[],
  selected: readonly string[],
  drawn?: TemplateApplyInput["drawn"],
): ApplyOutcome {
  const chosen = new Set(selected);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const unknown = [...chosen].filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new ValidationFailedError(
      `no such change: ${unknown.join(", ")} — preview again`,
      { unknown },
    );
  }
  for (const id of chosen) {
    const missing = (byId.get(id) as ChangeRow).requires.filter(
      (needed) => !chosen.has(needed),
    );
    if (missing.length > 0) {
      throw new ValidationFailedError(
        `${id} needs ${missing.join(", ")} selected too`,
        { id, missing },
      );
    }
  }
  const layout = applyLayout(projectSnapshot(state), template, rows);
  if (drawn !== undefined && !asDrawn(applyResult(layout, chosen), drawn)) {
    throw new DrawnMismatchError();
  }
  const picked = rows.filter((row) => chosen.has(row.id));
  const { keyOf } = pairStatuses(state.statuses, template);

  const skipped: string[] = [];
  const deleteStatusIds: number[] = [];
  const deleteLabelIds: number[] = [];
  const addStatuses: TemplateStatus[] = [];
  const updates = new Map<number, ApplyOutcome["updateStatuses"][number]>();
  const update = (
    id: number,
    change: { color?: string; category?: "open" | "closed" },
  ) => updates.set(id, { ...updates.get(id), id, ...change });
  const roleChanges: ApplyOutcome["roleChanges"] = [];
  const addLabels: ApplyOutcome["addLabels"] = [];
  const updateLabels: ApplyOutcome["updateLabels"] = [];
  const idIn = (row: ChangeRow) =>
    Number(row.id.slice(row.id.indexOf(":") + 1));

  for (const row of picked) {
    if (row.type === "status_delete") {
      if (!row.selectable) {
        skipped.push(row.id);
        continue;
      }
      deleteStatusIds.push(idIn(row));
      roleChanges.push({ kind: "deleted", key: idIn(row) });
    } else if (row.type === "status_add") {
      const status = template.statuses.find((s) => s.name === row.name);
      if (status === undefined) throw new Error(`${row.id} has no status`);
      addStatuses.push(status);
      roleChanges.push({
        kind: "added",
        key: status.name,
        status,
        role: status.chart_role,
      });
    } else if (row.type === "status_recolour") {
      update(idIn(row), { color: row.to });
    } else if (row.type === "status_change") {
      const id = idIn(row);
      // A row may change the chart role alone, which writes no column here.
      if (row.category) update(id, { category: row.category.to });
      const target = template.statuses.find((s) => keyOf(s) === id);
      if (target === undefined) throw new Error(`${row.id} has no status`);
      // The role the status ends up counting as has to be the template's.
      // With the category changing, a role nobody stored follows the new
      // category's default, so it is stored whenever that default differs.
      if (
        row.chart_role ||
        (row.category &&
          defaultInsightsRole({ name: row.name, category: row.category.to }) !==
            target.chart_role)
      ) {
        roleChanges.push({ kind: "edited", key: id, role: target.chart_role });
      }
    } else if (row.type === "label_delete") {
      deleteLabelIds.push(idIn(row));
    } else if (row.type === "label_add") {
      addLabels.push({ name: row.name, color: row.color });
    } else if (row.type === "label_change") {
      updateLabels.push({ id: idIn(row), color: row.to });
    }
  }

  // A deletion skipped keeps its status in its place, and the line on it.
  const done = applyResult(
    layout,
    new Set([...chosen].filter((id) => !skipped.includes(id))),
  );
  return {
    deleteLabelIds,
    deleteStatusIds,
    skipped,
    addStatuses,
    updateStatuses: [...updates.values()],
    order: done.order,
    ...(chosen.has("status.default") && { defaultStatus: done.default }),
    line: done.line,
    lineChanged: done.lineChanged,
    roleChanges,
    addLabels,
    updateLabels,
  };
}

/** JSON with every object's keys sorted, so equal values hash equal. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : v,
  );
}

/**
 * Which rules a plan's rows and its apply follow. Raised whenever the kinds
 * of row, their fields or what applying them comes to change, so that a
 * preview made before an upgrade is refused once after it rather than
 * carried out under rules it was not drawn by. The digests before 2 hashed
 * none.
 */
export const TEMPLATE_APPLY_RULES = 2;

/**
 * What a plan was computed from, hashed: the project's statuses, line,
 * stored roles and labels, the template with its revision, and the rules.
 * Issue counts are left out — anyone editing a card would otherwise void
 * every preview — so a status that took issues after the preview is skipped
 * instead.
 */
export function templateApplyDigest(
  state: ProjectState,
  template: TemplateBody,
  revision: number,
  rules = TEMPLATE_APPLY_RULES,
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        statuses: [...state.statuses]
          .sort((a, b) => a.id - b.id)
          .map((s) => ({
            id: s.id,
            name: s.name,
            category: s.category,
            color: s.color,
            position: s.position,
            is_default: s.isDefault,
          })),
        line: state.lineId,
        saved: state.saved,
        labels: [...state.labels]
          .sort((a, b) => a.id - b.id)
          .map((l) => ({ id: l.id, name: l.name, color: l.color })),
        template,
        revision,
        rules,
      }),
    )
    .digest("base64url");
}

/**
 * `labelCounts` reads how many cards carry each label, which only the
 * preview shows: the apply leaves them out, so a card relabelled meanwhile
 * does not conflict with its serializable transaction.
 */
async function readState(
  db: Db,
  projectId: number,
  { labelCounts }: { labelCounts: boolean },
): Promise<ProjectState> {
  // One after another: inside the apply's transaction these share a single
  // connection, which takes one query at a time.
  const statusRows = await db
    .select()
    .from(statuses)
    .where(eq(statuses.projectId, projectId))
    .orderBy(asc(statuses.position), asc(statuses.id));
  const meta = await db
    .select({ lineId: projectMeta.blockClearStatusId })
    .from(projectMeta)
    .where(eq(projectMeta.projectId, projectId));
  const saved = await db
    .select()
    .from(insightsSettings)
    .where(eq(insightsSettings.projectId, projectId));
  const labelRows = await db
    .select()
    .from(labels)
    .where(eq(labels.projectId, projectId));
  const statusUsage = await statusUsageRows(db, projectId);
  const labelUsage = labelCounts ? await labelUsageRows(db, projectId) : [];
  // Deleting a label takes it off trashed cards too, which the Labels
  // page's count leaves out.
  const labelTrash = !labelCounts
    ? []
    : await db
        .select({
          id: issueLabels.labelId,
          trashed: sql<number>`count(*)::int`,
        })
        .from(issueLabels)
        .innerJoin(
          issues,
          and(eq(issues.id, issueLabels.issueId), isNotNull(issues.deletedAt)),
        )
        .innerJoin(labels, eq(labels.id, issueLabels.labelId))
        .where(eq(labels.projectId, projectId))
        .groupBy(issueLabels.labelId);
  const roleOf = new Map(
    insightsSettingsResponse(statusRows, saved[0]).roles.map((entry) => [
      entry.status_id,
      entry.role,
    ]),
  );
  const statusUses = new Map(statusUsage.map((u) => [u.id, u]));
  const labelUses = new Map(labelUsage.map((u) => [u.id, u.issues]));
  const labelTrashed = new Map(labelTrash.map((u) => [u.id, u.trashed]));
  const row = saved[0];
  return {
    statuses: statusRows.map((s) => ({
      id: s.id,
      name: s.name,
      category: s.category,
      color: s.color,
      position: s.position,
      isDefault: s.isDefault,
      role: roleOf.get(s.id) as Role,
      issues: statusUses.get(s.id)?.issues ?? 0,
      trashed: statusUses.get(s.id)?.trashed ?? 0,
    })),
    lineId: meta[0]?.lineId ?? null,
    saved: row ? { revision: row.revision, roles: row.roles } : null,
    labels: labelRows.map((l) => ({
      id: l.id,
      name: l.name,
      color: l.color,
      issues: labelUses.get(l.id) ?? 0,
      trashed: labelTrashed.get(l.id) ?? 0,
    })),
  };
}

export async function previewTemplateApply(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  ref: TemplateRef,
): Promise<TemplateApplyPlan> {
  const { project } = await requireCapability(
    ctx,
    actor,
    slug,
    "status.manage",
  );
  const template = await resolveTemplate(ctx, actor, ref);
  const db = await ctx.router.forProject(routeInfoOf(project));
  const state = await readState(db, project.id, { labelCounts: true });
  return {
    expected: templateApplyDigest(state, template.body, template.revision),
    project: projectSnapshot(state),
    template: template.body,
    changes: planTemplateApply(state, template.body),
  };
}

type Written = {
  outcome: ApplyOutcome;
  created: number[];
  updated: number[];
  orderChanged: boolean;
  categoryChanged: boolean;
  rolesChanged: boolean;
  labelsCreated: number[];
};

/**
 * Carries out the selected rows of a preview, provided the project and the
 * template are still what the preview was computed from. Serializable, so a
 * write landing on anything it read between the check and the commit fails
 * it, and the retry then finds the digest changed. A card moved into a status
 * after the read is the exception: the foreign key check reads the latest
 * committed cards, not the snapshot, so deleting that status fails as a
 * foreign key violation (23503), not a serialization failure. A card's
 * status is the only foreign key this transaction can break, so that is
 * retried too, and the retry reads the card and skips the status as in use.
 */
export async function applyTemplate(
  ctx: AppContext,
  actor: UserRow,
  slug: string,
  input: TemplateApplyInput,
): Promise<TemplateApplyResult> {
  const { project } = await requireCapability(
    ctx,
    actor,
    slug,
    "status.manage",
  );
  const template = await resolveTemplate(ctx, actor, input.template);
  const db = await ctx.router.forProject(routeInfoOf(project));

  const written = await inSerializableTransaction(
    db,
    "the project is busy — preview again shortly",
    async (tx) => {
      const state = await readState(tx, project.id, { labelCounts: false });
      if (
        templateApplyDigest(state, template.body, template.revision) !==
        input.expected
      ) {
        throw new ConflictError("project or template changed — preview again");
      }
      const rows = planTemplateApply(state, template.body);
      const outcome = applySelection(
        state,
        template.body,
        rows,
        input.selected,
        input.drawn,
      );
      return write(tx, project.id, state, outcome);
    },
    ["23503"],
  ).catch((cause: unknown) => {
    // A status or label of the same name created since the read: outside
    // serializable, so it reaches the insert as a duplicate, not a conflict.
    // Any other index refusing the write is a bug, and stays a 500.
    const index = uniqueViolation(cause);
    if (index !== STATUS_NAME_INDEX && index !== LABEL_NAME_INDEX) {
      throw cause;
    }
    throw new ConflictError("project or template changed — preview again");
  });

  const { outcome } = written;
  if (written.orderChanged || written.categoryChanged || outcome.lineChanged) {
    const changes = await reevaluateProjectBlocks(ctx, project, db);
    await announceBlockChanges(ctx, changes, actor.id);
  }
  const publish = (
    entity: "status" | "label" | "project",
    id: number,
    action: "created" | "updated" | "deleted",
  ) => ctx.bus.publish(project.id, { entity, id, action });
  for (const id of outcome.deleteLabelIds) publish("label", id, "deleted");
  for (const id of outcome.deleteStatusIds) publish("status", id, "deleted");
  for (const id of written.created) publish("status", id, "created");
  for (const id of written.updated) publish("status", id, "updated");
  for (const id of written.labelsCreated) publish("label", id, "created");
  for (const { id } of outcome.updateLabels) publish("label", id, "updated");
  if (outcome.lineChanged || written.rolesChanged) {
    publish("project", project.id, "updated");
  }
  return { skipped: outcome.skipped };
}

async function write(
  tx: Tx,
  projectId: number,
  state: ProjectState,
  outcome: ApplyOutcome,
): Promise<Written> {
  // Locks before any write, in the order every writer of these tables
  // takes them — project_meta, then statuses, then labels, each set by id —
  // so this cannot wait on a transaction that is waiting on it. Creating an
  // issue holds project_meta for its number before its foreign keys share-
  // lock a status and labels.
  //
  // The rows are locked for a no-key update, which leaves the key share a
  // card write takes on its status or label free: a card edit dropping a
  // label this deletes, then moving to a status, would otherwise wait on the
  // status while the delete's cascade waits on the edit. The deletes below
  // take the stronger lock themselves, on the rows nobody may still use.
  await tx
    .select({ id: projectMeta.projectId })
    .from(projectMeta)
    .where(eq(projectMeta.projectId, projectId))
    .for("no key update");
  // Every status, since nearly every position is rewritten.
  await tx
    .select({ id: statuses.id })
    .from(statuses)
    .where(eq(statuses.projectId, projectId))
    .orderBy(asc(statuses.id))
    .for("no key update");
  const touchedLabels = [
    ...outcome.deleteLabelIds,
    ...outcome.updateLabels.map((l) => l.id),
  ];
  if (touchedLabels.length > 0) {
    await tx
      .select({ id: labels.id })
      .from(labels)
      .where(
        and(eq(labels.projectId, projectId), inArray(labels.id, touchedLabels)),
      )
      .orderBy(asc(labels.id))
      .for("no key update");
  }

  if (outcome.deleteLabelIds.length > 0) {
    // issue_labels goes with it, by its foreign key.
    await tx
      .delete(labels)
      .where(
        and(
          eq(labels.projectId, projectId),
          inArray(labels.id, outcome.deleteLabelIds),
        ),
      );
  }
  if (outcome.deleteStatusIds.length > 0) {
    await tx
      .delete(statuses)
      .where(
        and(
          eq(statuses.projectId, projectId),
          inArray(statuses.id, outcome.deleteStatusIds),
        ),
      );
  }

  const idOf = new Map<StatusKey, number>(
    state.statuses.map((s) => [s.id, s.id]),
  );
  const created: number[] = [];
  if (outcome.addStatuses.length > 0) {
    // At the end for now; the positions are all rewritten below.
    const end = state.statuses.length;
    const inserted = await tx
      .insert(statuses)
      .values(
        outcome.addStatuses.map((s, i) => ({
          projectId,
          name: s.name,
          category: s.category,
          color: s.color,
          position: end + i,
        })),
      )
      .returning({ id: statuses.id, name: statuses.name });
    for (const row of inserted) {
      idOf.set(row.name, row.id);
      created.push(row.id);
    }
  }
  const idFor = (key: StatusKey): number => {
    const id = idOf.get(key);
    // Every key names a status the project had or was just given.
    if (id === undefined) throw new Error(`no status for ${String(key)}`);
    return id;
  };
  const resolve = (key: StatusKey | null) => (key === null ? null : idFor(key));

  const updated = new Set<number>();
  for (const change of outcome.updateStatuses) {
    await tx
      .update(statuses)
      .set({
        ...(change.color === undefined ? {} : { color: change.color }),
        ...(change.category === undefined ? {} : { category: change.category }),
      })
      .where(eq(statuses.id, change.id));
    updated.add(change.id);
  }

  const positionOf = new Map(state.statuses.map((s) => [s.id, s.position]));
  for (const [position, key] of outcome.order.entries()) {
    const id = idFor(key);
    if (positionOf.get(id) === position) continue;
    await tx.update(statuses).set({ position }).where(eq(statuses.id, id));
    if (positionOf.has(id)) updated.add(id);
  }
  // Which side of the line a card is on follows the order of the statuses
  // that were there; renumbering them in the same order changes nothing.
  const kept = state.statuses
    .map((s) => s.id)
    .filter((id) => !outcome.deleteStatusIds.includes(id));
  const keptNow = outcome.order.filter(
    (key): key is number => typeof key === "number",
  );
  const orderChanged = kept.some((id, i) => keptNow[i] !== id);

  if (outcome.defaultStatus !== undefined) {
    const target = resolve(outcome.defaultStatus);
    for (const s of state.statuses) {
      if (
        s.isDefault &&
        s.id !== target &&
        !outcome.deleteStatusIds.includes(s.id)
      ) {
        await tx
          .update(statuses)
          .set({ isDefault: false })
          .where(eq(statuses.id, s.id));
        updated.add(s.id);
      }
    }
    if (target !== null) {
      await tx
        .update(statuses)
        .set({ isDefault: true })
        .where(eq(statuses.id, target));
      updated.add(target);
    }
  }

  const changes: RoleChange[] = outcome.roleChanges.map((change) => ({
    ...change,
    statusId: idFor(change.key),
  }));
  const current = state.saved?.roles ?? {};
  const roles = storedRoles(current, changes);
  const rolesChanged = canonicalJson(roles) !== canonicalJson(current);
  if (rolesChanged) {
    await swapRoles(tx, await ensureSettingsRow(tx, projectId), roles);
  }

  const labelsCreated: number[] = [];
  if (outcome.addLabels.length > 0) {
    const inserted = await tx
      .insert(labels)
      .values(outcome.addLabels.map((l) => ({ projectId, ...l })))
      .returning({ id: labels.id });
    labelsCreated.push(...inserted.map((row) => row.id));
  }
  for (const change of outcome.updateLabels) {
    await tx
      .update(labels)
      .set({ color: change.color })
      .where(eq(labels.id, change.id));
  }

  if (outcome.lineChanged) {
    await tx
      .update(projectMeta)
      .set({ blockClearStatusId: resolve(outcome.line) })
      .where(eq(projectMeta.projectId, projectId));
  }

  return {
    outcome,
    created,
    updated: [...updated].filter((id) => !created.includes(id)),
    orderChanged,
    categoryChanged: outcome.updateStatuses.some(
      (c) => c.category !== undefined,
    ),
    rolesChanged,
    labelsCreated,
  };
}
