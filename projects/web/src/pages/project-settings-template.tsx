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
  type ProjectTemplate,
  type TemplateApplyInput,
  type TemplateApplyResult,
  TemplateRef,
  TodouError,
} from "@todou/shared";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { invalidateInsights } from "@/api/insights.ts";
import {
  api,
  projectQuery,
  projectTemplatesQuery,
  useCan,
} from "@/api/queries.ts";
import { plural } from "@/components/settings/status-set-list.tsx";
import {
  ApplyBar,
  ApplySummary,
  PreparingPlan,
} from "@/components/settings/template-apply-bar.tsx";
import { ApplyTable } from "@/components/settings/template-apply-table.tsx";
import {
  PICKER_FRAME,
  TemplateListbox,
  usable,
} from "@/components/start-from-picker.tsx";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { labelTable, statusTable } from "@/lib/template-apply-table.ts";
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
 * template previews again by changing the key. Nothing is read until a
 * template is picked.
 */
const previewQuery = (slug: string, template: TemplateRef | null) =>
  queryOptions({
    queryKey: [...previewKey(slug), template] as const,
    queryFn: () => api.previewTemplateApply(slug, template as TemplateRef),
    enabled: template !== null,
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
 * earlier plan, else as the server starts it (everything but deletions).
 * Then a row that cannot be selected is off, and so is a row whose
 * requirement is.
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

/** Where the page keeps the reader's picks while it asks for a reload. */
const reloadKey = (slug: string) => `todou:apply-template:${slug}`;

const Kept = z.object({
  template: TemplateRef,
  rows: z.array(z.tuple([z.string(), z.boolean()])),
});
type Kept = z.infer<typeof Kept>;

/**
 * What the page kept for `slug` before a reload, provided its template can
 * still be applied. Anything unreadable is as good as nothing kept.
 */
function keptFor(
  slug: string,
  templates: readonly ProjectTemplate[],
): Kept | null {
  try {
    const raw = sessionStorage.getItem(reloadKey(slug));
    if (raw === null) return null;
    const kept = Kept.safeParse(JSON.parse(raw));
    if (!kept.success) return null;
    const ref = kept.data.template;
    return templates.some((t) => t.ref === ref && usable(t)) ? kept.data : null;
  } catch {
    return null;
  }
}

function ApplyTemplateSection({ slug }: { slug: string }) {
  const templates = useSuspenseQuery(projectTemplatesQuery);
  // What the reader had picked when the page last asked to be reloaded;
  // otherwise none, and a preview is read only for a template they pick.
  const [kept] = useState(() => keptFor(slug, templates.data));
  const [template, setTemplate] = useState<TemplateRef | null>(
    kept?.template ?? null,
  );
  const preview = useQuery(previewQuery(slug, template));
  const queryClient = useQueryClient();

  // A server older than this page sends a plan without the project and the
  // template the table is drawn from: a page loaded during a deploy or after
  // a rollback, which has nothing to draw until reloaded.
  const older =
    preview.data !== undefined &&
    (preview.data.project === undefined || preview.data.template === undefined);
  // The server worked the apply out otherwise than this page drew it: the
  // two run different code, and previewing again would draw the same.
  const [mismatch, setMismatch] = useState(false);
  const plan =
    template === null || older || mismatch ? undefined : preview.data;
  // A row of a kind this page does not know is left off: it would be
  // applied without the reader having seen what it does.
  const rows =
    plan?.changes.filter((row) => ChangeRow.safeParse(row).success) ?? [];
  // The rows the reader turned on or off, by id, for this template. A
  // refetch brings another plan whenever the project or the template
  // changed; a row the reader turned off must stay off in it, or Apply
  // would carry it out unseen. Rows nobody touched follow the server.
  const [choices, setChoices] = useState<{
    template: TemplateRef;
    rows: ReadonlyMap<string, boolean>;
  } | null>(() =>
    kept === null
      ? null
      : { template: kept.template, rows: new Map(kept.rows) },
  );
  // Labels coming off cards are asked about once more before Apply: while
  // it asks, the question as it was when it opened.
  const [asked, setAsked] = useState<string | null>(null);
  const confirming = asked !== null;
  // The question was withdrawn because what it would say changed.
  const [moved, setMoved] = useState(false);
  const chosen =
    choices?.template === template ? choices.rows : new Map<string, boolean>();
  const selected =
    plan === undefined ? new Set<string>() : selectedIn(rows, chosen);
  // While the page asks for a reload, what the reader picked is kept for the
  // reloaded page, however it is reloaded.
  const keep =
    (older || mismatch) && template !== null
      ? JSON.stringify({ template, rows: [...chosen] } satisfies Kept)
      : null;
  // Otherwise nothing is kept: what was kept is used once, on mounting,
  // and given up once the page no longer asks to be reloaded.
  useEffect(() => {
    try {
      if (keep === null) sessionStorage.removeItem(reloadKey(slug));
      else sessionStorage.setItem(reloadKey(slug), keep);
    } catch {
      // Storage refused: the reloaded page starts with nothing picked.
    }
  }, [slug, keep]);
  const select = (ids: readonly string[], on: boolean) => {
    if (plan === undefined || template === null) return;
    const next = withRows(rows, selected, ids, on);
    const touched = rows.filter(
      (row) => next.has(row.id) !== selected.has(row.id),
    );
    setAsked(null);
    setMoved(false);
    setChoices({
      template,
      rows: new Map([
        ...chosen,
        ...touched.map((row) => [row.id, next.has(row.id)] as const),
      ]),
    });
  };
  const pick = (ref: TemplateRef | null) => {
    setTemplate(ref);
    setAsked(null);
    setMoved(false);
    // Picking the template again to leave it forgets what was ticked in it.
    if (ref === null) setChoices(null);
  };

  // Drawn from the plan's own project and template, the ones the apply
  // works from, so that what Apply sends as drawn is what it will find.
  const statuses = plan && statusTable(plan, rows, selected);
  const labels = plan ? labelTable(plan, rows, selected) : [];
  const ticked = rows.filter((row) => selected.has(row.id));
  const deletes = ticked.filter((row) => row.action === "delete");
  const asks = deletes.some(
    (row) => row.type === "label_delete" && row.issues + row.trashed > 0,
  );
  // What the page shows each ticked label deletion coming off, which the
  // apply holds it to.
  const shown = ticked.flatMap((row) =>
    row.type === "label_delete"
      ? [[row.id, row.issues + row.trashed] as const]
      : [],
  );
  // What the question would say now: the changes Apply makes, and the cards
  // each ticked label comes off, known by id.
  const question = JSON.stringify([ticked.length, shown]);

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
      setAsked(null);
      const text = appliedText(vars.input.selected, result, vars.rows);
      if (result.skipped.length > 0) toast.warning(text);
      else toast.success(text);
    },
    onError: (error, vars) => {
      setAsked(null);
      if (error instanceof TodouError && error.code === "drawn_mismatch") {
        setMismatch(true);
        return;
      }
      if (error instanceof TodouError && error.status === 409) {
        toast.error(STALE);
        setChoices(forgetTicks);
        queryClient.invalidateQueries({ queryKey: previewKey(vars.slug) });
        return;
      }
      toast.error(error.message);
    },
  });

  // A preview read again can change what the question would say. It is
  // withdrawn in this same render: an effect would come a frame late, a
  // frame in which the question shows what it never asked and can be
  // confirmed. Once answered, the apply on its way carries what it said,
  // which the server checks.
  if (asked !== null && asked !== question && !apply.isPending) {
    setAsked(null);
    setMoved(true);
  }

  const send = () => {
    if (plan === undefined || template === null || statuses === undefined) {
      return;
    }
    const { result } = statuses;
    apply.mutate({
      slug,
      input: {
        template,
        expected: plan.expected,
        selected: ticked.map((row) => row.id),
        drawn: {
          order: result.order,
          line: result.line,
          default: result.default,
        },
        ...(shown.length > 0 && { label_issues: Object.fromEntries(shown) }),
      },
      rows,
    });
  };

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Apply a template</h2>
      <TemplateListbox
        templates={templates.data}
        value={template}
        onChange={pick}
        allowDeselect
        idPrefix="apply-template"
        className={cn("max-w-xl", PICKER_FRAME)}
        listClassName="max-h-56"
      />
      {template === null ? null : preview.isError ? (
        <p className="text-sm text-destructive">{preview.error.message}</p>
      ) : older || mismatch ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="text-sm text-destructive">
            {mismatch
              ? "This page and the server apply templates differently."
              : "The server is older than this page."}
          </p>
          <Button variant="outline" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      ) : plan?.changes.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          This project already matches this template.
        </p>
      ) : (
        <>
          {plan === undefined || statuses === undefined ? (
            <PreparingPlan />
          ) : (
            <>
              <ApplySummary rows={rows} selected={selected} />
              <ApplyTable
                // What the reader lit or unfolded belongs to one plan's rows.
                key={`${String(template)}:${plan.expected}`}
                plan={plan}
                rows={rows}
                statuses={statuses}
                labels={labels}
                selected={selected}
                onSelect={select}
              />
            </>
          )}
          <ApplyBar
            count={ticked.length}
            deletes={deletes}
            projectLabels={plan?.project.labels ?? []}
            confirming={confirming}
            disabled={
              plan === undefined || preview.isFetching || apply.isPending
            }
            onApply={() => {
              setMoved(false);
              if (asks) setAsked(question);
              else send();
            }}
            onConfirm={send}
            onCancel={() => setAsked(null)}
            moved={moved}
          />
        </>
      )}
    </section>
  );
}

/** The longest name a template takes; a project's may be twice as long. */
const NAME_MAX = 100;

/** `name` cut to what a template name holds, never mid-character. */
const fitName = (name: string) =>
  name.slice(0, NAME_MAX).replace(/[\uD800-\uDBFF]$/, "");

function SaveAsTemplateSection({ slug }: { slug: string }) {
  const project = useSuspenseQuery(projectQuery(slug));
  // null = untouched; the field shows the project's name until edited.
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? fitName(project.data.name);
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
