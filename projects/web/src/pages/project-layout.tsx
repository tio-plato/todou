import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  useMatches,
  useNavigate,
  useParams,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { projectQueries, projectSlugs } from "@/api/project-cache.ts";
import { projectQuery } from "@/api/queries.ts";
import { useRecordProjectVisit } from "@/api/useProjectOrder.ts";
import { PagePending } from "@/components/page-skeleton.tsx";
import { Button } from "@/components/ui/button";
import { statusOf } from "@/lib/http-status.ts";

// No project-name heading here: the shell's breadcrumb already carries it
// (T-88; the description stays on the projects overview). Live updates ride
// the shell's user-level stream (T-122), not a per-project subscription.
export function ProjectLayout() {
  const { slug } = useParams({ from: "/authed/projects/$slug" });
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // Non-blocking: the page renders against the requested slug, which the
  // server resolves either way, and swaps the URL once the answer lands.
  // Errors are thrown rather than left in query state so the route's
  // errorComponent can answer for them — an unresolvable slug used to
  // render nothing at all.
  //
  // A 404 under a child route that resolves its own address is the one
  // exception: a card's old address stays valid after the reader loses
  // access to the project that once held it, and only the card's own route
  // knows where the card went. Throwing here would replace that redirect
  // with a dead end.
  const childOwnsMiss = useMatches({
    select: (matches) => matches.some((m) => m.staticData.resolvesProjectMiss),
  });
  const project = useQuery({
    ...projectQuery(slug),
    throwOnError: (error, query) => {
      // A warm-state failure (data still cached) is no reason to throw: the
      // page can keep rendering the last good answer while refetches fail,
      // and throwing here would replace the whole shell — the guard and
      // every draft under this layout with it — via ProjectRouteError's
      // non-404 rethrow. The check below is the cold-start question only:
      // has this query ever answered? A warm 404, and an answer naming
      // another project, are the reset's below, which sends them down this
      // cold-start path.
      if (query.state.data !== undefined) return false;
      return statusOf(error) !== 404 || !childOwnsMiss;
    },
  });
  const canonical = project.data?.slug;

  // The project this address has shown. Recorded during render, as
  // `sessionLoss` is in router.tsx, and per slug: moving to another project
  // keeps this layout mounted, and its first render there still holds the
  // project left behind.
  const queryClient = useQueryClient();
  const [shown, setShown] = useState<{
    slug: string;
    id: number;
    slugs: string[];
  } | null>(null);
  if (project.data !== undefined && (shown === null || shown.slug !== slug)) {
    setShown({
      slug,
      id: project.data.id,
      slugs: projectSlugs(slug, project.data),
    });
  }
  // Set while the read that follows a reset is out, and cleared by its
  // answer: a project, or an error a card route answers for itself.
  const [reloading, setReloading] = useState(false);
  if (reloading && (project.data !== undefined || project.isError)) {
    setReloading(false);
  }
  const current = shown?.slug === slug ? shown : null;
  // That project has left this address: deleted, or out of the reader's
  // reach — the server answers 404 to both — or its slug now names another
  // project, one that took it over or that held it before. Any other failure
  // keeps the page on the last good answer.
  const gone =
    current !== null &&
    project.data !== undefined &&
    ((project.isError && statusOf(project.error) === 404) ||
      project.data.id !== current.id);

  useEffect(() => {
    if (!gone || current === null) return;
    // Forgotten, or the answer the reload brings would read as gone too and
    // reset again, without end.
    setShown(null);
    setReloading(true);
    // Back to how a reload of this address finds it: with nothing cached,
    // the project's read is a cold start again, which answers a 404 with
    // the route's error and anything else with whatever now holds the
    // address. Reset rather than removed, so whatever still reads it hears
    // of it; every slug of the project, so none answers Back with what is
    // gone. The page under this layout is already down (below), so its
    // reads are not refetched with the project's: answered 404 they would
    // stay cached as errors, which react-query throws again, unfetched, at
    // whatever page next reads them here, even once the address answers.
    // Reads outside it, the header's and the tab title's, are refetched, as
    // on a reload.
    void queryClient.resetQueries(projectQueries(current.slugs));
  }, [gone, current, queryClient]);

  useEffect(() => {
    if (canonical === undefined || canonical === slug) return;
    // Only the project segment moves; deep links keep their tail. replace,
    // because the retired spelling is not a place to go back to.
    navigate({
      to: pathname.replace(
        `/projects/${encodeURIComponent(slug)}`,
        `/projects/${encodeURIComponent(canonical)}`,
      ),
      replace: true,
    });
  }, [canonical, slug, pathname, navigate]);

  // Feed the frecency ordering (T-76) — under the canonical name, so a
  // retired slug never earns its own entry in the switcher's history.
  useRecordProjectVisit(canonical);

  // What the shell draws while a page loads, as a reload would, until the
  // project's own read has answered.
  if (gone || reloading) return <PagePending />;
  return <Outlet />;
}

/**
 * A slug that resolves to nothing — never used, or retired and since taken
 * by a project this viewer cannot read. Anything else is not ours to
 * explain, so it goes back up to the router's own error boundary.
 */
export function ProjectRouteError({ error }: { error: Error }) {
  if (statusOf(error) !== 404) throw error;
  return (
    <div className="rounded-lg border border-dashed p-10 text-center">
      <p className="text-muted-foreground">
        This project does not exist, or you do not have access to it.
      </p>
      <Button asChild size="sm" className="mt-4">
        <Link to="/projects">All projects</Link>
      </Button>
    </div>
  );
}
