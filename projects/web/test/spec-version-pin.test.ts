import { onlineManager, QueryClient } from "@tanstack/react-query";
import { isRedirect, type ParsedLocation } from "@tanstack/react-router";
import { type SpecInfo, TodouNetworkError } from "@todou/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/queries.ts";
import { pinSpecVersion } from "../src/lib/spec-version-pin.ts";

const specAt = (version: number): SpecInfo => ({
  current_version: version,
  current_version_cursor: `c${version}`,
  review_status: "unreviewed",
  unresolved_comments: 0,
  unresolved_carried_comments: 0,
  files: [{ path: "design.md", size: 1 }],
  versions: [],
});

const STATE = { __TSR_index: 3, origin: "search" };

/** The spec route's `beforeLoad`, for an address that names no version. */
async function pin(queryClient: QueryClient) {
  try {
    await pinSpecVersion({
      context: { queryClient },
      params: { slug: "demo", number: "7" },
      search: { file: "design.md" },
      location: { state: STATE } as unknown as ParsedLocation,
    });
  } catch (thrown) {
    if (isRedirect(thrown)) return thrown.options;
    throw thrown;
  }
  return null;
}

/** A spec cached by an earlier visit, still fresh as far as the cache knows. */
function clientCaching(version: number) {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
  });
  client.setQueryData(["spec", "demo", 7], specAt(version));
  return client;
}

afterEach(() => {
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
});

describe("pinning an address without a version", () => {
  it("redirects to the version the server reports, whatever the cache holds", async () => {
    vi.spyOn(api, "getSpec").mockResolvedValue(specAt(2));
    expect(await pin(clientCaching(1))).toMatchObject({
      to: "/projects/$slug/issues/$number/spec",
      params: { slug: "demo", number: "7" },
      search: { file: "design.md", v: 2 },
      replace: true,
      state: STATE,
    });
  });

  it("falls back to the cached version when the server cannot be reached, offline too", async () => {
    onlineManager.setOnline(false);
    vi.spyOn(api, "getSpec").mockRejectedValue(
      new TodouNetworkError(new TypeError("Failed to fetch")),
    );
    expect(await pin(clientCaching(2))).toMatchObject({
      search: { file: "design.md", v: 2 },
    });
  });
});
