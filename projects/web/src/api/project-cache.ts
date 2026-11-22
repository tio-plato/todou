import type { QueryFilters } from "@tanstack/react-query";
import type { Project } from "@todou/shared";

/**
 * Every slug a project's cache entries can sit under: the one in the address
 * it was opened at, its own, and each it has given up, since the server
 * answers to all of them.
 */
export function projectSlugs(urlSlug: string, project: Project): string[] {
  return [urlSlug, project.slug, ...(project.former_slugs ?? [])];
}

/**
 * The cache entries of the project known by these slugs. Every
 * project-scoped key in the app carries its slug second, so this is the whole
 * project, whatever page read it.
 */
export function projectQueries(slugs: readonly string[]): QueryFilters {
  return {
    predicate: (query) => {
      const key = query.queryKey[1];
      return typeof key === "string" && slugs.includes(key);
    },
  };
}
