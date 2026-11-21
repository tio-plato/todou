import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import {
  Link,
  useNavigate,
  useParams,
  useRouter,
} from "@tanstack/react-router";
import {
  canonicalizeLabelName,
  defaultInsightsRole,
  LabelName,
  lineAfterDeleting,
  nameKey,
  type ProjectTemplate,
  type ProjectTemplateCreateInput,
  type TemplateBody,
  type TemplateLabel,
  type TemplateStatus,
  TodouError,
} from "@todou/shared";
import {
  ArrowLeftIcon,
  CheckIcon,
  CircleCheckIcon,
  CircleIcon,
  CopyIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import {
  type ReactElement,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
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
  const newTemplate = useRef<HTMLButtonElement>(null);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Project templates</h1>
        <NewTemplateDialog
          templates={templates.data}
          triggerRef={newTemplate}
        />
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
                <DeleteTemplateButton
                  template={template}
                  lastFocus={newTemplate}
                />
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

/**
 * Where focus goes once the row of `button` is deleted: the next row's
 * delete button, else the one before, else `last`. Null outside a list.
 */
function focusAfterDeleting(
  button: HTMLElement | null,
  last: HTMLElement | null,
): HTMLElement | null {
  const list = button?.closest("ul");
  if (!button || !list) return null;
  const buttons = [
    ...list.querySelectorAll<HTMLElement>("[data-delete-template]"),
  ];
  const at = buttons.indexOf(button);
  return buttons[at + 1] ?? buttons[at - 1] ?? last;
}

function DeleteTemplateButton({
  template,
  lastFocus,
}: {
  template: ProjectTemplate;
  /** Where focus goes once no row is left with a delete button. */
  lastFocus?: RefObject<HTMLElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  // Set once the template is gone. The confirmation, with no trigger to
  // hand focus back to, would leave it on the page's body.
  const landing = useRef<HTMLElement | null>(null);
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: (id: number) => api.deleteProjectTemplate(id),
    onSuccess: (_data, id) => {
      // Before the row goes, while there is a row to count from.
      landing.current = focusAfterDeleting(
        button.current,
        lastFocus?.current ?? null,
      );
      // "New projects start from" falls back to Basic by itself when this
      // was it.
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
        ref={button}
        data-delete-template
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
        onCloseAutoFocus={(event) => {
          if (landing.current === null) return;
          event.preventDefault();
          landing.current.focus();
          landing.current = null;
        }}
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
  template: "basic",
  project: null,
};

function NewTemplateDialog({
  templates,
  triggerRef,
}: {
  templates: readonly ProjectTemplate[];
  triggerRef?: RefObject<HTMLButtonElement | null>;
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
        <Button ref={triggerRef} size="sm">
          <PlusIcon /> New template
        </Button>
      </DialogTrigger>
      <DialogContent
        aria-describedby={undefined}
        className="grid-cols-1 sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>New template</DialogTitle>
        </DialogHeader>
        <form
          className="min-w-0 space-y-4"
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

const COPY = " copy";

/**
 * The name a copy of a template is offered: its own with " copy" after it,
 * the name cut short where the two would run past the 100 characters a name
 * may hold. Never cut between a surrogate pair's halves.
 */
function copyName(name: string): string {
  let kept = name.slice(0, 100 - COPY.length);
  if (/[\uD800-\uDBFF]$/.test(kept)) kept = kept.slice(0, -1);
  return `${kept.trimEnd()}${COPY}`;
}

/** Names a copy of `template` as it is now, makes it, then opens it. */
function DuplicateTemplateDialog({ template }: { template: UsableTemplate }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const create = useCreateTemplate(() => setOpen(false));
  const trimmed = name.trim();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setName(copyName(template.name));
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <CopyIcon /> Duplicate
        </Button>
      </DialogTrigger>
      <DialogContent
        aria-describedby={undefined}
        className="grid-cols-1 sm:max-w-lg"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          field.current?.focus();
          field.current?.select();
        }}
      >
        <DialogHeader className="min-w-0 pr-7">
          <DialogTitle className="min-w-0 leading-normal wrap-anywhere">
            Duplicate {template.name}
          </DialogTitle>
        </DialogHeader>
        <form
          className="min-w-0 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (trimmed !== "" && !create.isPending) {
              create.mutate({ name: trimmed, body: template.body });
            }
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="duplicate-template-name">Name</Label>
            <Input
              ref={field}
              id="duplicate-template-name"
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
              autoComplete="off"
              required
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={trimmed === "" || create.isPending}>
              Duplicate
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
 * One template's page: `basic` or an id. Read out of the list, which holds
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
 * place. It can be deleted, here or from the list; nothing can be made from
 * it.
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
      <DeleteTemplateRow template={template} />
    </div>
  );
}

/** Where a template's writes queue, so that each waits for the one before. */
const writes = (ref: ProjectTemplate["ref"]) => `project-template-${ref}`;

/**
 * The account's own template deleted from its page, which is left before the
 * template leaves the list: the other way round, the page would show it as
 * missing first.
 */
function DeleteTemplateRow({ template }: { template: ProjectTemplate }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const key = ["project-template-delete", template.ref];
  const remove = useMutation({
    mutationKey: key,
    // Behind the edits still being saved, which would meet a 404 after it.
    scope: { id: writes(template.ref) },
    mutationFn: (id: number) => api.deleteProjectTemplate(id),
    onSuccess: async (_data, id) => {
      // Only from the template's own page, as the address now reads, a
      // navigation still loading included: one left while the delete waited
      // is not brought back to the list.
      const here = router
        .matchRoutes(router.latestLocation)
        .some(
          (match) =>
            match.routeId === "/authed/settings/templates/$template" &&
            match.params.template === String(id),
        );
      if (here) await navigate({ to: "/settings/templates" });
      queryClient.setQueryData(templatesKey, (list) =>
        list?.filter((t) => t.ref !== id),
      );
    },
    onError: (error) => toast.error(error.message),
  });
  // Also when this page was left and opened again while the delete waited:
  // it is still on its way.
  const deleting = useIsMutating({ mutationKey: key }) > 0 || remove.isPending;
  const { ref } = template;
  if (typeof ref !== "number") return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-destructive/35 py-3 pr-3 pl-4">
      <p className="text-sm text-muted-foreground">
        Projects made from it keep their statuses and labels.
      </p>
      <Button
        variant="outline"
        size="sm"
        className="text-destructive"
        onClick={() => setOpen(true)}
      >
        <Trash2Icon className="size-3.5" /> Delete template
      </Button>
      <ConfirmDialog
        open={open || deleting}
        // Kept open while the delete waits its turn: closed, it would read
        // as called off, and an edit made then would queue behind it.
        onOpenChange={(next) => {
          if (!deleting) setOpen(next);
        }}
        title="Delete this template?"
        description={
          <>
            <span className="font-medium text-foreground">{template.name}</span>
            {" — there is no undo."}
          </>
        }
        confirmLabel="Delete template"
        destructive
        pending={deleting}
        onConfirm={() => {
          if (!deleting) remove.mutate(ref);
        }}
      />
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
  const key = nameKey(name);
  if (!others.some((other) => nameKey(other.name) === key)) return false;
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
  const scope = writes(ref);
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
        {canManage ? (
          <TemplateNameForm
            name={template.name}
            onSave={(name) => queue({ name })}
          />
        ) : (
          <div className="space-y-1">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="truncate text-xl font-semibold">
                {template.name}
              </h1>
              <Badge variant="outline">Built in</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              Comes with todou: an update can change it, but not your copies.
            </p>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <UseForNewProjectsButton template={template} />
          <DuplicateTemplateDialog template={template} />
        </div>
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
            (name !== before.name &&
              refused(
                "status",
                body.statuses.filter((status) => status !== before),
                name,
              ))
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
          if (
            name !== before.name &&
            refused(
              "label",
              body.labels.filter((label) => label !== before),
              name,
            )
          ) {
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
      {canManage && <DeleteTemplateRow template={template} />}
    </div>
  );
}

// The outline button's own hover and dark colours are overridden too: left
// in, the dark ones hide the fill and a hover turns the text back.
const IN_USE =
  "border-primary/45 bg-primary/15 text-primary hover:bg-primary/15 hover:text-primary dark:border-primary/45 dark:bg-primary/15 dark:hover:bg-primary/15";

/**
 * Whether new projects start from `template`, and the press that makes them.
 * It looks the same width either way. Once pressed it does nothing: a new
 * project always starts from some template, so there is nothing to unset.
 */
function UseForNewProjectsButton({ template }: { template: UsableTemplate }) {
  const templates = useSuspenseQuery(projectTemplatesQuery);
  const prefs = useSuspenseQuery(prefsQuery);
  const patch = usePatchPrefs();
  const inUse =
    preferredTemplate(templates.data, prefs.data.new_project_template) ===
    template.ref;
  return (
    <Button
      variant="outline"
      size="sm"
      aria-pressed={inUse}
      aria-disabled={inUse || undefined}
      className={inUse ? IN_USE : undefined}
      onClick={() => {
        if (!inUse) patch.mutate({ new_project_template: template.ref });
      }}
    >
      {inUse ? <CircleCheckIcon /> : <CircleIcon />} Use for new projects
    </Button>
  );
}

/** A template's name as its page's heading, renamed in place. */
function TemplateNameForm({
  name,
  onSave,
}: {
  name: string;
  onSave: (name: string) => void;
}) {
  // null = showing the name; a string = the field, holding the draft.
  const [draft, setDraft] = useState<string | null>(null);
  // The name just saved, shown until the list it is queued into has it: the
  // list changes a tick later, and the heading would show the old one first.
  const [saved, setSaved] = useState<string | null>(null);
  const [listed, setListed] = useState(name);
  if (listed !== name) {
    setListed(name);
    setSaved(null);
  }
  const shown = saved ?? name;
  const field = useRef<HTMLInputElement>(null);
  const pencil = useRef<HTMLButtonElement>(null);
  // Set as the field closes, so focus goes back to the pencil it came from.
  const returning = useRef(false);
  const editing = draft !== null;

  useEffect(() => {
    if (editing) {
      field.current?.focus();
      field.current?.select();
    } else if (returning.current) {
      returning.current = false;
      pencil.current?.focus();
    }
  }, [editing]);

  const close = () => {
    returning.current = true;
    setDraft(null);
  };

  if (!editing) {
    return (
      <div className="flex min-w-0 items-center gap-1">
        <h1 className="truncate text-xl font-semibold">{shown}</h1>
        <Button
          ref={pencil}
          variant="ghost"
          size="icon-sm"
          aria-label="Rename"
          onClick={() => setDraft(shown)}
        >
          <PencilIcon className="size-4" />
        </Button>
      </div>
    );
  }
  return (
    <form
      className="flex min-w-0 items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const next = draft.trim();
        if (next !== "" && next !== shown) {
          setSaved(next);
          onSave(next);
        }
        close();
      }}
    >
      <Input
        ref={field}
        value={draft}
        maxLength={100}
        aria-label="Template name"
        autoComplete="off"
        className="h-auto py-0 text-xl font-semibold md:text-xl"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !e.nativeEvent.isComposing) close();
        }}
      />
      <Button type="submit" size="icon-sm" aria-label="Save name">
        <CheckIcon className="size-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Cancel"
        onClick={close}
      >
        <XIcon className="size-4" />
      </Button>
    </form>
  );
}
