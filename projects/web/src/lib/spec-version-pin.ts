import type { QueryClient } from "@tanstack/react-query";
import { type ParsedLocation, redirect } from "@tanstack/react-router";
import { GoneError, MovedError, type SpecInfo } from "@todou/shared";
import { specQuery } from "@/api/spec.ts";
import type { SpecSearch } from "@/lib/spec-search.ts";

/**
 * The spec route's `beforeLoad`: an address without `v` ("the latest spec",
 * as badges, the sidebar and search hits spell it) is rewritten to the
 * version that is current right now, before the page renders. The page then
 * reads its version from the URL alone, so a push arriving while the reader
 * is on it cannot swap the document — or the version a review is submitted
 * for — out from under them.
 *
 * Fetched rather than read from the cache: a spec cached by an earlier visit
 * can be a push behind, and pinning that would open an old version as if it
 * were the latest. When the server cannot answer, the cached spec is the
 * newest version known, and pinning it is what the page showed before. A
 * card with no spec stays as it is and shows its empty state; a move, or a
 * failure with nothing cached, is left to the route's error boundary, which
 * is what follows a moved card to its new address.
 */
export async function pinSpecVersion({
  context,
  params,
  search,
  location,
}: {
  context: { queryClient: QueryClient };
  params: { slug: string; number: string };
  search: SpecSearch;
  location: ParsedLocation;
}): Promise<void> {
  if (search.v !== undefined) return;
  const query = specQuery(params.slug, Number(params.number));
  const cached = context.queryClient.getQueryData(query.queryKey);
  let spec: SpecInfo | null;
  try {
    spec = await context.queryClient.fetchQuery({
      ...query,
      staleTime: 0,
      // Offline, a query would pause until the browser is back online, and
      // the navigation with it; this one fails instead and falls back.
      networkMode: "always",
      ...(cached == null ? {} : { retry: false }),
    });
  } catch (error) {
    if (
      cached == null ||
      error instanceof MovedError ||
      error instanceof GoneError
    ) {
      throw error;
    }
    spec = cached;
  }
  if (spec === null) return;
  throw redirect({
    to: "/projects/$slug/issues/$number/spec",
    params,
    search: { ...search, v: spec.current_version },
    replace: true,
    // The entry being replaced holds where the reader came from (T-407).
    state: location.state,
  });
}
