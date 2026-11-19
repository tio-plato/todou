import type { LinkProps } from "@tanstack/react-router";
import type { Project } from "@todou/shared";
import { type ReactElement, type ReactNode, useCallback, useMemo } from "react";
import {
  SearchableListbox,
  type SearchableListboxHandle,
  type SearchableListboxProps,
} from "@/components/searchable-listbox.tsx";
import { ProjectIcon } from "@/components/shared/project-icon.tsx";
import { ProjectRow } from "@/components/shared/project-row.tsx";
import { matchProject, type ProjectMatch } from "@/lib/project-match.ts";
import { useProjectRefs } from "@/lib/use-project-refs.ts";

export type ProjectListboxOption = {
  project: Project;
  /** Present renders an `<a href>`; absent renders a `<button>`. */
  link?: LinkProps;
  /** Beside the name — the Reference submenu's `(current)`. */
  note?: ReactNode;
  /** After the spelling token — the navbar's unread badge. */
  trailing?: ReactNode;
  /** Greys the name; the navbar marks projects never visited. */
  muted?: boolean;
  /** Announced in place of the row's own text. */
  ariaLabel?: string;
};

export type ProjectListboxHandle = SearchableListboxHandle;

/**
 * Choosing a project, for the navbar switcher, the Move dialog and the
 * Reference-in-a-new-issue submenu alike: rows match on name, slug or
 * reference prefix, read as a `ProjectRow`, and are keyed (and `selected`
 * named) by slug.
 */
export function ProjectListbox({
  options,
  wrapRow,
  ...props
}: Omit<
  SearchableListboxProps<ProjectListboxOption, ProjectMatch>,
  "optionKey" | "match" | "renderOption" | "optionLink" | "optionAriaLabel"
> & {
  /** Hangs something on a row as drawn — the Start from picker's preview. */
  wrapRow?: (row: ReactElement, option: ProjectListboxOption) => ReactNode;
}) {
  const projects = useMemo(() => options.map((o) => o.project), [options]);
  const refs = useProjectRefs(projects);

  const match = useCallback(
    (option: ProjectListboxOption, q: string) =>
      matchProject(
        {
          name: option.project.name,
          slug: option.project.slug,
          prefix: refs.get(option.project.slug)?.prefix ?? null,
        },
        q,
      ),
    [refs],
  );

  return (
    <SearchableListbox
      {...props}
      options={options}
      optionKey={(option) => option.project.slug}
      match={match}
      renderOption={(option, hit) => {
        const prefix = refs.get(option.project.slug)?.prefix ?? null;
        const row = (
          <ProjectRow
            project={{
              name: option.project.name,
              slug: option.project.slug,
              prefix,
            }}
            match={hit}
            muted={option.muted}
            note={option.note}
            icon={
              <ProjectIcon
                aria-hidden="true"
                project={{
                  slug: option.project.slug,
                  name: option.project.name,
                  prefix,
                  icon_url: option.project.icon_url,
                }}
                className="size-5"
              />
            }
            trailing={option.trailing}
          />
        );
        return wrapRow ? wrapRow(row, option) : row;
      }}
      optionLink={(option) => option.link}
      optionAriaLabel={(option) => option.ariaLabel}
    />
  );
}
