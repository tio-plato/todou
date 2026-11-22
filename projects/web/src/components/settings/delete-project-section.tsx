import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Trash2Icon } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { issueCountsQuery } from "@/api/issues.ts";
import {
  api,
  membersQuery,
  projectQuery,
  projectsQuery,
  useCan,
} from "@/api/queries.ts";
import { ProjectIcon } from "@/components/shared/project-icon.tsx";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useProjectRefs } from "@/lib/use-project-refs.ts";

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** What the delete names, read when it is sent rather than when it lands. */
type Doomed = { id: number; name: string; slugs: string[] };

/**
 * The General page's last section: deleting the project.
 *
 * The server deletes at once and keeps nothing to restore from, so the dialog
 * takes two steps, as GitHub's does: the first shows which project this is,
 * the second says what goes with it and wants the slug typed back.
 */
export function DeleteProjectSection({ slug }: { slug: string }) {
  const project = useSuspenseQuery(projectQuery(slug));
  const mayDelete = useCan(slug, "project.delete");
  // The project the dialog was opened on, by id; null while it is closed.
  const [openFor, setOpenFor] = useState<number | null>(null);
  const [step, setStep] = useState<"summary" | "confirm">("summary");
  const [typed, setTyped] = useState("");
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const consequencesId = useId();
  const inputId = useId();

  const remove = useMutation({
    // By id: while the dialog stood open the slug may have been renamed away
    // and claimed by another project, which a slug in the path would delete.
    mutationFn: (doomed: Doomed) => api.deleteProject(String(doomed.id)),
    onSuccess: (_data, doomed) => {
      setOpenFor(null);
      toast.success(`Deleted ${doomed.name}`);
      // Out of the list the redirect lands on before it gets there, or that
      // list draws the project from cache until its refetch answers. A fetch
      // already out began before the delete and would bring it back.
      void queryClient.cancelQueries({ queryKey: projectsQuery.queryKey });
      queryClient.setQueryData(projectsQuery.queryKey, (list) =>
        list?.filter((p) => p.id !== doomed.id),
      );
      // Every cache key in the app is keyed by slug. Left in place, the old
      // project answers Back to its pages, and greets the next project to
      // take one of its slugs; the rest of the cache still lists it. Only
      // once the page has gone, so nothing mounted fetches it back; should
      // the redirect fail, the page fetching it finds it gone and says so.
      const forget = () => {
        queryClient.removeQueries({
          predicate: (query) => {
            const key = query.queryKey[1];
            return typeof key === "string" && doomed.slugs.includes(key);
          },
        });
        queryClient.invalidateQueries();
      };
      // Wherever the reader is by now: the page they opened this on is gone.
      // Not awaited: a navigation the unsaved-changes guard holds back would
      // keep the mutation pending, and so the dialog unclosable, until some
      // later navigation commits.
      void navigate({ to: "/projects", replace: true }).then(forget, forget);
    },
    onError: (error) => toast.error(error.message),
  });

  // Gone once the delete has gone through, for a reader the unsaved-changes
  // guard kept on the page: there is no project left here to delete.
  const deleted = remove.isSuccess && remove.variables.id === project.data.id;
  if (!mayDelete || deleted) return null;

  // This address can come to name another project, one that took the slug
  // over while the dialog stood open; the cache under the slug, and the id
  // read from it, then answer for that project instead. The dialog closes for
  // good, unless its request is already out, which closing would not stop.
  if (openFor !== null && openFor !== project.data.id && !remove.isPending) {
    setOpenFor(null);
  }
  const open = openFor !== null;
  const matches = typed.trim() === project.data.slug;
  const submit = () => {
    // The confirm button is held while this is false, but Enter in the box
    // submits the form without asking the button.
    if (!matches || remove.isPending) return;
    remove.mutate({
      id: project.data.id,
      name: project.data.name,
      slugs: [slug, project.data.slug, ...(project.data.former_slugs ?? [])],
    });
  };

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Delete project</h2>
      <Button
        variant="destructive"
        size="sm"
        onClick={() => {
          // Reset on the way in rather than out: cleared on close, the
          // closing dialog would flip back to the summary as it fades.
          setStep("summary");
          setTyped("");
          setOpenFor(project.data.id);
        }}
      >
        <Trash2Icon />
        Delete this project
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          // Closing would not take back a request already sent, so Esc, the
          // X and the overlay do nothing until it is answered.
          if (next || remove.isPending) return;
          setOpenFor(null);
        }}
        title="Delete project"
        destructive
        pending={remove.isPending}
        confirmLabel={
          step === "summary"
            ? "I want to delete this project"
            : remove.isPending
              ? "Deleting…"
              : "Delete this project"
        }
        confirmDisabled={step === "confirm" && !matches}
        onConfirm={step === "summary" ? () => setStep("confirm") : submit}
      >
        <ProjectSummary slug={slug} />
        {step === "confirm" && (
          <>
            <p id={consequencesId} className="text-sm text-muted-foreground">
              Everything in it goes too: its issues and the ones in its trash,
              with their comments, specs and attachments, and its labels,
              statuses and members.{" "}
              <span className="font-medium text-foreground">
                None of it can be restored.
              </span>
            </p>
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <label htmlFor={inputId} className="block text-sm">
                Type{" "}
                <code className="font-mono break-all">{project.data.slug}</code>{" "}
                to confirm.
              </label>
              <Input
                id={inputId}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                aria-describedby={consequencesId}
                // A phone keyboard that capitalises or corrects the first
                // word would never let the slug match.
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                // Pressing the button this step replaced was asking for it.
                autoFocus
                className="font-mono"
              />
            </form>
          </>
        )}
      </ConfirmDialog>
    </section>
  );
}

/**
 * Which project, and how much of it: the line a project card on the project
 * list would show, with the counts the reader is about to lose.
 *
 * Mounted only inside the open dialog, so its reads go out when it opens.
 */
function ProjectSummary({ slug }: { slug: string }) {
  const project = useSuspenseQuery(projectQuery(slug)).data;
  const refs = useProjectRefs([project]);
  // The list's Open and Closed tabs added up; the trash is not counted, which
  // is why the consequences below name it.
  const counts = useQuery(issueCountsQuery(slug, {}));
  const members = useQuery(membersQuery(slug));

  const facts = [project.slug];
  if (counts.data) {
    facts.push(plural(counts.data.open + counts.data.closed, "issue"));
  }
  if (members.data) facts.push(plural(members.data.length, "member"));

  return (
    <div className="flex items-center gap-3">
      <ProjectIcon
        aria-hidden="true"
        project={{
          slug: project.slug,
          name: project.name,
          prefix: refs.get(project.slug)?.prefix ?? null,
          icon_url: project.icon_url,
        }}
        className="size-10"
      />
      <div className="min-w-0">
        <p className="truncate font-medium">{project.name}</p>
        {/* A slug runs to 64 characters with no dash to break at. */}
        <DialogDescription className="text-xs tabular-nums wrap-anywhere">
          {facts.join(" · ")}
        </DialogDescription>
      </div>
    </div>
  );
}
