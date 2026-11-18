import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import {
  ChangeRow,
  type Label as LabelEntity,
  type StatusRef,
  type TemplateApplyInput,
  type TemplateApplyResult,
  type TemplateRef,
  TodouError,
} from "@todou/shared";
import { type ReactNode, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { invalidateInsights } from "@/api/insights.ts";
import { prefsQuery } from "@/api/prefs.ts";
import {
  api,
  projectQuery,
  projectTemplatesQuery,
  statusesQuery,
  useCan,
} from "@/api/queries.ts";
import { LabelChip } from "@/components/issue/label-chip.tsx";
import { StatusPill } from "@/components/issue/status-pill.tsx";
import {
  exceptionText,
  plural,
} from "@/components/settings/status-set-list.tsx";
import {
  preferredTemplate,
  TemplateListbox,
} from "@/components/start-from-picker.tsx";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { useCreateTemplate } from "@/pages/project-templates-settings.tsx";

/** Under /projects/$slug/settings/template. */
export function ProjectSettingsTemplatePage() {
  const { slug } = useParams({ from: "/authed/projects/$slug" });
  return <ProjectTemplateSection slug={slug} />;
}

/**
 * A project's Template page: apply one of the viewer's templates to the
 * project, or save the project as a new one.
 */
export function ProjectTemplateSection({ slug }: { slug: string }) {
  // Applying needs the capability the preview and the apply are gated on;
  // without it there is nothing here to look at but the other section.
  const canApply = useCan(slug, "status.manage");
  return (
    // Keyed so what the reader set on one project never reaches another.
    <div key={slug} className="space-y-10">
      {canApply && <ApplyTemplateSection slug={slug} />}
      <SaveAsTemplateSection slug={slug} />
    </div>
  );
}

const previewKey = (slug: string) => ["template-preview", slug] as const;

/**
 * A POST, but one that writes nothing: read as a query, so picking another
 * template previews again by changing the key.
 */
const previewQuery = (slug: string, template: TemplateRef) =>
  queryOptions({
    queryKey: [...previewKey(slug), template] as const,
    queryFn: () => api.previewTemplateApply(slug, template),
  });

/**
 * `selected` with the rows of `ids` turned on or off, and the rows they hang
 * on following: turning a row on turns on the rows it requires, turning one
 * off turns off the rows that require it. A row that cannot be selected
 * stays off.
 */
function withRows(
  rows: readonly ChangeRow[],
  selected: ReadonlySet<string>,
  ids: readonly string[],
  on: boolean,
): Set<string> {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const next = new Set(selected);
  const pending = [...ids];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (on) {
      const row = byId.get(id);
      if (row === undefined || !row.selectable || next.has(id)) continue;
      next.add(id);
      pending.push(...row.requires);
    } else if (next.delete(id)) {
      for (const row of rows) {
        if (row.requires.includes(id)) pending.push(row.id);
      }
    }
  }
  return next;
}

/**
 * What a plan starts selected: each row as `choices` holds it from an
 * earlier plan, else as the server starts it (additions and changes, no
 * deletion). Then a row that cannot be selected is off, and so is a row
 * whose requirement is.
 */
function selectedIn(
  rows: readonly ChangeRow[],
  choices: ReadonlyMap<string, boolean>,
): Set<string> {
  const off = rows
    .filter(
      (row) =>
        !row.selectable || !(choices.get(row.id) ?? row.default_selected),
    )
    .map((row) => row.id);
  return withRows(rows, new Set(rows.map((row) => row.id)), off, false);
}

/**
 * The reader's choices once an apply has run or been refused: what they
 * turned off stays off in the next plan, so a change they left out is not
 * carried out by the next Apply; what they turned on goes back to the
 * server's default, so a deletion skipped now does not stay armed for it.
 */
function forgetTicks<T extends { rows: ReadonlyMap<string, boolean> }>(
  choices: T | null,
): T | null {
  if (choices === null) return null;
  return {
    ...choices,
    rows: new Map([...choices.rows].filter(([, on]) => !on)),
  };
}

const STALE =
  "Nothing was applied: the project or the template changed since the preview.";

/** What an apply did, from what it answered. */
function appliedText(
  selected: readonly string[],
  result: TemplateApplyResult,
  rows: readonly ChangeRow[],
): string {
  const done = selected.length - result.skipped.length;
  const kept = result.skipped.flatMap((id) => {
    const row = rows.find((r) => r.id === id);
    return row?.type === "status_delete" ? [row.name] : [];
  });
  const text =
    done > 0 ? `Applied ${plural(done, "change")}.` : "Nothing was applied.";
  if (kept.length === 0) return text;
  const one = kept.length === 1;
  return `${text} ${kept.join(", ")} ${one ? "was" : "were"} not deleted: ${one ? "it has" : "they have"} issues now.`;
}

function ApplyTemplateSection({ slug }: { slug: string }) {
  const templates = useSuspenseQuery(projectTemplatesQuery);
  const prefs = useSuspenseQuery(prefsQuery);
  const [template, setTemplate] = useState<TemplateRef>(() =>
    preferredTemplate(templates.data, prefs.data.new_project_template),
  );
  const preview = useQuery(previewQuery(slug, template));
  // Where a new status goes is named by the status before it, which the
  // project has, or the template adds.
  const statuses = useQuery(statusesQuery(slug));
  const queryClient = useQueryClient();

  const plan = preview.data;
  // A row of a kind this page does not know is left off: it would be
  // applied without the reader having seen what it does.
  const rows = useMemo(
    () => plan?.changes.filter((row) => ChangeRow.safeParse(row).success) ?? [],
    [plan],
  );
  // The rows the reader turned on or off, by id, for this template. A
  // refetch brings another plan whenever the project or the template
  // changed; a row the reader turned off must stay off in it, or Apply
  // would carry it out unseen. Rows nobody touched follow the server.
  const [choices, setChoices] = useState<{
    template: TemplateRef;
    rows: ReadonlyMap<string, boolean>;
  } | null>(null);
  const chosen =
    choices?.template === template ? choices.rows : new Map<string, boolean>();
  const selected =
    plan === undefined ? new Set<string>() : selectedIn(rows, chosen);
  const select = (ids: readonly string[], on: boolean) => {
    if (plan === undefined) return;
    const next = withRows(rows, selected, ids, on);
    const touched = rows.filter(
      (row) => next.has(row.id) !== selected.has(row.id),
    );
    setChoices({
      template,
      rows: new Map([
        ...chosen,
        ...touched.map((row) => [row.id, next.has(row.id)] as const),
      ]),
    });
  };

  const body = templates.data.find((t) => t.ref === template)?.body;
  const faceOf = (name: string): StatusRef | null =>
    statuses.data?.find((status) => status.name === name) ??
    body?.statuses.find((status) => status.name === name) ??
    null;

  const apply = useMutation({
    mutationFn: (vars: {
      slug: string;
      input: TemplateApplyInput;
      rows: readonly ChangeRow[];
    }) => api.applyTemplate(vars.slug, vars.input),
    onSuccess: (result, vars) => {
      const { slug } = vars;
      queryClient.invalidateQueries({ queryKey: ["statuses", slug] });
      queryClient.invalidateQueries({ queryKey: ["labels", slug] });
      queryClient.invalidateQueries({ queryKey: projectQuery(slug).queryKey });
      void invalidateInsights(queryClient, slug);
      // Cards carry status and label names and colours, and a blocked badge
      // that moves with the order and the line.
      queryClient.invalidateQueries({ queryKey: ["issues"] });
      queryClient.invalidateQueries({ queryKey: ["issue"] });
      queryClient.invalidateQueries({ queryKey: previewKey(slug) });
      setChoices(forgetTicks);
      const text = appliedText(vars.input.selected, result, vars.rows);
      if (result.skipped.length > 0) toast.warning(text);
      else toast.success(text);
    },
    onError: (error, vars) => {
      if (error instanceof TodouError && error.status === 409) {
        toast.error(STALE);
        setChoices(forgetTicks);
        queryClient.invalidateQueries({ queryKey: previewKey(vars.slug) });
        return;
      }
      toast.error(error.message);
    },
  });

  const sectionProps = { selected, onSelect: select, faceOf };
  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Apply a template</h2>
      <TemplateListbox
        templates={templates.data}
        value={template}
        onChange={setTemplate}
        idPrefix="apply-template"
        className="max-w-xl rounded-md border"
        listClassName="max-h-56"
      />
      {preview.isError ? (
        <p className="text-sm text-destructive">{preview.error.message}</p>
      ) : plan?.changes.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          This project already matches this template.
        </p>
      ) : (
        <>
          <ChangeSection
            title="Statuses"
            rows={rows.filter((row) => row.section === "statuses")}
            {...sectionProps}
          />
          <ChangeSection
            title="Labels"
            rows={rows.filter((row) => row.section === "labels")}
            deleteNote="Deleted labels come off their cards; this cannot be undone."
            {...sectionProps}
          />
          <Button
            disabled={
              plan === undefined ||
              preview.isFetching ||
              selected.size === 0 ||
              apply.isPending
            }
            onClick={() => {
              if (plan === undefined) return;
              apply.mutate({
                slug,
                input: {
                  template,
                  expected: plan.expected,
                  selected: rows
                    .filter((row) => selected.has(row.id))
                    .map((row) => row.id),
                },
                rows,
              });
            }}
          >
            Apply {plural(selected.size, "change")}
          </Button>
        </>
      )}
    </section>
  );
}

const ACTIONS = [
  ["add", "Add"],
  ["change", "Change"],
  ["delete", "Delete"],
] as const;

type SectionProps = {
  selected: ReadonlySet<string>;
  onSelect: (ids: readonly string[], on: boolean) => void;
  faceOf: (name: string) => StatusRef | null;
};

/**
 * One section of the change list, its select-all boxes in the heading. The
 * deletions get a list of their own under the rest, `deleteNote` above it.
 */
function ChangeSection({
  title,
  rows,
  deleteNote,
  selected,
  onSelect,
  faceOf,
}: SectionProps & {
  title: string;
  rows: readonly ChangeRow[];
  deleteNote?: string;
}) {
  const headingId = useId();
  if (rows.length === 0) return null;
  const others = rows.filter((row) => row.action !== "delete");
  const deletions = rows.filter((row) => row.action === "delete");
  const list = (items: readonly ChangeRow[]) => (
    <ul className="divide-y rounded-lg border">
      {items.map((row) => (
        <ChangeItem
          key={row.id}
          row={row}
          checked={selected.has(row.id)}
          onChange={(on) => onSelect([row.id], on)}
          faceOf={faceOf}
        />
      ))}
    </ul>
  );
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h3 id={headingId} className="font-medium">
          {title}
        </h3>
        <div className="flex items-center gap-4">
          {ACTIONS.map(([action, text]) => {
            const ids = rows
              .filter((row) => row.action === action && row.selectable)
              .map((row) => row.id);
            const on = ids.filter((id) => selected.has(id)).length;
            const all = ids.length > 0 && on === ids.length;
            return (
              <Label
                key={action}
                className="cursor-pointer font-normal has-disabled:cursor-default has-disabled:opacity-60"
              >
                <Checkbox
                  checked={all}
                  indeterminate={on > 0 && !all}
                  disabled={ids.length === 0}
                  onChange={() => onSelect(ids, !all)}
                />
                {text}
              </Label>
            );
          })}
        </div>
      </div>
      {others.length > 0 && list(others)}
      {deletions.length > 0 && (
        <>
          {deleteNote && (
            <p className="pt-2 text-sm text-muted-foreground">{deleteNote}</p>
          )}
          {list(deletions)}
        </>
      )}
    </section>
  );
}

function ChangeItem({
  row,
  checked,
  onChange,
  faceOf,
}: {
  row: ChangeRow;
  checked: boolean;
  onChange: (on: boolean) => void;
  faceOf: SectionProps["faceOf"];
}) {
  const id = useId();
  return (
    <li>
      <label
        htmlFor={id}
        className={cn(
          "flex min-h-11 items-center gap-3 px-3 py-2",
          row.selectable && "cursor-pointer",
        )}
      >
        <Checkbox
          id={id}
          checked={checked}
          disabled={!row.selectable}
          aria-label={rowName(row)}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
          <RowText row={row} faceOf={faceOf} />
        </span>
      </label>
    </li>
  );
}

/** A row's box in words; the row itself draws its statuses and labels. */
function rowName(row: ChangeRow): string {
  if (row.type === "status_add") return `Add status ${row.name}`;
  if (row.type === "status_change") return `Change status ${row.name}`;
  if (row.type === "status_order") return "Reorder statuses";
  if (row.type === "status_default") return "Change the default status";
  if (row.type === "status_line") return "Move the block clear line";
  if (row.type === "status_delete") return `Delete status ${row.name}`;
  if (row.type === "label_add") return `Add label ${row.name}`;
  if (row.type === "label_change") return `Change label ${row.name}`;
  return `Delete label ${row.name}`;
}

const Muted = ({ children }: { children: ReactNode }) => (
  <span className="text-muted-foreground">{children}</span>
);

const Arrow = () => <Muted>→</Muted>;

/** A label as a row shows it; a row's label has no id, nor needs one. */
const chip = ({
  name,
  color,
}: {
  name: string;
  color: string;
}): LabelEntity => ({
  id: 0,
  name,
  color,
});

function Face({ status }: { status: StatusRef | null }) {
  return status === null ? <Muted>none</Muted> : <StatusPill status={status} />;
}

function issuesIn(issues: number, trashed: number): string {
  const total = issues + trashed;
  const verb = total === 1 ? "is" : "are";
  if (trashed === 0) return `${plural(total, "issue")} ${verb} in it`;
  if (issues === 0) return `${plural(total, "trashed issue")} ${verb} in it`;
  return `${plural(total, "issue")} ${verb} in it, ${trashed} trashed`;
}

function RowText({
  row,
  faceOf,
}: {
  row: ChangeRow;
  faceOf: SectionProps["faceOf"];
}) {
  if (row.type === "status_add") {
    const extra = exceptionText(row.category, row.chart_role);
    const anchor = row.after === null ? null : faceOf(row.after);
    return (
      <>
        <Muted>Add</Muted>
        <StatusPill status={row} />
        {extra && <Muted>{extra}</Muted>}
        {row.after === null ? (
          <Muted>first</Muted>
        ) : (
          anchor && (
            <>
              <Muted>after</Muted>
              <StatusPill status={anchor} />
            </>
          )
        )}
      </>
    );
  }
  if (row.type === "status_change") {
    const { name, color_now, color, category, chart_role } = row;
    return (
      <>
        <Muted>Change</Muted>
        <StatusPill status={{ name, color: color_now }} />
        {color && (
          <>
            <Arrow />
            <StatusPill status={{ name, color: color.to }} />
          </>
        )}
        {category && (
          <Muted>
            {category.from} → {category.to}
          </Muted>
        )}
        {chart_role && (
          <Muted>
            in burn charts: {chart_role.from} → {chart_role.to}
          </Muted>
        )}
      </>
    );
  }
  if (row.type === "status_order") {
    return (
      <span className="flex flex-col gap-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <Muted>Reorder</Muted>
          {/* A project's status names are unique, and these are its own. */}
          {row.from.map((status) => (
            <StatusPill key={status.name} status={status} />
          ))}
        </span>
        <span className="flex flex-wrap items-center gap-1.5">
          <Arrow />
          {row.to.map((status) => (
            <StatusPill key={status.name} status={status} />
          ))}
        </span>
      </span>
    );
  }
  if (row.type === "status_default" || row.type === "status_line") {
    return (
      <>
        <Muted>
          {row.type === "status_default" ? "Default status" : "Blocks clear at"}
        </Muted>
        <Face status={row.from} />
        <Arrow />
        <Face status={row.to} />
      </>
    );
  }
  if (row.type === "status_delete") {
    return (
      <>
        <Muted>Delete</Muted>
        <StatusPill status={row} />
        {!row.selectable && <Muted>{issuesIn(row.issues, row.trashed)}</Muted>}
      </>
    );
  }
  if (row.type === "label_add") {
    return (
      <>
        <Muted>Add</Muted>
        <LabelChip label={chip(row)} />
      </>
    );
  }
  if (row.type === "label_change") {
    return (
      <>
        <Muted>Change</Muted>
        <LabelChip label={chip({ name: row.name, color: row.from })} />
        <Arrow />
        <LabelChip label={chip({ name: row.name, color: row.to })} />
      </>
    );
  }
  return (
    <>
      <Muted>Delete</Muted>
      <LabelChip label={chip(row)} />
      <Muted>
        {row.issues === 0
          ? "on no issue"
          : `comes off ${plural(row.issues, "issue")}`}
      </Muted>
    </>
  );
}

/** The longest name a template takes; a project's may be twice as long. */
const NAME_MAX = 100;

function SaveAsTemplateSection({ slug }: { slug: string }) {
  const project = useSuspenseQuery(projectQuery(slug));
  // null = untouched; the field shows the project's name until edited.
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? project.data.name.slice(0, NAME_MAX);
  const name = value.trim();
  const save = useCreateTemplate();

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Save as template</h2>
      <form
        className="flex max-w-xl items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name !== "") save.mutate({ name, from_project: slug });
        }}
      >
        <div className="min-w-0 flex-1 space-y-2">
          <Label htmlFor="save-template-name">Name</Label>
          <Input
            id="save-template-name"
            value={value}
            maxLength={NAME_MAX}
            onChange={(e) => setDraft(e.target.value)}
            autoComplete="off"
          />
        </div>
        <Button type="submit" disabled={name === "" || save.isPending}>
          Save
        </Button>
      </form>
    </section>
  );
}
