import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  type Agent,
  formatRef,
  MemberRole,
  type ProjectCreateInput,
  type TemplateRef,
} from "@todou/shared";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { inboxQuery, unreadCounts } from "@/api/inbox.ts";
import { prefsQuery } from "@/api/prefs.ts";
import {
  agentsQuery,
  api,
  projectsQuery,
  projectTemplatesQuery,
  watchersQuery,
} from "@/api/queries.ts";
import { useProjectOrder } from "@/api/useProjectOrder.ts";
import { LoadFailure } from "@/components/shared/load-failure.tsx";
import {
  ProjectCard,
  ProjectCardGrid,
} from "@/components/shared/project-card.tsx";
import { ProjectWatchersButton } from "@/components/shared/project-watchers.tsx";
import { displayNameOf } from "@/components/shared/user-chip.tsx";
import { UserOption } from "@/components/shared/user-picker.tsx";
import {
  preferredTemplate,
  type StartFrom,
  StartFromPicker,
} from "@/components/start-from-picker.tsx";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { UnreadBadge } from "@/components/unread-badge.tsx";
import { useProjectRefs } from "@/lib/use-project-refs.ts";

export function ProjectsPage() {
  const projects = useSuspenseQuery(projectsQuery);
  const inbox = useQuery(inboxQuery);
  const watchers = useQuery(watchersQuery);
  const counts = unreadCounts(inbox.data);
  // Same frecency order as the navbar switcher (T-76).
  const ordered = useProjectOrder(projects.data);
  const refs = useProjectRefs(projects.data);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Projects</h1>
        <CreateProjectDialog />
      </div>
      {projects.data.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-muted-foreground">
          No projects yet — plant your first potato 🥔
        </div>
      ) : (
        <ProjectCardGrid>
          {ordered.map(({ project, neverVisited }) => {
            const count = counts[project.slug] ?? 0;
            const watching = watchers.data?.projects[project.slug];
            return (
              <ProjectCard
                key={project.id}
                project={{
                  slug: project.slug,
                  name: project.name,
                  prefix: refs.get(project.slug)?.prefix ?? null,
                  icon_url: project.icon_url,
                }}
                muted={neverVisited}
                corner={
                  watching?.length ? (
                    <ProjectWatchersButton
                      projectName={project.name}
                      watchers={watching}
                      live
                    />
                  ) : undefined
                }
                action={
                  count > 0 ? (
                    <>
                      <UnreadBadge count={count} />
                      <span className="sr-only">{count} unread</span>
                    </>
                  ) : undefined
                }
              >
                {project.slug}
                {project.description ? ` — ${project.description}` : ""}
              </ProjectCard>
            );
          })}
        </ProjectCardGrid>
      )}
    </div>
  );
}

/** Whether an agent joins the new project, and as what. */
type AgentPick = { join: boolean; role: MemberRole };

/** What an agent's own "Join projects I create" puts in the dialog. */
function pickFromSetting(agent: Agent): AgentPick {
  const role = agent.new_project_role ?? null;
  return role === null ? { join: false, role: "writer" } : { join: true, role };
}

function CreateProjectDialog() {
  // The switcher footer lands here as /projects?new=1 → open on arrival,
  // and drop the param on close so reload/back don't reopen it.
  const openedViaSearch = useSearch({ from: "/authed/projects" }).new === true;
  const [open, setOpen] = useState(openedViaSearch);
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [refPrefix, setRefPrefix] = useState("");
  // Null until changed here: until then the dialog starts from the template
  // the prefs name, which may arrive after it opens.
  const [from, setFrom] = useState<StartFrom | null>(null);
  // Only the agents changed here; the rest stand as their own setting says.
  const [picks, setPicks] = useState<ReadonlyMap<number, AgentPick>>(
    () => new Map(),
  );
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Read once the dialog opens, not on every visit to the page under it.
  const templates = useQuery({ ...projectTemplatesQuery, enabled: open });
  const agents = useQuery({ ...agentsQuery, enabled: open });
  const prefs = useQuery(prefsQuery);
  const projects = useQuery(projectsQuery);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next && openedViaSearch) {
      navigate({ to: "/projects", search: {}, replace: true });
    }
  };

  const create = useMutation({
    mutationFn: (input: ProjectCreateInput) => api.createProject(input),
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      setOpen(false);
      navigate({ to: "/projects/$slug", params: { slug: project.slug } });
    },
    onError: (error) => toast.error(error.message),
  });

  const start: StartFrom = from ?? {
    kind: "template",
    template: prefs.data?.new_project_template ?? "default",
    project: null,
  };
  // A template deleted since it was named, in the prefs or here, gives way
  // to Default.
  const startFrom: StartFrom = {
    ...start,
    template: preferredTemplate(templates.data ?? [], start.template),
  };
  const source: { template: TemplateRef } | { from_project: string } | null =
    startFrom.kind === "template"
      ? { template: startFrom.template }
      : startFrom.project === null
        ? null
        : { from_project: startFrom.project };
  const activeAgents = (agents.data ?? []).filter(
    (agent) => agent.disabled_at === null,
  );
  const pickOf = (agent: Agent) =>
    picks.get(agent.id) ?? pickFromSetting(agent);
  const repick = (agent: Agent, change: Partial<AgentPick>) =>
    setPicks((all) =>
      new Map(all).set(agent.id, {
        ...(all.get(agent.id) ?? pickFromSetting(agent)),
        ...change,
      }),
    );
  // Before both lists are in, the request could carry neither the template
  // the dialog would show nor the agents that join by default. Before the
  // prefs are read, or fail to be, it would carry Default in place of the
  // template they name, unless another start was picked here.
  const ready =
    templates.data !== undefined &&
    agents.data !== undefined &&
    (from !== null || !prefs.isPending);

  const submit = () => {
    if (!ready || source === null) return;
    create.mutate({
      slug,
      name,
      description,
      ref_prefix: refPrefix.trim() || undefined,
      ...source,
      // Sent even when empty: left out, the server would add every agent
      // whose own setting says to join, unticked here or not.
      agents: activeAgents.flatMap((agent) => {
        const pick = pickOf(agent);
        return pick.join ? [{ login: agent.login, role: pick.role }] : [];
      }),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">
          <PlusIcon /> New project
        </Button>
      </DialogTrigger>
      <DialogContent className="grid-cols-1 max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
        </DialogHeader>
        <form
          className="min-w-0 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (
                  slug === "" ||
                  slug ===
                    name
                      .toLowerCase()
                      .replaceAll(/[^a-z0-9]+/g, "-")
                      .replaceAll(/^-|-$/g, "")
                ) {
                  setSlug(
                    e.target.value
                      .toLowerCase()
                      .replaceAll(/[^a-z0-9]+/g, "-")
                      .replaceAll(/^-|-$/g, ""),
                  );
                }
              }}
              placeholder="My potato field"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="project-slug">Slug</Label>
            <Input
              id="project-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              pattern="[a-z0-9][a-z0-9-]*"
              placeholder="my-potato-field"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="project-description">Description</Label>
            <Textarea
              id="project-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="project-ref-prefix">Issue reference format</Label>
            <div className="flex items-center gap-2">
              <Input
                id="project-ref-prefix"
                value={refPrefix}
                onChange={(e) =>
                  setRefPrefix(e.target.value.toUpperCase().trim())
                }
                pattern="[A-Z][A-Z0-9_]{0,19}"
                placeholder="#"
                aria-label="reference format prefix"
                className="w-32"
              />
              <span
                className="text-sm text-muted-foreground"
                data-testid="ref-format-preview"
              >
                {formatRef(refPrefix.trim() || null, 1)}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Changeable later in Settings.
            </p>
          </div>
          <div className="space-y-2">
            <div className="text-sm leading-none font-medium">Start from</div>
            {templates.data !== undefined ? (
              <StartFromPicker
                templates={templates.data}
                projects={projects.data ?? []}
                value={startFrom}
                onChange={setFrom}
                idPrefix="new-project-from"
              />
            ) : templates.isError ? (
              <LoadFailure
                message={`Could not load your templates: ${templates.error.message}`}
                detail={templates.error.message}
                onRetry={() => templates.refetch()}
                retrying={templates.isFetching}
              />
            ) : (
              <Skeleton className="h-24 w-full" />
            )}
          </div>
          {agents.data === undefined ? (
            agents.isError && (
              <LoadFailure
                message={`Could not load your agents: ${agents.error.message}`}
                detail={agents.error.message}
                onRetry={() => agents.refetch()}
                retrying={agents.isFetching}
              />
            )
          ) : activeAgents.length > 0 ? (
            // min-w-0: a fieldset is otherwise as wide as its longest name.
            <fieldset className="min-w-0">
              <legend className="mb-2 text-sm font-medium">Agents</legend>
              <div className="divide-y rounded-lg border">
                {activeAgents.map((agent) => {
                  const pick = pickOf(agent);
                  return (
                    <div
                      key={agent.id}
                      className="flex items-center gap-2 pr-2"
                    >
                      <label
                        htmlFor={`project-agent-${agent.id}`}
                        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 py-2.5 pl-3"
                      >
                        <Checkbox
                          id={`project-agent-${agent.id}`}
                          aria-label={`${displayNameOf(agent)} @${agent.login}`}
                          checked={pick.join}
                          onChange={(e) =>
                            repick(agent, { join: e.target.checked })
                          }
                        />
                        <span className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                          <UserOption user={agent} badge={false} />
                        </span>
                      </label>
                      <Select
                        value={pick.role}
                        disabled={!pick.join}
                        onValueChange={(role) =>
                          repick(agent, { role: role as MemberRole })
                        }
                      >
                        <SelectTrigger
                          size="sm"
                          className="w-28 shrink-0"
                          aria-label={`Role for ${agent.login}`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {MemberRole.options.map((role) => (
                            <SelectItem key={role} value={role}>
                              {role}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  );
                })}
              </div>
            </fieldset>
          ) : null}
          <DialogFooter>
            <Button
              type="submit"
              disabled={!ready || source === null || create.isPending}
            >
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
