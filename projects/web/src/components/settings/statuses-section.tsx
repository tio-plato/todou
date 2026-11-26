import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  defaultInsightsRole,
  type Role,
  type Status,
  type StatusOrderInput,
  type StatusUpdateInput,
  type StatusUsage,
  TodouError,
} from "@todou/shared";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { insightsSettingsQuery, invalidateInsights } from "@/api/insights.ts";
import {
  api,
  projectQuery,
  statusesQuery,
  statusUsageQuery,
  useCan,
} from "@/api/queries.ts";
import {
  countLinkClass,
  type Draft,
  isRole,
  plural,
  StatusSetList,
} from "@/components/settings/status-set-list.tsx";

/**
 * The project's Statuses page (T-712): its status set, the block clear line
 * and the chart roles, wired into the list that draws and edits them.
 */
export function StatusesSection({ slug }: { slug: string }) {
  const statuses = useSuspenseQuery(statusesQuery(slug));
  const project = useSuspenseQuery(projectQuery(slug));
  const settings = useSuspenseQuery(insightsSettingsQuery(slug));
  // A heavier read than the list; the list does not wait for it.
  const usage = useQuery({
    ...statusUsageQuery(slug),
    enabled: useCan(slug, "status.usage"),
  });
  const canManage = useCan(slug, "status.manage");
  const queryClient = useQueryClient();

  const lineStatusId = project.data.block_clear_status_id ?? null;
  const roleById = new Map(
    settings.data.roles.map((entry) => [entry.status_id, entry.role]),
  );
  const entries = statuses.data.map((status) => ({
    ...status,
    role: roleById.get(status.id) ?? defaultInsightsRole(status),
  }));
  const byId = new Map(entries.map((s) => [s.id, s]));
  const usageById = new Map(usage.data?.map((u) => [u.id, u]));

  const invalidateBlocks = () => {
    // Every card's blocked badge can move with the order or the line.
    queryClient.invalidateQueries({ queryKey: ["issues"] });
    queryClient.invalidateQueries({ queryKey: ["issue"] });
  };

  const reorder = useMutation({
    mutationFn: (vars: { slug: string; input: StatusOrderInput }) =>
      api.reorderStatuses(vars.slug, vars.input),
    onMutate: async (vars) => {
      const statusesKey = statusesQuery(vars.slug).queryKey;
      const projectKey = projectQuery(vars.slug).queryKey;
      await Promise.all([
        queryClient.cancelQueries({ queryKey: statusesKey, exact: true }),
        queryClient.cancelQueries({ queryKey: projectKey, exact: true }),
      ]);
      const previous = {
        statuses: queryClient.getQueryData(statusesKey),
        project: queryClient.getQueryData(projectKey),
      };
      queryClient.setQueryData(statusesKey, (rows) => {
        if (!rows) return rows;
        const map = new Map(rows.map((row) => [row.id, row]));
        return vars.input.ids.flatMap((id, position) => {
          const row = map.get(id);
          return row ? [{ ...row, position }] : [];
        });
      });
      if (vars.input.block_clear_status_id !== undefined) {
        const line = vars.input.block_clear_status_id;
        queryClient.setQueryData(projectKey, (p) =>
          p ? { ...p, block_clear_status_id: line } : p,
        );
      }
      return previous;
    },
    onError: (error, vars, previous) => {
      if (previous) {
        queryClient.setQueryData(
          statusesQuery(vars.slug).queryKey,
          previous.statuses,
        );
        queryClient.setQueryData(
          projectQuery(vars.slug).queryKey,
          previous.project,
        );
      }
      toast.error(error.message);
    },
    onSettled: (_data, _error, vars) => {
      queryClient.invalidateQueries({
        queryKey: statusesQuery(vars.slug).queryKey,
      });
      queryClient.invalidateQueries({
        queryKey: projectQuery(vars.slug).queryKey,
      });
      invalidateBlocks();
    },
  });

  const afterWrite = (slug: string) => {
    queryClient.invalidateQueries({ queryKey: statusesQuery(slug).queryKey });
    void invalidateInsights(queryClient, slug);
    // Issue rows and board cards embed status names and colours.
    queryClient.invalidateQueries({ queryKey: ["issues", slug] });
  };

  const save = useMutation({
    mutationFn: async (vars: {
      slug: string;
      id: number;
      patch: StatusUpdateInput | null;
      role: Role | null;
    }) => {
      const results = await Promise.allSettled([
        vars.patch && api.updateStatus(vars.slug, vars.id, vars.patch),
        vars.role && api.setInsightsRole(vars.slug, vars.id, vars.role),
      ]);
      return results.flatMap((r) =>
        r.status === "rejected" ? [errorMessage(r.reason)] : [],
      );
    },
    onSuccess: (failures, vars) => {
      for (const message of failures) toast.error(message);
      afterWrite(vars.slug);
      if (vars.patch?.category !== undefined) invalidateBlocks();
    },
    onError: (error) => toast.error(error.message),
  });

  const create = useMutation({
    mutationFn: async (vars: {
      slug: string;
      draft: Draft;
      role: Role | null;
    }) => {
      const created = await api.createStatus(vars.slug, {
        name: vars.draft.name,
        category: vars.draft.category,
        color: vars.draft.color,
      });
      if (vars.role) {
        try {
          await api.setInsightsRole(vars.slug, created.id, vars.role);
        } catch (error) {
          toast.error(errorMessage(error));
        }
      }
      return created;
    },
    onSuccess: (_data, vars) => afterWrite(vars.slug),
    onError: (error) => toast.error(error.message),
  });

  const remove = useMutation({
    // `heldLine` as the delete was asked for: by its answer the project may
    // already have been read again, the line moved on.
    mutationFn: (vars: { slug: string; id: number; heldLine: boolean }) =>
      api.deleteStatus(vars.slug, vars.id),
    onSuccess: (_data, vars) => {
      afterWrite(vars.slug);
      // Deleting the line's status moves the line.
      queryClient.invalidateQueries({
        queryKey: projectQuery(vars.slug).queryKey,
      });
      if (vars.heldLine) invalidateBlocks();
    },
    onError: (error, vars) => {
      toast.error(error.message);
      queryClient.invalidateQueries({
        queryKey: statusUsageQuery(vars.slug).queryKey,
      });
    },
  });

  return (
    <StatusSetList
      statuses={entries}
      lineStatusId={lineStatusId}
      usage={usage.data}
      canManage={canManage}
      deleteBlock={(status) =>
        deleteBlock(slug, status, usageById.get(status.id))
      }
      issuesLink={(status) => issuesLink(slug, status.id)}
      onArrange={(input) => reorder.mutate({ slug, input })}
      onSave={(id, draft) => {
        const status = byId.get(id);
        if (!status) return Promise.resolve(false);
        const patch: StatusUpdateInput = {
          ...(draft.name !== status.name && { name: draft.name }),
          ...(draft.category !== status.category && {
            category: draft.category,
          }),
          ...(draft.color !== status.color && { color: draft.color }),
          ...(draft.isDefault !== status.is_default && {
            is_default: draft.isDefault,
          }),
        };
        return save
          .mutateAsync({
            slug,
            id,
            patch: Object.keys(patch).length > 0 ? patch : null,
            role:
              draft.role !== status.role && isRole(draft.role)
                ? draft.role
                : null,
          })
          .then(
            (failures) => failures.length === 0,
            () => false,
          );
      }}
      onCreate={(draft) => {
        const role = isRole(draft.role) ? draft.role : null;
        return succeeded(
          create.mutateAsync({
            slug,
            draft,
            role:
              role !== null &&
              role !==
                defaultInsightsRole({
                  name: draft.name,
                  category: draft.category,
                })
                ? role
                : null,
          }),
        );
      }}
      onDelete={(id) =>
        succeeded(
          remove.mutateAsync({ slug, id, heldLine: id === lineStatusId }),
        )
      }
      pending={{
        save: save.isPending,
        create: create.isPending,
        delete: remove.isPending,
      }}
    />
  );
}

/** A write's outcome for the list: its errors are already toasted. */
const succeeded = (write: Promise<unknown>) =>
  write.then(
    () => true,
    () => false,
  );

function errorMessage(error: unknown): string {
  return error instanceof TodouError || error instanceof Error
    ? error.message
    : String(error);
}

const issuesLink = (slug: string, statusId: number) =>
  ({
    to: "/projects/$slug",
    params: { slug },
    // A closed status would otherwise land on the list's default, open.
    search: { status: String(statusId), category: "all" },
  }) as const;

/** Why the server would refuse a delete, first reason first; null if it would not. */
function deleteBlock(
  slug: string,
  status: Pick<Status, "id">,
  uses: StatusUsage | undefined,
): ReactNode {
  if (uses && uses.issues > 0) {
    return (
      <>
        <Link {...issuesLink(slug, status.id)} className={countLinkClass}>
          {plural(uses.issues, "issue")} {uses.issues === 1 ? "is" : "are"} in
          it
        </Link>{" "}
        — move {uses.issues === 1 ? "it" : "them"} first.
      </>
    );
  }
  if (uses && uses.trashed > 0) {
    return `${plural(uses.trashed, "trashed issue")} ${uses.trashed === 1 ? "is" : "are"} still in it.`;
  }
  return null;
}
