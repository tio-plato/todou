import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  canonicalizeLabelName,
  defaultInsightsRole,
  LabelName,
  lineAfterDeleting,
  type ProjectTemplate,
  type ProjectTemplateCreateInput,
  type TemplateBody,
  type TemplateLabel,
  type TemplateStatus,
  TodouError,
} from "@todou/shared";
import { ArrowLeftIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { type ReactElement, useRef, useState } from "react";
import { toast } from "sonner";
import { prefsQuery, usePatchPrefs } from "@/api/prefs.ts";
import { api, projectsQuery, projectTemplatesQuery } from "@/api/queries.ts";
import { StatusPill } from "@/components/issue/status-pill.tsx";
import { LabelSetList } from "@/components/settings/label-set-list.tsx";
import {
  isRole,
  StatusSetList,
} from "@/components/settings/status-set-list.tsx";
import {
  preferredTemplate,
  type StartFrom,
  StartFromPicker,
  type UsableTemplate,
  usable,
} from "@/components/start-from-picker.tsx";
import {
  TemplateHoverCard,
  templateStatusSet,
} from "@/components/template-preview.tsx";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const templatesKey = projectTemplatesQuery.queryKey;

const DEFAULT_PILL =
  "rounded-full border px-2 py-0.5 text-xs text-muted-foreground";
const INCOMPATIBLE_PILL =
  "rounded-full border border-destructive/40 px-2 py-0.5 text-xs text-destructive";

const counted = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/** The account's project templates: the built-in ones, then its own. */
export function ProjectTemplatesSettingsPage() {
  const templates = useSuspenseQuery(projectTemplatesQuery);
  const prefs = useSuspenseQuery(prefsQuery);
  const patch = usePatchPrefs();
  const current = preferredTemplate(
    templates.data,
    prefs.data.new_project_template,
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Project templates</h1>
        <NewTemplateDialog templates={templates.data} />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Label
          htmlFor="new-project-template"
          className="font-normal text-muted-foreground"
        >
          New projects start from
        </Label>
        <Select
          value={String(current)}
          onValueChange={(value) => {
            // The ref as the prefs take it: a number for one of the
            // account's own, not the string the select keys it by.
            const picked = templates.data.find(
              (template) => String(template.ref) === value,
            );
            if (picked) patch.mutate({ new_project_template: picked.ref });
          }}
        >
          <SelectTrigger
            id="new-project-template"
            className="max-w-full min-w-0"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {templates.data.filter(usable).map((template) => (
              <SelectItem
                key={String(template.ref)}
                value={String(template.ref)}
              >
                {template.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <ul className="divide-y rounded-lg border">
        {templates.data.map((template) => (
          <li
            key={String(template.ref)}
            className="flex min-h-14 items-center gap-3 py-2 pr-2 pl-3"
          >
            <div className="min-w-0 flex-1">
              <PreviewOnHover template={template}>
                <div className="w-fit max-w-full space-y-0.5">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Link
                      to="/settings/templates/$template"
                      params={{ template: String(template.ref) }}
                      className="truncate font-medium underline-offset-3 hover:underline"
                    >
                      {template.name}
                    </Link>
                    {template.builtin && (
                      <Badge variant="outline">Built in</Badge>
                    )}
                    {template.ref === current && (
                      <span className={DEFAULT_PILL}>default</span>
                    )}
                    {template.body === null && (
                      <span className={INCOMPATIBLE_PILL}>Incompatible</span>
                    )}
                  </div>
                  {template.body !== null && <Summary body={template.body} />}
                </div>
              </PreviewOnHover>
            </div>
            {/* In every row, so that each row's text ends where the others'
                does: the previews line up on it. */}
            <div className="flex w-7 shrink-0 justify-end">
              {!template.builtin && (
                <DeleteTemplateButton template={template} />
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What a row says of a template: its size, and where its blocks clear. */
function Summary({ body }: { body: TemplateBody }) {
  const line = body.statuses.find((status) => status.block_clear);
  return (
    <div className="flex flex-wrap items-center gap-x-1 text-sm text-muted-foreground">
      {counted(body.statuses.length, "status", "statuses")}
      {" · "}
      {counted(body.labels.length, "label", "labels")}
      {" · Blocks clear at"}
      {line ? <StatusPill status={line} /> : " any closed status"}
    </div>
  );
}

/**
 * A row's text, which previews the template when it can be read. The card
 * opens beside the row's text column, its right edge on the column's, which
 * ends where the row's actions begin. The text itself is the trigger, so the
 * empty run of the column after it opens nothing.
 *
 * The buttons stay outside: the delete button's confirmation is in this
 * row's React tree, and its focus would bubble into a trigger around it and
 * open the preview over the dialog.
 */
function PreviewOnHover({
  template,
  children,
}: {
  template: ProjectTemplate;
  children: ReactElement;
}) {
  if (!usable(template)) return children;
  return (
    <TemplateHoverCard
      template={template}
      side="right"
      align="start"
      endAt={(trigger) => trigger.parentElement}
    >
      {children}
    </TemplateHoverCard>
  );
}

function DeleteTemplateButton({ template }: { template: ProjectTemplate }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: (id: number) => api.deleteProjectTemplate(id),
    onSuccess: (_data, id) => {
      // The default pill falls back to Default by itself when this was it.
      queryClient.setQueryData(templatesKey, (list) =>
        list?.filter((t) => t.ref !== id),
      );
      setOpen(false);
    },
    onError: (error) => toast.error(error.message),
  });
  const { ref } = template;
  if (typeof ref !== "number") return null;

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Delete ${template.name}`}
        className="text-muted-foreground hover:text-destructive"
        onClick={() => setOpen(true)}
      >
        <Trash2Icon className="size-4" />
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete this template?"
        description={
          <>
            <span className="font-medium text-foreground">{template.name}</span>
            {" — there is no undo."}
          </>
        }
        confirmLabel="Delete template"
        destructive
        pending={remove.isPending}
        onConfirm={() => remove.mutate(ref)}
      />
    </>
  );
}

/**
 * Creates a template, then opens its page; `onCreated` runs just before the
 * page opens.
 */
export function useCreateTemplate(onCreated?: () => void) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ProjectTemplateCreateInput) =>
      api.createProjectTemplate(input),
    onSuccess: (created) => {
      // In the list before the page that reads it from there opens; the
      // refetch then puts it in its place by name.
      queryClient.setQueryData(templatesKey, (list) =>
        list ? [...list, created] : list,
      );
      void queryClient.invalidateQueries({ queryKey: templatesKey });
      onCreated?.();
      void navigate({
        to: "/settings/templates/$template",
        params: { template: String(created.ref) },
      });
    },
    onError: (error) => toast.error(error.message),
  });
}

const START: StartFrom = {
  kind: "template",
  template: "default",
  project: null,
};

function NewTemplateDialog({
  templates,
}: {
  templates: readonly ProjectTemplate[];
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [from, setFrom] = useState<StartFrom>(START);
  const projects = useQuery(projectsQuery);
  const create = useCreateTemplate(() => setOpen(false));

  const trimmed = name.trim();
  // A template's body is copied from the list; a project is read by the
  // server as it stands when the request lands.
  const picked = templates.find((t) => t.ref === from.template);
  const source = picked !== undefined && usable(picked) ? picked : undefined;
  const input: ProjectTemplateCreateInput | null =
    trimmed === ""
      ? null
      : from.kind === "template"
        ? source
          ? { name: trimmed, body: source.body }
          : null
        : from.project !== null
          ? { name: trimmed, from_project: from.project }
          : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setName("");
          setFrom(START);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <PlusIcon /> New template
        </Button>
      </DialogTrigger>
      <DialogContent aria-describedby={undefined} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New template</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (input !== null) create.mutate(input);
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="new-template-name">Name</Label>
            <Input
              id="new-template-name"
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
              placeholder="Kanban"
              autoComplete="off"
              required
            />
          </div>
          <div className="space-y-2">
            <div className="text-sm leading-none font-medium">Start from</div>
            <StartFromPicker
              templates={templates}
              projects={projects.data ?? []}
              value={from}
              onChange={setFrom}
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={input === null || create.isPending}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ProjectTemplateSettingsPage() {
  const { template } = useParams({
    from: "/authed/settings/templates/$template",
  });
  return <ProjectTemplateSettings template={template} />;
}

/**
 * One template's page: `default` or an id. Read out of the list, which holds
 * every template whole.
 */
export function ProjectTemplateSettings({ template }: { template: string }) {
  const templates = useSuspenseQuery(projectTemplatesQuery);
  const found = templates.data.find((t) => String(t.ref) === template);
  if (found === undefined) {
    return (
      <div className="space-y-4">
        <BackToTemplates />
        <div className="rounded-lg border border-dashed p-10 text-center text-muted-foreground">
          You have no template at this address.
        </div>
      </div>
    );
  }
  if (!usable(found)) return <IncompatibleTemplate template={found} />;
  return <TemplateEditor key={template} template={found} />;
}

/**
 * A template this version cannot read: what is wrong with it, place by
 * place. It can be deleted from the list; nothing can be made from it.
 */
function IncompatibleTemplate({ template }: { template: ProjectTemplate }) {
  return (
    <div className="space-y-4">
      <BackToTemplates />
      <div className="flex min-w-0 items-center gap-2">
        <h1 className="truncate text-xl font-semibold">{template.name}</h1>
        <span className={INCOMPATIBLE_PILL}>Incompatible</span>
      </div>
      <p className="text-sm text-muted-foreground">
        This version of todou cannot read this template, so nothing can be made
        from it:
      </p>
      <ul className="divide-y rounded-lg border text-sm">
        {(template.problems ?? []).map((problem) => (
          <li
            key={`${problem.path}:${problem.message}`}
            className="flex flex-wrap gap-x-3 gap-y-1 px-3 py-2"
          >
            <code className="font-mono text-muted-foreground">
              {problem.path || "(template)"}
            </code>
            <span>{problem.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function BackToTemplates() {
  return (
    <Link
      to="/settings/templates"
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeftIcon className="size-4" aria-hidden />
      Project templates
    </Link>
  );
}

/** An edit, whole: the template as it is to be once the edit is saved. */
type Edit = {
  name: string;
  body: TemplateBody;
  /** `conflicts` when the edit was queued. */
  conflicts: number;
};

/** An edit queued behind a write refused as stale, and so never sent. */
class DroppedEdit extends Error {}

/**
 * Ids for what a template holds, which has none of its own. Kept by name —
 * unique among a template's statuses, and among its labels — so a row keeps
 * its id while it is dragged, edited or renamed. They live on this page only;
 * a write sends the body without them.
 */
function useLocalIds() {
  const [ids] = useState(() => {
    const byName = new Map<string, number>();
    let next = 1;
    return {
      of(name: string): number {
        let id = byName.get(name);
        if (id === undefined) {
          id = next++;
          byName.set(name, id);
        }
        return id;
      },
      rename(from: string, to: string) {
        const id = byName.get(from);
        if (id === undefined || from === to) return;
        byName.delete(from);
        byName.set(to, id);
      },
    };
  });
  return ids;
}

/** `status` with `mark` set or cleared; a template holds a mark only as true. */
function marked(
  status: TemplateStatus,
  mark: "is_default" | "block_clear",
  on: boolean,
): TemplateStatus {
  const next = { ...status };
  delete next[mark];
  return on ? { ...next, [mark]: true } : next;
}

/** In the order the server stores labels: an edit shows what a reload will. */
const sortedByName = (labels: TemplateLabel[]) =>
  labels.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

/**
 * Whether `name` is refused for one more of `kind` beside `others`, toasting
 * why in the words a project's own settings hear from the server. Checked
 * here because an edit shows before it is saved: a refusal from the server
 * would close the editor and lose the draft.
 */
function refused(
  kind: "status" | "label",
  others: readonly { name: string }[],
  name: string,
): boolean {
  if (kind === "label") {
    const parsed = LabelName.safeParse(name);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "invalid label name");
      return true;
    }
  }
  if (!others.some((other) => other.name === name)) return false;
  toast.error(`${kind} "${name}" already exists`);
  return true;
}

const STALE =
  "This template changed elsewhere — your last change was not saved.";

/**
 * A template's statuses and labels, in the lists a project's own settings
 * use. An edit shows at once and saves the whole template; the saves run one
 * after another, each sending the revision the one before it got back.
 */
function TemplateEditor({ template }: { template: UsableTemplate }) {
  const queryClient = useQueryClient();
  const { ref } = template;
  const canManage = !template.builtin;
  const statusIds = useLocalIds();
  const labelIds = useLocalIds();
  // Bumped by each write refused as stale. An edit queued before then was
  // made on the template as it was: sent with the revision the refetch
  // brings, it would put that back over whatever replaced it.
  const conflicts = useRef(0);
  // The revision the next write is sent on: the cached one when an edit is
  // queued with no write ahead of it, then each one a write got back. Never
  // one a refetch brings in mid-queue: the edits behind were made without
  // what it carries, and sent on it they would put that back.
  const base = useRef(template.revision);
  const scope = `project-template-${ref}`;
  const writing = () =>
    queryClient.isMutating({
      predicate: (m) => m.options.scope?.id === scope,
    });

  /** The template as the page shows it now, queued edits included. */
  const now = (): UsableTemplate => {
    const cached = queryClient
      .getQueryData(templatesKey)
      ?.find((t) => t.ref === ref);
    return cached !== undefined && usable(cached) ? cached : template;
  };

  const save = useMutation({
    scope: { id: scope },
    mutationFn: (edit: Edit) => {
      if (edit.conflicts !== conflicts.current || typeof ref !== "number") {
        return Promise.reject(new DroppedEdit());
      }
      return api.updateProjectTemplate(ref, {
        revision: base.current,
        name: edit.name,
        body: edit.body,
      });
    },
    onMutate: (edit) => {
      queryClient.setQueryData(templatesKey, (list) =>
        list?.map((t) =>
          t.ref === ref ? { ...t, name: edit.name, body: edit.body } : t,
        ),
      );
    },
    onSuccess: (saved) => {
      base.current = saved.revision;
      // With another edit queued the list already shows more than this one
      // saved, so only the revision is taken from it.
      const last = writing() === 1;
      queryClient.setQueryData(templatesKey, (list) =>
        list?.map((t) =>
          t.ref !== saved.ref
            ? t
            : last
              ? saved
              : { ...t, revision: saved.revision },
        ),
      );
    },
    onError: async (error) => {
      if (error instanceof DroppedEdit) return;
      const stale = error instanceof TodouError && error.status === 409;
      toast.error(stale ? STALE : error.message);
      try {
        await queryClient.invalidateQueries({
          queryKey: templatesKey,
          exact: true,
        });
      } finally {
        // Only once the refetch is in: an edit made before then was made on
        // the old template too.
        if (stale) conflicts.current += 1;
      }
    },
  });

  /** Queue a save of the template as it is now, with `next` in place. */
  function queue(next: { name?: string; body?: TemplateBody }) {
    const current = now();
    if (writing() === 0) base.current = current.revision;
    save.mutate({
      name: next.name ?? current.name,
      body: next.body ?? current.body,
      conflicts: conflicts.current,
    });
  }

  const { statuses, lineStatusId } = templateStatusSet(
    template.body.statuses,
    (status) => statusIds.of(status.name),
  );
  const labels = template.body.labels.map((label) => ({
    ...label,
    id: labelIds.of(label.name),
  }));

  return (
    <div className="space-y-10">
      <div className="space-y-4">
        <BackToTemplates />
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="truncate text-xl font-semibold">{template.name}</h1>
          {template.builtin && <Badge variant="outline">Built in</Badge>}
        </div>
        {canManage && (
          <TemplateNameForm
            name={template.name}
            onSave={(name) => queue({ name })}
          />
        )}
      </div>
      <StatusSetList
        statuses={statuses}
        lineStatusId={lineStatusId}
        canManage={canManage}
        template
        deleteBlock={() =>
          statuses.length === 1 ? "A template needs at least one status." : null
        }
        onArrange={(order) => {
          const { body } = now();
          const byId = new Map(
            body.statuses.map((status) => [statusIds.of(status.name), status]),
          );
          const line =
            order.block_clear_status_id === undefined
              ? body.statuses.find((status) => status.block_clear)
              : order.block_clear_status_id === null
                ? undefined
                : byId.get(order.block_clear_status_id);
          queue({
            body: {
              ...body,
              statuses: order.ids.flatMap((id) => {
                const status = byId.get(id);
                return status
                  ? [marked(status, "block_clear", status === line)]
                  : [];
              }),
            },
          });
        }}
        onSave={(id, draft) => {
          const { body } = now();
          const before = body.statuses.find(
            (status) => statusIds.of(status.name) === id,
          );
          const name = canonicalizeLabelName(draft.name);
          if (
            before === undefined ||
            (name !== before.name && refused("status", body.statuses, name))
          ) {
            return Promise.resolve(false);
          }
          const after = marked(
            {
              ...before,
              name,
              category: draft.category,
              color: draft.color,
              // A role from a newer server stays as it was until one is picked.
              chart_role: isRole(draft.role) ? draft.role : before.chart_role,
            },
            "is_default",
            draft.isDefault,
          );
          statusIds.rename(before.name, name);
          queue({
            body: {
              ...body,
              statuses: body.statuses.map((status) =>
                status === before
                  ? after
                  : draft.isDefault
                    ? marked(status, "is_default", false)
                    : status,
              ),
            },
          });
          return Promise.resolve(true);
        }}
        onCreate={(draft) => {
          const { body } = now();
          const name = canonicalizeLabelName(draft.name);
          if (refused("status", body.statuses, name)) {
            return Promise.resolve(false);
          }
          const created: TemplateStatus = {
            name,
            category: draft.category,
            color: draft.color,
            chart_role: isRole(draft.role)
              ? draft.role
              : defaultInsightsRole({ name, category: draft.category }),
          };
          queue({ body: { ...body, statuses: [...body.statuses, created] } });
          return Promise.resolve(true);
        }}
        onDelete={(id) => {
          const { body } = now();
          const gone = body.statuses.filter(
            (status) => statusIds.of(status.name) === id,
          );
          // Moved down the way a project's moves when its status goes.
          const line = lineAfterDeleting(
            body.statuses,
            body.statuses.find((status) => status.block_clear) ?? null,
            new Set(gone),
          );
          queue({
            body: {
              ...body,
              statuses: body.statuses
                .filter((status) => !gone.includes(status))
                .map((status) =>
                  marked(status, "block_clear", status === line),
                ),
            },
          });
          return Promise.resolve(true);
        }}
        pending={{ save: false, create: false, delete: false }}
      />
      <LabelSetList
        labels={labels}
        canManage={canManage}
        template
        onCreate={(input) => {
          const { body } = now();
          const name = canonicalizeLabelName(input.name);
          if (refused("label", body.labels, name)) {
            return Promise.resolve(false);
          }
          queue({
            body: {
              ...body,
              labels: sortedByName([...body.labels, { ...input, name }]),
            },
          });
          return Promise.resolve(true);
        }}
        onUpdate={(id, input) => {
          const { body } = now();
          const before = body.labels.find(
            (label) => labelIds.of(label.name) === id,
          );
          if (before === undefined) return Promise.resolve(false);
          const name =
            input.name === undefined
              ? before.name
              : canonicalizeLabelName(input.name);
          if (name !== before.name && refused("label", body.labels, name)) {
            return Promise.resolve(false);
          }
          labelIds.rename(before.name, name);
          queue({
            body: {
              ...body,
              labels: sortedByName(
                body.labels.map((label) =>
                  label === before ? { ...label, ...input, name } : label,
                ),
              ),
            },
          });
          return Promise.resolve(true);
        }}
        onDelete={(id) => {
          const { body } = now();
          queue({
            body: {
              ...body,
              labels: body.labels.filter(
                (label) => labelIds.of(label.name) !== id,
              ),
            },
          });
          return Promise.resolve(true);
        }}
        pending={{ create: false, update: false, delete: false }}
      />
    </div>
  );
}

function TemplateNameForm({
  name,
  onSave,
}: {
  name: string;
  onSave: (name: string) => void;
}) {
  // null = untouched; the field shows the saved name until edited.
  const [draft, setDraft] = useState<string | null>(null);
  const next = (draft ?? name).trim();
  const dirty = draft !== null && next !== "" && next !== name;
  return (
    <form
      className="flex max-w-xl items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!dirty) return;
        onSave(next);
        setDraft(null);
      }}
    >
      <div className="min-w-0 flex-1 space-y-2">
        <Label htmlFor="template-name">Name</Label>
        <Input
          id="template-name"
          value={draft ?? name}
          maxLength={100}
          onChange={(e) => setDraft(e.target.value)}
          autoComplete="off"
        />
      </div>
      <Button type="submit" disabled={!dirty}>
        Save
      </Button>
    </form>
  );
}
