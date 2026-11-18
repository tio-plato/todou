import type { Project, ProjectTemplate, TemplateRef } from "@todou/shared";
import { useCallback, useMemo } from "react";
import { ProjectListbox } from "@/components/project-listbox.tsx";
import { SearchableListbox } from "@/components/searchable-listbox.tsx";
import { Segmented } from "@/components/settings/status-set-list.tsx";
import { MatchHighlight } from "@/components/shared/match-highlight.tsx";
import { matchText, type ProjectMatch } from "@/lib/project-match.ts";

/**
 * The template the account starts new projects from: the one its prefs
 * name, or Default once that one is gone — a deleted template leaves the
 * pref behind, and nothing on the server clears it.
 */
export function preferredTemplate(
  templates: readonly ProjectTemplate[],
  preferred: TemplateRef,
): TemplateRef {
  return templates.some((template) => template.ref === preferred)
    ? preferred
    : "default";
}

/**
 * Choosing one template. Rows match on the name and are keyed by the ref,
 * which is also what `value` names.
 */
export function TemplateListbox({
  templates,
  value,
  onChange,
  label = "Templates",
  idPrefix = "template",
  className,
  listClassName,
}: {
  templates: readonly ProjectTemplate[];
  value: TemplateRef;
  onChange: (ref: TemplateRef) => void;
  label?: string;
  /** Namespaces the row ids; two lists on one page need two. */
  idPrefix?: string;
  className?: string;
  listClassName?: string;
}) {
  const match = useCallback((template: ProjectTemplate, query: string) => {
    const range = matchText(template.name, query);
    return range === undefined ? null : { range };
  }, []);
  return (
    <SearchableListbox<ProjectTemplate, { range: ProjectMatch["range"] }>
      options={templates}
      optionKey={(template) => String(template.ref)}
      match={match}
      renderOption={(template, hit) => (
        <span className="truncate">
          {hit ? (
            <MatchHighlight text={template.name} range={hit.range} />
          ) : (
            template.name
          )}
        </span>
      )}
      selected={String(value)}
      onSelect={(template) => onChange(template.ref)}
      label={label}
      idPrefix={idPrefix}
      searchPlaceholder="Search templates…"
      emptyText="No matching template."
      className={className}
      listClassName={listClassName}
    />
  );
}

/**
 * Where a new project or template takes its statuses and labels from. Both
 * choices are kept, so switching back finds the one picked before; `kind`
 * says which of them counts.
 */
export type StartFrom = {
  kind: "template" | "project";
  template: TemplateRef;
  /** A slug; null until a project is picked. */
  project: string | null;
};

/** A template, or one of the viewer's projects as it stands. */
export function StartFromPicker({
  templates,
  projects,
  value,
  onChange,
  idPrefix = "start-from",
}: {
  templates: readonly ProjectTemplate[];
  projects: readonly Project[];
  value: StartFrom;
  onChange: (value: StartFrom) => void;
  idPrefix?: string;
}) {
  const options = useMemo(
    () => projects.map((project) => ({ project })),
    [projects],
  );
  return (
    <div className="space-y-2">
      <Segmented
        label="Start from"
        options={[
          ["template", "Template"],
          ["project", "Project"],
        ]}
        value={value.kind}
        onChange={(kind) => onChange({ ...value, kind })}
      />
      {value.kind === "template" ? (
        <TemplateListbox
          templates={templates}
          value={value.template}
          onChange={(template) => onChange({ ...value, template })}
          idPrefix={`${idPrefix}-template`}
          className="rounded-md border"
          listClassName="max-h-56"
        />
      ) : (
        <ProjectListbox
          options={options}
          // Never undefined, so the check column stands before the first pick.
          selected={value.project ?? ""}
          onSelect={(option) =>
            onChange({ ...value, project: option.project.slug })
          }
          label="Projects"
          idPrefix={`${idPrefix}-project`}
          searchPlaceholder="Search projects…"
          emptyText="No project to start from."
          className="rounded-md border"
          listClassName="max-h-56"
        />
      )}
    </div>
  );
}
