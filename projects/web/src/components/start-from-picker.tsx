import type {
  Project,
  ProjectTemplate,
  TemplateBody,
  TemplateRef,
} from "@todou/shared";
import { useCallback, useMemo } from "react";
import { ProjectListbox } from "@/components/project-listbox.tsx";
import { SearchableListbox } from "@/components/searchable-listbox.tsx";
import { Segmented } from "@/components/settings/status-set-list.tsx";
import { MatchHighlight } from "@/components/shared/match-highlight.tsx";
import {
  ProjectHoverCard,
  TemplateHoverCard,
} from "@/components/template-preview.tsx";
import { matchText, type ProjectMatch } from "@/lib/project-match.ts";

/** A template this version can read, and so one something can be made from. */
export type UsableTemplate = ProjectTemplate & { body: TemplateBody };
export const usable = (template: ProjectTemplate): template is UsableTemplate =>
  template.body !== null;

/**
 * The template the account starts new projects from: the one its prefs
 * name, or Default once that one is gone or unreadable — a deleted template
 * leaves the pref behind, and nothing on the server clears it.
 */
export function preferredTemplate(
  templates: readonly ProjectTemplate[],
  preferred: TemplateRef,
): TemplateRef {
  return templates.some(
    (template) => template.ref === preferred && usable(template),
  )
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
  // One this version cannot read is listed on its own page, not here.
  const options = useMemo(() => templates.filter(usable), [templates]);
  const match = useCallback((template: ProjectTemplate, query: string) => {
    const range = matchText(template.name, query);
    return range === undefined ? null : { range };
  }, []);
  return (
    <SearchableListbox<UsableTemplate, { range: ProjectMatch["range"] }>
      options={options}
      optionKey={(template) => String(template.ref)}
      match={match}
      renderOption={(template, hit) => (
        // Outside a dialog: clear of the option's padding, the list's, its
        // scrollbar and its border, so the card covers none of them. In one,
        // the card starts past the dialog instead.
        <TemplateHoverCard
          template={template}
          side="right"
          align="start"
          sideOffset={32}
        >
          <span className="min-w-0 flex-1 truncate">
            {hit ? (
              <MatchHighlight text={template.name} range={hit.range} />
            ) : (
              template.name
            )}
          </span>
        </TemplateHoverCard>
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
          wrapRow={(row, option) => (
            <ProjectHoverCard
              slug={option.project.slug}
              side="right"
              align="start"
              sideOffset={32}
            >
              {/* One element to hover: the row is a run of siblings, laid out
                  here as the option itself lays them out. */}
              <span className="flex min-w-0 flex-1 items-center gap-2">
                {row}
              </span>
            </ProjectHoverCard>
          )}
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
