import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  type AnyRouter,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  type RenderResult,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import type {
  Issue,
  IssueQuestions,
  IssueQuestionsItem,
  Me,
  Project,
  QuestionsComponent,
  TimelineComment,
  TimelineEvent,
  TimelineItem,
  TimelinePage,
} from "@todou/shared";
import { type ReactElement, Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { questionsQuery } from "../src/api/questions.ts";
import { UnsavedChangesGuard } from "../src/components/shared/unsaved-guard.tsx";
import { QUESTION_LANDING_ROUTE_ID } from "../src/components/timeline/use-question-landing.ts";
import { selectNextQuestionLanding } from "../src/lib/question-landing.ts";
import { isGliding, usableViewport } from "../src/lib/scroll-insets.ts";
import { registerDirtySource } from "../src/lib/unsaved-guard.ts";
import { IssueDetailPage } from "../src/pages/issue-detail.tsx";
import { IssueRouteError } from "../src/pages/issue-route-error.tsx";
import {
  ProjectLayout,
  ProjectRouteError,
} from "../src/pages/project-layout.tsx";
import { router as appRouter } from "../src/router.tsx";
import { stubConversationEnd } from "./conversation-end.ts";
import { FakeResizeObserver, resizePage } from "./fake-resize-observer.ts";

// These imports deliberately reach the production keyed Timeline through the
// actual detail page, so `vitest related` follows the same graph as the app.
const ENTRY = "unanswered-questions";
const LOCATE_FAILURE = "Couldn't locate questions.";
const UNAVAILABLE = "This question is no longer available.";
const user = {
  id: 1,
  login: "user",
  display_name: "User",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};
const timestamp = (second: number) =>
  new Date(Date.UTC(2026, 8, 10, 10, 0, second)).toISOString();
const me: Me = {
  ...user,
  email: null,
  is_instance_admin: false,
  created_at: timestamp(0),
};
const status = {
  id: 1,
  name: "Todo",
  category: "open" as const,
  color: "#6b7280",
  position: 0,
  is_default: true,
};

function question(id: number, createdAt = timestamp(id)): IssueQuestionsItem {
  return {
    comment_id: id,
    author: user,
    created_at: createdAt,
    questions: [
      {
        key: "q1",
        multiple: false,
        question: `Decision ${id}?`,
        options: [{ label: "Proceed" }, { label: "Wait" }],
      },
    ],
    answer: null,
    withdrawal: null,
  };
}

function withdrawn(item: IssueQuestionsItem, at: number): IssueQuestionsItem {
  return {
    ...item,
    withdrawal: {
      event_id: 20_000 + item.comment_id,
      actor: user,
      created_at: timestamp(at),
      reason: "moot",
    },
  };
}

function answered(
  item: IssueQuestionsItem,
  at: number,
  declined = false,
): IssueQuestionsItem {
  return {
    ...item,
    answer: {
      event_id: 10_000 + item.comment_id,
      actor: user,
      created_at: timestamp(at),
      answers: [
        {
          key: "q1",
          selected: declined ? [] : [{ index: 0, label: "Proceed" }],
          other: null,
          declined,
        },
      ],
    },
  };
}

const questions = (items: IssueQuestionsItem[]): IssueQuestions => ({
  items,
  open: items.reduce(
    (count, item) =>
      count +
      (item.answer === null && item.withdrawal === null
        ? item.questions.length
        : 0),
    0,
  ),
});

const comment = (id: number, body = `comment body ${id}`): TimelineComment => ({
  type: "comment",
  id,
  author: user,
  body,
  component: null,
  created_at: timestamp(id),
  edited_at: null,
  resolved_at: null,
  hidden_at: null,
  agent_context: null,
});
/** Someone else's comment: the reader's own is never news to them. */
const theirs = (id: number): TimelineComment => ({
  ...comment(id),
  author: { ...user, id: 2, login: "alice", display_name: "Alice" },
});

function questionComment(item: IssueQuestionsItem, hidden = false) {
  return {
    ...comment(item.comment_id),
    created_at: item.created_at,
    component: {
      type: "questions",
      questions: item.questions,
    } satisfies QuestionsComponent,
    hidden_at: hidden ? (item.answer?.created_at ?? null) : null,
  } satisfies TimelineComment;
}

function answerEvent(item: IssueQuestionsItem): TimelineEvent {
  if (item.answer === null) throw new Error("An answer event needs an answer");
  return {
    type: "event",
    id: item.answer.event_id,
    actor: item.answer.actor,
    created_at: item.answer.created_at,
    event_type: "question_answered",
    payload: { comment_id: item.comment_id, answers: item.answer.answers },
    agent_context: null,
  };
}

function withdrawalEvent(item: IssueQuestionsItem): TimelineEvent {
  if (item.withdrawal === null) {
    throw new Error("A withdrawal event needs a withdrawal");
  }
  return {
    type: "event",
    id: item.withdrawal.event_id,
    actor: item.withdrawal.actor,
    created_at: item.withdrawal.created_at,
    event_type: "question_withdrawn",
    payload: { comment_id: item.comment_id, reason: item.withdrawal.reason },
    agent_context: null,
  };
}

const ordered = (items: TimelineItem[]) =>
  [...items].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id,
  );

function questionItems(items: IssueQuestionsItem[], hiddenIds: number[] = []) {
  return ordered(
    items.flatMap((item): TimelineItem[] => [
      questionComment(item, hiddenIds.includes(item.comment_id)),
      ...(item.answer === null ? [] : [answerEvent(item)]),
      ...(item.withdrawal === null ? [] : [withdrawalEvent(item)]),
    ]),
  );
}

/** Fifty-item windows with real overlap/deduplication and an opaque cursor
 * mapping. A target around 125 needs two after requests, not just one. */
function pagedItems(items: IssueQuestionsItem[], count = 200) {
  const byId = new Map(items.map((item) => [item.comment_id, item]));
  return ordered([
    ...Array.from({ length: count }, (_, index) => {
      const id = index + 1;
      const item = byId.get(id);
      return item === undefined ? comment(id) : questionComment(item);
    }),
    ...items.filter((item) => item.answer !== null).map(answerEvent),
  ]);
}

function timelinePage(
  items: TimelineItem[],
  url: URL,
  pageSize = 50,
): TimelinePage {
  const after = url.searchParams.get("after");
  const start = url.searchParams.has("last")
    ? Math.max(0, items.length - pageSize)
    : after === null
      ? 0
      : Number(/^cursor-(\d+)$/.exec(after)?.[1]);
  if (!Number.isInteger(start) || start < 0 || start > items.length) {
    throw new Error(`Unexpected timeline cursor: ${url.search}`);
  }
  const slice = items.slice(start, start + pageSize);
  return {
    items: slice,
    prev_cursor: start === 0 ? null : `before-${start}`,
    next_cursor: slice.length === 0 ? null : `cursor-${start + slice.length}`,
    total_count: items.length,
  };
}

const json = (body: unknown, statusCode = 200) =>
  Response.json(body, { status: statusCode });
const failure = (message: string) =>
  json({ error: { code: "internal", message } }, 500);

type Reply = Response | Promise<Response>;
type Card = {
  questions: IssueQuestions;
  items: TimelineItem[];
  pageSize?: number;
  questionReply?: () => Reply;
  timelineReply?: (url: URL) => Reply;
  issueReply?: () => Reply;
};
function card(
  items: IssueQuestionsItem[] = [],
  timeline = questionItems(items),
): Card {
  return { questions: questions(items), items: timeline };
}

/** Recovery follows cursors/counts, not response length. Keep the real
 * limit=50 request but serve two-row windows at the HTTP boundary; production
 * normally fills that limit. Seven rows are the minimum for a target outside
 * the head/tail that needs two after pages: [1,2], [3,4], [target,200],
 * tail [200,201]. The overlap also exercises seam deduplication. */
function recoveryCard(
  items: IssueQuestionsItem[],
  timeline = ordered([
    comment(1),
    comment(2),
    comment(3),
    comment(4),
    ...questionItems(items),
    comment(200),
    comment(201),
  ]),
): Card {
  return { ...card(items, timeline), pageSize: 2 };
}

function issue(number: number, model: Card): Issue {
  return {
    id: number,
    number,
    title: `Card ${number}`,
    body_preview: null,
    body: "",
    status,
    author: user,
    assignees: [],
    labels: [],
    created_at: timestamp(0),
    updated_at: timestamp(300),
    body_edited_at: null,
    open_questions: model.questions.open,
    spec_version: null,
    spec_review_status: null,
    spec_unresolved_comments: 0,
    deleted_at: null,
    deleted_by: null,
    unread: false,
    unread_comments: 0,
    muted: null,
    blocked_by: [],
    blocks: [],
    moves: [],
  };
}

type FetchCall = { url: URL; method: string; body: string | undefined };
const unexpected: string[] = [];
const disposers: Array<() => void> = [];
const initialWindowUrl = window.location.href;

/** Only the HTTP boundary is replaced. Unknown URLs fail, including incidental
 * reads by the real page, comment rows, question cards, and sidebar. */
function serve(
  cards: Record<string, Card>,
  extra?: (call: FetchCall) => Reply | undefined,
) {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: FetchCall = {
        url: new URL(
          input instanceof Request ? input.url : String(input),
          "http://todou.example",
        ),
        method: init?.method ?? "GET",
        body: init?.body === undefined ? undefined : String(init.body),
      };
      calls.push(call);
      const override = extra?.(call);
      if (override !== undefined) return override;
      const path = call.url.pathname;
      if (call.method === "GET") {
        if (path === "/api/me") return json(me);
        if (path === "/api/me/prefs") return json({});
        if (path === "/api/me/mutes") return json({ issues: [], projects: [] });
        if (path === "/api/me/reference-directory") {
          return json({ entries: [], contested: [], slug_entries: [] });
        }
        if (path === "/api/projects") {
          return json(
            ["p", "q"].map(
              (slug, index) =>
                ({
                  id: index + 1,
                  slug,
                  name: slug,
                  description: "",
                  created_at: timestamp(0),
                }) satisfies Project,
            ),
          );
        }
        const project = /^\/api\/projects\/([^/]+)(?:\/(.*))?$/.exec(path);
        if (project !== null) {
          const slug = project[1];
          const rest = project[2] ?? "";
          if (rest === "") {
            return json({
              id: slug === "p" ? 1 : 2,
              slug,
              name: slug,
              description: "",
              created_at: timestamp(0),
              viewer_role: "writer",
            } satisfies Project);
          }
          if (rest === "statuses") return json([status]);
          if (rest === "labels") return json([]);
          if (rest === "watchers") return json({ project: [], issues: {} });
          if (rest === "members") {
            return json([{ user, role: "writer", created_at: timestamp(0) }]);
          }
          if (rest === "references/config") {
            return json({
              format: { prefix: "T", history: [] },
              autolinks: [],
            });
          }
          if (
            rest === "attachments" &&
            cards[`${slug}/${call.url.searchParams.get("issue_number")}`] !==
              undefined
          ) {
            return json([]);
          }
          const match = /^issues\/(\d+)(?:\/(.*))?$/.exec(rest);
          if (match !== null) {
            const number = Number(match[1]);
            const model = cards[`${slug}/${number}`];
            const resource = match[2] ?? "";
            if (model !== undefined) {
              if (resource === "")
                return model.issueReply?.() ?? json(issue(number, model));
              if (resource === "questions")
                return model.questionReply?.() ?? json(model.questions);
              if (resource === "timeline") {
                expect(call.url.searchParams.get("include_hidden")).toBe(
                  "true",
                );
                expect(call.url.searchParams.get("limit")).toBe("50");
                return (
                  model.timelineReply?.(call.url) ??
                  json(timelinePage(model.items, call.url, model.pageSize))
                );
              }
              if (resource === "metadata") return json({ entries: [] });
              if (resource === "metadata/namespaces")
                return json({ namespaces: [] });
              if (resource === "spec") {
                return json(
                  { error: { code: "not_found", message: "No spec" } },
                  404,
                );
              }
              if (resource === "spec/comments") return json({ items: [] });
            }
          }
        }
      }
      if (
        call.method === "PUT" &&
        /^\/api\/projects\/[^/]+\/issues\/\d+\/read$/.test(path)
      ) {
        return new Response(null, { status: 204 });
      }
      const message = `Unexpected fetch: ${call.method} ${path}${call.url.search}`;
      unexpected.push(message);
      throw new Error(message);
    },
  );
  return {
    calls,
    questions: (key = "p/7") =>
      calls.filter(
        (call) =>
          call.url.pathname ===
          `/api/projects/${key.replace("/", "/issues/")}/questions`,
      ),
    timeline: (key = "p/7") =>
      calls.filter(
        (call) =>
          call.url.pathname ===
          `/api/projects/${key.replace("/", "/issues/")}/timeline`,
      ),
  };
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function release(pending: Deferred<Response>, response: Response) {
  await act(async () => {
    pending.resolve(response);
    await pending.promise;
  });
}

function queryClient() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { staleTime: 5_000, retry: false },
      mutations: { retry: false },
    },
  });
  disposers.push(() => client.clear());
  return client;
}

function SourceList() {
  return (
    <main aria-label="Source list">
      <Link
        to="/projects/$slug/issues/$number"
        params={{ slug: "p", number: "7" }}
        hash={ENTRY}
        hashScrollIntoView={false}
      >
        Questions for card 7
      </Link>
    </main>
  );
}

type View = RenderResult & {
  router: AnyRouter;
  client: QueryClient;
  ui: ReactElement;
};

function renderAt(
  url = `/projects/p/issues/7#${ENTRY}`,
  client = queryClient(),
): View {
  const root = createRootRoute();
  const authed = createRoute({
    getParentRoute: () => root,
    id: "authed",
    component: () => (
      <>
        <UnsavedChangesGuard />
        <Outlet />
      </>
    ),
    errorComponent: ({ error }) => (
      <div>Unhandled route error: {error.message}</div>
    ),
  });
  const source = createRoute({
    getParentRoute: () => authed,
    path: "/source",
    component: SourceList,
  });
  const project = createRoute({
    getParentRoute: () => authed,
    path: "/projects/$slug",
    component: ProjectLayout,
    errorComponent: ProjectRouteError,
  });
  const detail = createRoute({
    getParentRoute: () => project,
    path: "issues/$number",
    component: () => (
      <Suspense fallback={<div>Loading card</div>}>
        <IssueDetailPage />
      </Suspense>
    ),
    errorComponent: IssueRouteError,
    staticData: { resolvesProjectMiss: true },
  });
  const history = createMemoryHistory({ initialEntries: [url] });
  // FollowMove reads window.location.hash, while the rest of the page reads
  // router state. Keep them identical before rendering and on every history op.
  window.history.replaceState(null, "", url);
  disposers.push(
    history.subscribe(({ location }) => {
      window.history.replaceState(null, "", location.href);
    }),
  );
  const router = createRouter({
    routeTree: root.addChildren([
      authed.addChildren([source, project.addChildren([detail])]),
    ]),
    history,
  });
  const ui = (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
  return { ...render(ui), router, client, ui };
}

async function navigate(view: View, hash: string, number = 7, slug = "p") {
  await act(async () => {
    await view.router.navigate({
      to: "/projects/$slug/issues/$number",
      params: { slug, number: String(number) },
      hash,
      hashScrollIntoView: false,
    });
  });
}

type Scrolling = {
  events: string[];
  commits: Array<{
    element: Element;
    current: HTMLElement | null;
    connected: boolean;
  }>;
  reveals: (id: string) => number;
  bottoms: () => number;
  userAt: (y: number) => void;
  position: () => number;
};

/** happy-dom cannot lay out the page. Observe production reveal/flash and
 * scroll order, modelling the viewport change without firing a native scroll
 * event; releasing landing ownership must reconcile follow-bottom itself.
 * `below` is what follows the page's column: a phone's sidebar. `revealedAt`
 * is where a reveal leaves the page. */
function scrolling({
  below = 0,
  revealedAt = () => 1_500,
}: {
  below?: number;
  revealedAt?: (el: Element) => number;
} = {}): Scrolling {
  const state = { y: 0, height: 10_000, events: [] as string[] };
  const commits: Scrolling["commits"] = [];
  vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
  vi.spyOn(window, "scrollY", "get").mockImplementation(() => state.y);
  vi.spyOn(document.documentElement, "scrollHeight", "get").mockImplementation(
    () => state.height,
  );
  vi.spyOn(window, "scrollTo").mockImplementation((...args: unknown[]) => {
    const first = args[0];
    const top =
      typeof first === "object" && first !== null
        ? ((first as ScrollToOptions).top ?? state.y)
        : Number(args[1] ?? 0);
    // The end of the conversation on the viewport's bottom is a landing on
    // the bottom as much as the document's end is.
    state.events.push(
      top >= state.height || top === state.height - below - 800
        ? "bottom"
        : `scroll:${top}`,
    );
    state.y = Math.max(0, Math.min(top, state.height - 800));
  });
  vi.spyOn(window, "scrollBy").mockImplementation((...args: unknown[]) => {
    const first = args[0];
    const delta =
      typeof first === "object" && first !== null
        ? ((first as ScrollToOptions).top ?? 0)
        : Number(args[1] ?? 0);
    state.events.push(`prepend:${delta}`);
    state.y = Math.max(0, Math.min(state.y + delta, state.height - 800));
  });
  // The page's column, where its conversation ends, ends with the document
  // but for what follows it.
  stubConversationEnd(() => state.height - below - state.y);
  vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (
    this: Element,
  ) {
    state.events.push(`reveal:${this.id}`);
    commits.push({
      element: this,
      current: document.getElementById(this.id),
      connected: this.isConnected,
    });
    state.y = revealedAt(this);
  });
  return {
    events: state.events,
    commits,
    reveals: (id: string) =>
      state.events.filter((event) => event === `reveal:${id}`).length,
    bottoms: () => state.events.filter((event) => event === "bottom").length,
    // A reader's scroll arrives behind a gesture, and the gesture is what
    // lets go of a held landing (T-527).
    userAt: (y: number) => {
      fireEvent.wheel(window);
      state.y = y;
      fireEvent.scroll(window);
    },
    position: () => state.y,
  };
}

/**
 * New messages is up: the button, in a layer that is showing. The layer stays
 * mounted, and the button in it keeps its look while it fades out.
 */
function newMessagesShown(view: View) {
  return (
    view
      .queryByRole("button", { name: /^(New messages|\d+ new messages?)$/ })
      ?.closest("[data-scroll-to-bottom]")
      ?.getAttribute("data-state") === "shown"
  );
}

async function landed(view: View, scroll: Scrolling, id: number, count = 1) {
  await waitFor(
    () => {
      expect(view.router.state.location.hash).toBe(`comment-${id}`);
      const target = view.container.querySelector(`#comment-${id}`);
      // Presence gets its own assertion: through an optional chain a missing
      // row and a row that rendered without the flash both report
      // `expected undefined to be true`, and the two need different fixes.
      expect(target, `#comment-${id} never rendered`).not.toBeNull();
      expect(target?.classList.contains("anchor-flash")).toBe(true);
      expect(scroll.reveals(`comment-${id}`)).toBe(count);
      const commits = scroll.commits.filter(
        ({ element }) => element.id === `comment-${id}`,
      );
      expect(commits).toHaveLength(count);
      expect(commits.at(-1)?.element).toBe(target);
      expect(commits.at(-1)?.current).toBe(target);
      expect(commits.at(-1)?.connected).toBe(true);
    },
    { timeout: 3_000 },
  );
  expect(view.queryByText(LOCATE_FAILURE)).toBeNull();
  expect(view.queryByText(UNAVAILABLE)).toBeNull();
}

async function refetchTail(view: View, slug = "p", number = 7) {
  await act(async () => {
    await view.client.refetchQueries({
      queryKey: ["timeline", slug, number, "tail"],
      exact: true,
    });
  });
}

function retryFor(view: View, message: string | RegExp) {
  const failureText = view.getByText(message);
  const failureBox = failureText.closest('[role="status"]');
  if (failureBox === null) throw new Error("Missing load failure container");
  return within(failureBox as HTMLElement).getByRole("button", {
    name: "Retry",
  });
}

afterEach(() => {
  cleanup();
  for (const dispose of disposers.splice(0).reverse()) dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeResizeObserver.instances = [];
  window.history.replaceState(null, "", initialWindowUrl);
  document.documentElement.style.removeProperty("scroll-padding-top");
  document.documentElement.style.removeProperty("scroll-padding-bottom");
  expect(unexpected.splice(0)).toEqual([]);
});

describe("question landing through the real issue route", () => {
  it("P2-2 uses the issue detail route registered by the production router", () => {
    const route = appRouter.routesById[QUESTION_LANDING_ROUTE_ID];
    expect(route).toBeDefined();
    expect(route.options.component).toBe(IssueDetailPage);
  });

  it("C5 selects the earliest unanswered by question time and id across two after pages", async () => {
    // The lower id is later; the equal-time contender has the higher id.
    // Choosing by id alone, newest time, or the other tie must not land.
    const items = [
      answered(question(10), 11),
      question(125),
      question(126, timestamp(125)),
      question(5, timestamp(180)),
    ];
    const model = recoveryCard(
      items,
      ordered([...questionItems(items), comment(20), comment(30)]),
    );
    const server = serve({ "p/7": model });
    const scroll = scrolling();
    const view = renderAt();

    await landed(view, scroll, 125);
    await waitFor(() => expect(view.client.isFetching()).toBe(0));
    const target = view.container.querySelector("#comment-125");
    view.rerender(view.ui);
    await act(async () => {});
    await landed(view, scroll, 125);
    expect(view.container.querySelector("#comment-125")).toBe(target);
    // The final head page overlaps the tail at the equal-time contender.
    expect(view.container.querySelectorAll("#comment-126")).toHaveLength(1);

    expect(view.getByText("Decision 125?")).toBeTruthy();
    expect(server.questions()).toHaveLength(1);
    expect(
      server
        .timeline()
        .map(({ url }) => url.searchParams.get("after"))
        .filter(Boolean),
    ).toEqual(["cursor-2", "cursor-4"]);
    expect(
      server.timeline().filter(({ url }) => url.searchParams.has("last")),
    ).toHaveLength(1);
    expect(scroll.reveals("comment-10")).toBe(0);
    expect(scroll.reveals("comment-126")).toBe(0);
    expect(scroll.reveals("comment-5")).toBe(0);
    // However the page moves while the head expands, the reveal comes last.
    expect(scroll.events.at(-1)).toBe("reveal:comment-125");
  });

  it("passes over a withdrawn question to the first one still open", async () => {
    const model = card([withdrawn(question(10), 11), question(12)]);
    const server = serve({ "p/7": model });
    const scroll = scrolling();
    const view = renderAt();
    await landed(view, scroll, 12);
    expect(server.questions()).toHaveLength(1);
    expect(scroll.reveals("comment-10")).toBe(0);
  });

  it.each(["/projects/p/issues/007", "/projects/p/issues/7/"])(
    "C9 resolves the matched card identity at %s",
    async (path) => {
      const model = card([question(10)]);
      const server = serve({ "p/7": model });
      const scroll = scrolling();
      const view = renderAt(`${path}#${ENTRY}`);
      await landed(view, scroll, 10);
      expect(server.questions()).toHaveLength(1);
      expect(scroll.bottoms()).toBe(0);
    },
  );

  it("C6 chooses the latest question rather than latest answer and reveals hidden declined comments", async () => {
    const items = [
      answered(question(10), 500),
      answered(question(20), 30),
      answered(question(21, timestamp(20)), 31, true),
    ];
    const model = card(items, questionItems(items, [21]));
    serve({ "p/7": model });
    const scroll = scrolling();
    const view = renderAt();

    await landed(view, scroll, 21);

    const target = view.container.querySelector<HTMLElement>("#comment-21");
    expect(target).not.toBeNull();
    expect(
      within(target as HTMLElement).getByText("Decision 21?"),
    ).toBeTruthy();
    expect(within(target as HTMLElement).getByText(/declined/i)).toBeTruthy();
    expect(scroll.reveals("comment-10")).toBe(0);
    expect(scroll.reveals("comment-20")).toBe(0);
  });

  it.each(["timeline first", "questions first"])(
    "C6 empty questions scrolls latest exactly once with %s",
    async (order) => {
      const pendingQuestions = deferred<Response>();
      const pendingTimeline = deferred<Response>();
      const model = card([], [comment(1), comment(2)]);
      model.questionReply = () => pendingQuestions.promise;
      model.timelineReply = () => pendingTimeline.promise;
      const server = serve({ "p/7": model });
      const scroll = scrolling();
      const view = renderAt();
      await waitFor(() => expect(server.questions()).toHaveLength(1));
      await waitFor(() => expect(server.timeline()).toHaveLength(1));
      const tail = () =>
        json(
          timelinePage(model.items, new URL("http://todou.example/?last=1")),
        );

      if (order === "timeline first") {
        await release(pendingTimeline, tail());
        await view.findByText("comment body 2");
        expect(scroll.bottoms()).toBe(0);
        expect(view.router.state.location.hash).toBe(ENTRY);
        await release(pendingQuestions, json(model.questions));
      } else {
        await release(pendingQuestions, json(model.questions));
        await waitFor(() => expect(view.router.state.location.hash).toBe(""));
        expect(scroll.bottoms()).toBe(0);
        await release(pendingTimeline, tail());
      }
      await waitFor(() => expect(scroll.bottoms()).toBe(1));
      expect(view.router.state.location.hash).toBe("");
      view.rerender(view.ui);
      await act(async () => {});
      expect(scroll.bottoms()).toBe(1);
      expect(view.queryByText(LOCATE_FAILURE)).toBeNull();
    },
  );

  it("C6 the latest fallback holds the end while the card goes on loading (T-527)", async () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const model = card([], [comment(1), comment(2)]);
    serve({ "p/7": model });
    const scroll = scrolling();
    const view = renderAt();
    await waitFor(() => expect(scroll.bottoms()).toBe(1));
    await waitFor(() => expect(view.router.state.location.hash).toBe(""));
    resizePage();
    expect(scroll.bottoms()).toBe(2);
    scroll.userAt(0);
    resizePage();
    expect(scroll.bottoms()).toBe(2);
    expect(scroll.position()).toBe(0);
  });

  it.each(["old unanswered", "empty"])(
    "C7 waits for a fresh read despite a 5000ms %s cache",
    async (cached) => {
      const a = question(10);
      const b = question(20);
      const current = [answered(a, 30), b];
      const model = card(current);
      const pending = deferred<Response>();
      model.questionReply = () => pending.promise;
      const server = serve({ "p/7": model });
      const scroll = scrolling();
      const client = queryClient();
      client.setQueryData(
        questionsQuery("p", 7).queryKey,
        questions(cached === "empty" ? [] : [a]),
      );
      const view = renderAt(undefined, client);

      await waitFor(() => expect(server.questions()).toHaveLength(1));
      await view.findByText("Decision 20?");
      expect(view.router.state.location.hash).toBe(ENTRY);
      expect(scroll.reveals("comment-10")).toBe(0);
      expect(scroll.bottoms()).toBe(0);

      await release(pending, json(model.questions));
      await landed(view, scroll, 20);
      expect(server.questions()).toHaveLength(1);
      expect(scroll.reveals("comment-10")).toBe(0);
    },
  );

  it("C7 failed fresh reads keep the semantic entry and Retry fetches again without adding history", async () => {
    const a = question(10);
    const b = question(20);
    const model = card([a, b]);
    model.questionReply = () => failure("questions unavailable");
    const server = serve({ "p/7": model });
    const scroll = scrolling();
    const client = queryClient();
    client.setQueryData(questionsQuery("p", 7).queryKey, questions([a]));
    const view = renderAt(undefined, client);

    await view.findByText(LOCATE_FAILURE);
    expect(view.router.state.location.hash).toBe(ENTRY);
    expect(scroll.bottoms()).toBe(0);
    expect(scroll.reveals("comment-10")).toBe(0);
    const before = server.questions().length;
    const length = view.router.history.length;
    model.questions = questions([answered(a, 30), b]);
    model.questionReply = undefined;
    fireEvent.click(retryFor(view, LOCATE_FAILURE));

    await landed(view, scroll, 20);
    expect(server.questions()).toHaveLength(before + 1);
    expect(view.router.history.length).toBe(length);
  });

  it.each(["server", "network"])(
    "P2-3 preserves the %s error detail and disables Retry during its new read",
    async (kind) => {
      const model = card([question(10)]);
      const detail =
        kind === "server" ? "questions unavailable (500)" : "Failed to fetch";
      model.questionReply = () =>
        kind === "server"
          ? failure(detail)
          : Promise.reject(new TypeError(detail));
      const server = serve({ "p/7": model });
      const scroll = scrolling();
      const view = renderAt();
      const message = await view.findByText(LOCATE_FAILURE);
      expect(message.getAttribute("title")).toBe(detail);
      expect(scroll.bottoms()).toBe(0);
      const pending = deferred<Response>();
      model.questionReply = () => pending.promise;
      const before = server.questions().length;
      fireEvent.click(retryFor(view, LOCATE_FAILURE));
      await waitFor(() => expect(server.questions()).toHaveLength(before + 1));
      expect(view.getByText(LOCATE_FAILURE).getAttribute("title")).toBe(detail);
      expect(
        (retryFor(view, LOCATE_FAILURE) as HTMLButtonElement).disabled,
      ).toBe(true);
      expect(view.router.state.location.hash).toBe(ENTRY);
      await release(pending, json(model.questions));
      await landed(view, scroll, 10);
      expect(view.queryByText(LOCATE_FAILURE)).toBeNull();
    },
  );

  it("P2-1 question read failure preserves live following and new-below notification", async () => {
    const model = card([], [comment(1), comment(2)]);
    model.questionReply = () => failure("questions unavailable");
    serve({ "p/7": model });
    const scroll = scrolling();
    const view = renderAt();
    await view.findByText(LOCATE_FAILURE);
    await view.findByText("comment body 2");
    expect(scroll.bottoms()).toBe(0);
    expect(view.router.state.location.hash).toBe(ENTRY);

    scroll.userAt(9_200);
    model.items.push(comment(3));
    await refetchTail(view);
    await view.findByText("comment body 3");
    await waitFor(() => expect(scroll.bottoms()).toBe(1));

    scroll.userAt(0);
    model.items.push(theirs(4));
    await refetchTail(view);
    await view.findByText("comment body 4");
    expect(scroll.bottoms()).toBe(1);
    expect(newMessagesShown(view)).toBe(true);
    expect(view.getByText(LOCATE_FAILURE)).toBeTruthy();
    expect(view.router.state.location.hash).toBe(ENTRY);
    expect(scroll.events.some((event) => event.startsWith("reveal:"))).toBe(
      false,
    );
  });

  it("P2-1 failure before the first timeline page does not trigger initial bottom positioning", async () => {
    const model = card([], [comment(1), comment(2)]);
    const pending = deferred<Response>();
    model.questionReply = () => failure("questions unavailable");
    model.timelineReply = () => pending.promise;
    const server = serve({ "p/7": model });
    const scroll = scrolling();
    const view = renderAt();
    await waitFor(() => {
      expect(server.questions()).toHaveLength(1);
      expect(
        view.client.getQueryState(questionsQuery("p", 7).queryKey)?.status,
      ).toBe("error");
    });
    await release(
      pending,
      json(timelinePage(model.items, new URL("http://todou.example/?last=1"))),
    );
    await view.findByText(LOCATE_FAILURE);
    await view.findByText("comment body 2");
    expect(scroll.bottoms()).toBe(0);
    expect(view.router.state.location.hash).toBe(ENTRY);
  });

  it("C8 reentering the same card reveals the same comment again without chasing answers or rerenders", async () => {
    const a = question(10);
    const b = question(20);
    const model = card([a, b]);
    const server = serve({ "p/7": model }, ({ url, method, body }) => {
      if (
        method !== "POST" ||
        url.pathname !== "/api/projects/p/issues/7/comments/10/answers"
      )
        return undefined;
      expect(JSON.parse(body ?? "null")).toEqual({
        answers: [{ key: "q1", selected: [0], declined: false }],
      });
      const done = answered(a, 30);
      model.questions = questions([done, b]);
      model.items = questionItems([done, b]);
      return json(answerEvent(done));
    });
    const scroll = scrolling();
    const view = renderAt();
    await landed(view, scroll, 10);
    const firstNode = view.container.querySelector("#comment-10");
    const before = server.questions().length;
    await navigate(view, ENTRY);
    await landed(view, scroll, 10, 2);
    expect(server.questions()).toHaveLength(before + 1);
    expect(view.container.querySelector("#comment-10")).toBe(firstNode);

    view.rerender(view.ui);
    const target = within(firstNode as HTMLElement);
    fireEvent.click(target.getByRole("button", { name: "Proceed" }));
    fireEvent.click(target.getByRole("button", { name: "Submit answers" }));
    await waitFor(() => expect(target.getByText("answered by")).toBeTruthy());
    await waitFor(() => expect(view.client.isFetching()).toBe(0));
    await refetchTail(view);

    expect(view.router.state.location.hash).toBe("comment-10");
    expect(scroll.reveals("comment-10")).toBe(2);
    expect(scroll.reveals("comment-20")).toBe(0);
    expect(scroll.bottoms()).toBe(0);
  });

  it("C8 internal question annotation bypasses the real unsaved guard while ordinary exits remain blocked", async () => {
    const model = card([question(10)]);
    const pending = deferred<Response>();
    model.questionReply = () => pending.promise;
    const server = serve({ "p/7": model });
    const scroll = scrolling();
    const view = renderAt();
    await waitFor(() => expect(server.questions()).toHaveLength(1));
    await view.findByText("Decision 10?");
    expect(view.router.state.location.hash).toBe(ENTRY);
    disposers.push(registerDirtySource(() => true));

    await release(pending, json(model.questions));
    await landed(view, scroll, 10);
    expect(view.queryByRole("dialog")).toBeNull();
    expect(view.router.history.length).toBe(1);

    act(() => {
      void view.router.navigate({ href: "/source" });
    });
    const dialog = await view.findByRole("dialog", {
      name: "Leave with unsaved changes?",
    });
    expect(view.router.state.location.pathname).toBe("/projects/p/issues/7");
    expect(view.router.state.location.hash).toBe("comment-10");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Keep editing" }),
    );
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
    expect(scroll.reveals("comment-10")).toBe(1);
    expect(view.router.state.location.pathname).toBe("/projects/p/issues/7");
  });

  it("C8 leaving the semantic entry cancels its late response before a new same-card intent", async () => {
    const model = card([question(10), question(20)]);
    const pending = deferred<Response>();
    model.questionReply = () => pending.promise;
    const server = serve({ "p/7": model });
    const scroll = scrolling();
    const view = renderAt();
    await waitFor(() => expect(server.questions()).toHaveLength(1));
    await view.findByText("Decision 20?");
    await navigate(view, "comment-20");
    await landed(view, scroll, 20);
    const afterNavigation = [...scroll.events];

    await release(pending, json(model.questions));
    await waitFor(() => expect(view.client.isFetching()).toBe(0));
    expect(view.router.state.location.hash).toBe("comment-20");
    expect(scroll.events).toEqual(afterNavigation);

    model.questionReply = undefined;
    await navigate(view, ENTRY);
    await landed(view, scroll, 10);
    expect(server.questions()).toHaveLength(2);
    expect(scroll.reveals("comment-20")).toBe(1);
  });

  it("C8 a new same-card intent alone may replace history when it shares the older in-flight read", async () => {
    const model = card([question(10), question(20)]);
    const pending = deferred<Response>();
    model.questionReply = () => pending.promise;
    const server = serve({ "p/7": model });
    const scroll = scrolling();
    const view = renderAt();
    await waitFor(() => expect(server.questions()).toHaveLength(1));
    await view.findByText("Decision 20?");
    await navigate(view, "comment-20");
    await landed(view, scroll, 20);
    await navigate(view, ENTRY);
    expect(view.router.state.location.hash).toBe(ENTRY);

    const replacements: string[] = [];
    disposers.push(
      view.router.history.subscribe(
        ({
          action,
          location,
        }: {
          action: { type: string };
          location: { href: string };
        }) => {
          if (action.type === "REPLACE") replacements.push(location.href);
        },
      ),
    );
    // The API does not consume an AbortSignal. Reentry can share the existing
    // query promise, but its older continuation has lost the right to navigate.
    await release(pending, json(model.questions));
    await landed(view, scroll, 10);
    expect(server.questions()).toHaveLength(1);
    expect(replacements).toEqual(["/projects/p/issues/7#comment-10"]);
    expect(scroll.reveals("comment-20")).toBe(1);
  });

  it("C9 a delayed card A read cannot navigate or scroll card B after the real keyed unmount", async () => {
    const a = card(
      [question(10)],
      [comment(1, "A shared row"), ...questionItems([question(10)])],
    );
    const b = card(
      [question(20)],
      [comment(1, "B shared row"), ...questionItems([question(20)])],
    );
    const pending = deferred<Response>();
    a.questionReply = () => pending.promise;
    const server = serve({ "p/7": a, "q/8": b });
    const scroll = scrolling();
    // Warm B by visiting its actual page, so cold query skeletons cannot
    // substitute for the production key's unmount when returning to it.
    const view = renderAt("/projects/q/issues/8");
    await view.findByText("B shared row");
    await waitFor(() => expect(view.client.isFetching()).toBe(0));
    await navigate(view, ENTRY);
    await view.findByText("A shared row");
    await waitFor(() => expect(server.questions()).toHaveLength(1));
    const outgoing = view.container.querySelector("#comment-1");
    await navigate(view, ENTRY, 8, "q");
    await landed(view, scroll, 20);
    expect(outgoing?.isConnected).toBe(false);
    expect(view.container.querySelector("#comment-1")).not.toBe(outgoing);
    const settled = [...scroll.events];

    await release(pending, json(a.questions));
    await waitFor(() => expect(view.client.isFetching()).toBe(0));
    expect(view.router.state.location.pathname).toBe("/projects/q/issues/8");
    expect(view.router.state.location.hash).toBe("comment-20");
    expect(view.queryByText("A shared row")).toBeNull();
    expect(view.getByText("B shared row")).toBeTruthy();
    expect(scroll.events).toEqual(settled);
    expect(server.questions("q/8").length).toBeGreaterThan(0);
  });

  // Two-row responses retain the multi-page recovery and real comment DOM
  // without repeatedly rendering 150–200 comments per intent.
  it("C10 reports a deleted target only after head readiness and bounded exhaustion, then Retry reselects", async () => {
    const gone = question(125);
    const next = question(175);
    const model = recoveryCard([gone, next]);
    model.items = model.items.filter(
      (item) => item.type !== "comment" || item.id !== gone.comment_id,
    );
    const pendingHead = deferred<Response>();
    model.timelineReply = (url) =>
      !url.searchParams.has("last") && !url.searchParams.has("after")
        ? pendingHead.promise
        : json(timelinePage(model.items, url, model.pageSize));
    const server = serve({ "p/7": model });
    const scroll = scrolling();
    const view = renderAt();
    await waitFor(() =>
      expect(view.router.state.location.hash).toBe("comment-125"),
    );
    await waitFor(() => expect(server.timeline()).toHaveLength(2));
    expect(view.queryByText(UNAVAILABLE)).toBeNull();
    expect(scroll.reveals("comment-125")).toBe(0);

    await release(
      pendingHead,
      json(
        timelinePage(
          model.items,
          new URL("http://todou.example/"),
          model.pageSize,
        ),
      ),
    );
    await view.findByText(UNAVAILABLE, {}, { timeout: 3_000 });
    expect(
      server
        .timeline()
        .map(({ url }) => url.searchParams.get("after"))
        .filter(Boolean),
    ).toEqual(["cursor-2", "cursor-4"]);
    expect(view.queryByText(/Couldn't refresh the timeline/)).toBeNull();
    expect(scroll.reveals("comment-125")).toBe(0);
    expect(view.container.querySelectorAll("#comment-200")).toHaveLength(1);
    const before = server.questions().length;
    model.questions = questions([next]);
    fireEvent.click(retryFor(view, UNAVAILABLE));
    await landed(view, scroll, 175);
    expect(server.questions()).toHaveLength(before + 1);
    expect(scroll.reveals("comment-125")).toBe(0);
    expect(server.timeline()).toHaveLength(4);
  });

  it("C10 pagination failure stays a timeline error and its Retry resumes the selected question", async () => {
    const item = question(125);
    const model = recoveryCard([item]);
    let failPage = true;
    model.timelineReply = (url) =>
      failPage && url.searchParams.get("after") === "cursor-2"
        ? failure("middle page unavailable")
        : json(timelinePage(model.items, url, model.pageSize));
    const server = serve({ "p/7": model });
    const scroll = scrolling();
    const view = renderAt();

    await view.findByText(
      /Couldn't refresh the timeline \(middle page unavailable\)/,
      {},
      { timeout: 3_000 },
    );
    expect(view.queryByText(UNAVAILABLE)).toBeNull();
    expect(view.queryByText(LOCATE_FAILURE)).toBeNull();
    expect(view.router.state.location.hash).toBe("comment-125");
    expect(scroll.reveals("comment-125")).toBe(0);
    const questionReads = server.questions().length;
    failPage = false;
    fireEvent.click(retryFor(view, /Couldn't refresh the timeline/));
    await landed(view, scroll, 125);
    expect(view.queryByText(/Couldn't refresh the timeline/)).toBeNull();
    expect(server.questions()).toHaveLength(questionReads);
    expect(
      server
        .timeline()
        .map(({ url }) => url.searchParams.get("after"))
        .filter(Boolean),
    ).toEqual(["cursor-2", "cursor-2", "cursor-4"]);
    expect(view.container.querySelectorAll("#comment-200")).toHaveLength(1);
  });

  it("C10 no-progress pagination is bounded and reports a retryable locating failure", async () => {
    const item = question(125);
    const model = recoveryCard([item]);
    // A successful but anomalous page repeats the loaded head. It cannot
    // establish deletion, and repeating this cursor forever is not recovery.
    model.timelineReply = (url) =>
      json(
        timelinePage(
          model.items,
          url.searchParams.has("after")
            ? new URL("http://todou.example/")
            : url,
          model.pageSize,
        ),
      );
    const server = serve({ "p/7": model });
    const scroll = scrolling();
    const view = renderAt();

    await view.findByText(LOCATE_FAILURE, {}, { timeout: 3_000 });
    expect(view.queryByText(UNAVAILABLE)).toBeNull();
    expect(view.router.state.location.hash).toBe("comment-125");
    expect(scroll.reveals("comment-125")).toBe(0);
    expect(
      server
        .timeline()
        .map(({ url }) => url.searchParams.get("after"))
        .filter(Boolean),
    ).toEqual(["cursor-2"]);
    const reads = server.questions().length;
    model.timelineReply = undefined;
    fireEvent.click(retryFor(view, LOCATE_FAILURE));
    await landed(view, scroll, 125);
    expect(server.questions()).toHaveLength(reads + 1);
    expect(
      server
        .timeline()
        .map(({ url }) => url.searchParams.get("after"))
        .filter(Boolean),
    ).toEqual(["cursor-2", "cursor-2", "cursor-4"]);
    expect(view.container.querySelectorAll("#comment-200")).toHaveLength(1);
  });

  it("C11 a warm tail racing the question handoff cannot overwrite reveal and later bottom following resumes", async () => {
    const item = question(10);
    const model = card([item], [...questionItems([item]), comment(20)]);
    const pendingQuestions = deferred<Response>();
    const pendingTail = deferred<Response>();
    model.questionReply = () => pendingQuestions.promise;
    model.timelineReply = () => pendingTail.promise;
    const server = serve({ "p/7": model });
    const client = queryClient();
    const tailKey = ["timeline", "p", 7, "tail"];
    client.setQueryData(tailKey, {
      pages: [
        timelinePage(model.items, new URL("http://todou.example/?last=1")),
      ],
      pageParams: [{ dir: "init" }],
    });
    client.setQueryData(questionsQuery("p", 7).queryKey, model.questions);
    const scroll = scrolling();
    const view = renderAt(undefined, client);
    await view.findByText("comment body 20");
    await waitFor(() => expect(server.questions()).toHaveLength(1));
    expect(scroll.bottoms()).toBe(0);
    let refreshing!: Promise<void>;
    act(() => {
      refreshing = client.refetchQueries({ queryKey: tailKey, exact: true });
    });
    await waitFor(() => expect(server.timeline()).toHaveLength(1));
    model.items = [...model.items, comment(21)];
    await act(async () => {
      pendingQuestions.resolve(json(model.questions));
      pendingTail.resolve(
        json(
          timelinePage(model.items, new URL("http://todou.example/?last=1")),
        ),
      );
      await refreshing;
    });
    await landed(view, scroll, 10);
    await view.findByText("comment body 21");
    expect(scroll.bottoms()).toBe(0);
    expect(scroll.events.at(-1)).toBe("reveal:comment-10");

    // No native scroll event intervenes between reveal and this SSE-style
    // refetch. Ownership release must already have reconciled atBottom.
    model.timelineReply = undefined;
    model.items = [...model.items, comment(22)];
    await refetchTail(view);
    await view.findByText("comment body 22");
    expect(scroll.bottoms()).toBe(0);
    expect(scroll.position()).toBe(1_500);
    expect(scroll.reveals("comment-10")).toBe(1);

    scroll.userAt(9_200);
    model.items = [...model.items, comment(23)];
    await refetchTail(view);
    await view.findByText("comment body 23");
    await waitFor(() => expect(scroll.bottoms()).toBe(1));
    expect(view.router.state.location.hash).toBe("comment-10");
    expect(scroll.reveals("comment-10")).toBe(1);
  });

  it("C11 selected comment keeps scroll ownership while paging and a tail refetch completes", async () => {
    const items = [
      answered(question(10), 11),
      question(125),
      question(126, timestamp(125)),
      question(5, timestamp(180)),
    ];
    const model = recoveryCard(
      items,
      ordered([...questionItems(items), comment(20), comment(30)]),
    );
    const pendingMiddle = deferred<Response>();
    model.timelineReply = (url) =>
      url.searchParams.get("after") === "cursor-2"
        ? pendingMiddle.promise
        : json(timelinePage(model.items, url, model.pageSize));
    const server = serve({ "p/7": model });
    const scroll = scrolling();
    const view = renderAt();
    await waitFor(() =>
      expect(
        server
          .timeline()
          .some(({ url }) => url.searchParams.get("after") === "cursor-2"),
      ).toBe(true),
    );
    expect(view.router.state.location.hash).toBe("comment-125");
    expect(view.container.querySelector("#comment-125")).toBeNull();
    expect(scroll.reveals("comment-125")).toBe(0);
    model.items = [...model.items, comment(202)];
    await refetchTail(view);
    await view.findByText("comment body 202");
    expect(scroll.bottoms()).toBe(0);
    expect(view.queryByText(UNAVAILABLE)).toBeNull();
    expect(view.router.state.location.hash).toBe("comment-125");
    expect(view.container.querySelector("#comment-125")).toBeNull();
    expect(scroll.reveals("comment-125")).toBe(0);
    expect(
      server
        .timeline()
        .map(({ url }) => url.searchParams.get("after"))
        .filter(Boolean),
    ).toEqual(["cursor-2"]);
    await release(
      pendingMiddle,
      json(
        timelinePage(
          model.items,
          new URL("http://todou.example/?after=cursor-2"),
          model.pageSize,
        ),
      ),
    );
    await landed(view, scroll, 125);
    expect(scroll.events.at(-1)).toBe("reveal:comment-125");
    expect(scroll.bottoms()).toBe(0);
    expect(
      server
        .timeline()
        .map(({ url }) => url.searchParams.get("after"))
        .filter(Boolean),
    ).toEqual(["cursor-2", "cursor-4"]);
    const target = view.container.querySelector("#comment-125");
    view.rerender(view.ui);
    model.items = [...model.items, comment(203)];
    await refetchTail(view);
    await view.findByText("comment body 203");
    expect(view.container.querySelector("#comment-125")).toBe(target);
    expect(view.router.state.location.hash).toBe("comment-125");
    expect(scroll.reveals("comment-125")).toBe(1);
    expect(scroll.reveals("comment-10")).toBe(0);
    expect(scroll.reveals("comment-126")).toBe(0);
    expect(scroll.reveals("comment-5")).toBe(0);
    expect(server.questions()).toHaveLength(1);
    expect(scroll.bottoms()).toBe(0);
    expect(scroll.position()).toBe(1_500);
  });

  it("C12 replaces the semantic history entry so Back returns to source and Forward keeps the concrete comment", async () => {
    const model = card([question(10), question(20)]);
    const server = serve({ "p/7": model });
    const scroll = scrolling();
    const view = renderAt("/source");
    fireEvent.click(
      await view.findByRole("link", { name: "Questions for card 7" }),
    );
    await landed(view, scroll, 10);
    expect(view.router.history.length).toBe(2);
    const reads = server.questions().length;

    act(() => view.router.history.back());
    await view.findByRole("main", { name: "Source list" });
    expect(view.router.state.location.pathname).toBe("/source");
    model.questions = questions([answered(question(10), 30), question(20)]);
    act(() => view.router.history.forward());
    await landed(view, scroll, 10, 2);
    expect(view.router.state.location.pathname).toBe("/projects/p/issues/7");
    expect(server.questions()).toHaveLength(reads);
    expect(scroll.reveals("comment-20")).toBe(0);
  });

  it("C12 a real MovedError preserves the semantic hash and resolves questions at the destination", async () => {
    const old = card();
    old.issueReply = () => json({ moved_to: { slug: "q", number: 8 } }, 301);
    const destination = card([question(42)]);
    const server = serve({ "p/7": old, "q/8": destination });
    const scroll = scrolling();
    const view = renderAt();
    await landed(view, scroll, 42);
    expect(view.router.state.location.pathname).toBe("/projects/q/issues/8");
    expect(window.location.pathname).toBe("/projects/q/issues/8");
    expect(window.location.hash).toBe("#comment-42");
    expect(server.questions()).toHaveLength(0);
    expect(server.questions("q/8")).toHaveLength(1);
    expect(view.router.history.length).toBe(1);
  });

  it.each([
    ["comment-10", "comment-42"],
    ["event-9", "event-9"],
    ["unanswered-questions-extra", ""],
    ["unknown-anchor", ""],
  ])(
    "C12 moved %s retains the existing alias or unknown-hash behavior",
    async (from, to) => {
      const old = card();
      old.issueReply = () => json({ moved_to: { slug: "q", number: 8 } }, 301);
      const event: TimelineEvent = {
        type: "event",
        id: 9,
        actor: user,
        event_type: "closed",
        payload: { to: { name: "Done" } },
        created_at: timestamp(50),
        agent_context: null,
      };
      const destination = card([], [comment(42), event]);
      const server = serve(
        { "p/7": old, "q/8": destination },
        ({ url, method }) => {
          if (
            method === "GET" &&
            url.pathname === "/api/projects/p/comments/10"
          ) {
            return json(
              { moved_to: { slug: "q", number: 8, comment_id: 42 } },
              301,
            );
          }
          return undefined;
        },
      );
      const scroll = scrolling();
      const view = renderAt(`/projects/p/issues/7#${from}`);
      await view.findByText("comment body 42");
      await waitFor(() => {
        expect(view.router.state.location.pathname).toBe(
          "/projects/q/issues/8",
        );
        expect(view.router.state.location.hash).toBe(to);
      });
      if (to !== "") {
        await waitFor(() => {
          expect(scroll.reveals(to)).toBeGreaterThan(0);
          expect(
            view.container
              .querySelector(`#${to}`)
              ?.classList.contains("anchor-flash"),
          ).toBe(true);
        });
      }
      expect(window.location.hash).toBe(to === "" ? "" : `#${to}`);
      const aliases = server.calls.filter(
        ({ url }) => url.pathname === "/api/projects/p/comments/10",
      );
      if (from === "comment-10") expect(aliases.length).toBeGreaterThan(0);
      else expect(aliases).toHaveLength(0);
      expect(server.questions("q/8")).toHaveLength(0);
    },
  );

  it("C13 ordinary details still scroll latest, follow new tail items, and stop following when the reader scrolls up", async () => {
    const model = card([], [comment(1), comment(2)]);
    const server = serve({ "p/7": model });
    const scroll = scrolling();
    const view = renderAt("/projects/p/issues/7");
    await view.findByText("comment body 2");
    await waitFor(() => expect(scroll.bottoms()).toBe(1));
    scroll.userAt(9_200);
    model.items = [...model.items, comment(3)];
    await refetchTail(view);
    await waitFor(() => expect(scroll.bottoms()).toBe(2));
    scroll.userAt(0);
    model.items = [...model.items, theirs(4)];
    await refetchTail(view);
    await view.findByText("comment body 4");
    expect(scroll.bottoms()).toBe(2);
    expect(newMessagesShown(view)).toBe(true);
    expect(server.questions()).toHaveLength(0);
  });

  it("C13 following new tail items is measured from the conversation's end, not the sidebar below it", async () => {
    const model = card([], [comment(1), comment(2)]);
    serve({ "p/7": model });
    // Taller than a screen, as a phone's sidebar can be.
    const scroll = scrolling({ below: 2_000 });
    const view = renderAt("/projects/p/issues/7");
    await view.findByText("comment body 2");
    await waitFor(() => expect(scroll.bottoms()).toBe(1));
    // At the comment box, two screens above the document's end: followed.
    scroll.userAt(10_000 - 2_000 - 800);
    model.items = [...model.items, comment(3)];
    await refetchTail(view);
    await waitFor(() => expect(scroll.bottoms()).toBe(2));
    // A whole screen down into the sidebar: left there, and told instead.
    scroll.userAt(10_000 - 800);
    model.items = [...model.items, theirs(4)];
    await refetchTail(view);
    await view.findByText("comment body 4");
    expect(scroll.bottoms()).toBe(2);
    expect(scroll.position()).toBe(10_000 - 800);
    expect(newMessagesShown(view)).toBe(true);
  });

  it.each([
    "unanswered-questions-extra",
    "Unanswered-questions",
    "unanswered-question",
  ])(
    "C13 the ordinary route rejects the lookalike semantic hash %s",
    async (hash) => {
      const model = card([], [comment(1)]);
      const server = serve({ "p/7": model });
      const scroll = scrolling();
      const view = renderAt(`/projects/p/issues/7#${hash}`);
      await view.findByText("comment body 1");
      await waitFor(() => expect(view.client.isFetching()).toBe(0));
      expect(view.router.state.location.hash).toBe(hash);
      expect(server.questions()).toHaveLength(0);
      expect(scroll.bottoms()).toBe(1);
    },
  );

  it("C13 direct event anchors still expand pagination and their collapsed event group", async () => {
    // 33 fixed proof assertions and two HTTP assertions for each of five
    // reads. Vitest checks this count before the afterEach assertion. Wait
    // predicates throw instead of asserting so retries cannot change it.
    expect.assertions(43);
    const events: TimelineEvent[] = [1001, 1002, 2001, 2002].map((id) => ({
      type: "event",
      id,
      actor: user,
      event_type: "status_changed",
      payload: {
        from: { id: id % 2 ? 1 : 2, name: id % 2 ? "Todo" : "Doing" },
        to: { id: id % 2 ? 2 : 1, name: id % 2 ? "Doing" : "Todo" },
      },
      created_at: timestamp(id < 2000 ? 125 : 25),
      agent_context: null,
    }));
    // Keep 200 real comment records and the default 50-row HTTP windows.
    // Product HiddenBlocks replace their expensive comment DOM; the target
    // still lives beyond both initial windows and the first after page.
    // The earlier, untargeted group is a negative control for "always open".
    const model = card(
      [],
      ordered([
        ...pagedItems([]).map((item) => ({
          ...item,
          hidden_at: timestamp(300),
        })),
        ...events,
      ]),
    );
    const pending = new Map<
      string,
      { reply: Deferred<Response>; page: TimelinePage }
    >();
    model.timelineReply = (url) => {
      const page = timelinePage(model.items, url);
      const after = url.searchParams.get("after");
      if (after === null) return json(page);
      if (pending.has(after)) throw new Error(`Repeated C13 cursor: ${after}`);
      const reply = deferred<Response>();
      pending.set(after, { reply, page });
      return reply.promise;
    };
    const requested = (cursor: string) =>
      waitFor(() => {
        const request = pending.get(cursor);
        if (request === undefined) throw new Error(`Waiting for ${cursor}`);
        return request;
      });
    const server = serve({ "p/7": model });
    const scroll = scrolling();
    const view = renderAt("/projects/p/issues/7#event-1002");
    const pages = (side: "head" | "tail") =>
      view.client.getQueryData<{ pages: TimelinePage[] }>([
        "timeline",
        "p",
        7,
        side,
      ])?.pages ?? [];

    const first = await requested("cursor-50");
    const control = view.getByTestId("event-group");
    const controlToggle = within(control).getByTestId("event-group-toggle");
    expect(pages("head").map((page) => page.items.length)).toEqual([50]);
    expect(pages("tail").map((page) => page.items.length)).toEqual([50]);
    expect(pages("head")[0]?.next_cursor).toBe("cursor-50");
    expect([
      pages("tail")[0]?.items[0]?.id,
      pages("tail")[0]?.items.at(-1)?.id,
    ]).toEqual([151, 200]);
    expect(pages("tail")[0]?.total_count).toBe(204);
    expect(view.container.querySelector("#event-1002")).toBeNull();
    expect(scroll.reveals("event-1002")).toBe(0);
    expect(controlToggle.getAttribute("aria-expanded")).toBe("false");
    expect(control.querySelectorAll('[id^="event-"]')).toHaveLength(0);
    expect(view.container.querySelectorAll('[id^="comment-"]')).toHaveLength(0);

    await release(first.reply, json(first.page));
    const second = await requested("cursor-100");
    expect(pages("head").map((page) => page.items.length)).toEqual([50, 50]);
    expect(view.container.querySelector("#event-1002")).toBeNull();
    expect(scroll.reveals("event-1002")).toBe(0);
    expect(
      server
        .timeline()
        .map(({ url }) => url.searchParams.get("after"))
        .filter(Boolean),
    ).toEqual(["cursor-50", "cursor-100"]);

    await release(second.reply, json(second.page));
    // Opening the target group schedules one extra page before its rows
    // mount. Hold that response to prove landing does not need exhaustion.
    const last = await requested("cursor-150");
    await waitFor(
      () => {
        if (scroll.reveals("event-1002") === 0) {
          throw new Error("Waiting for the direct event anchor reveal");
        }
      },
      { timeout: 3_000 },
    );
    const target = view.container.querySelector("#event-1002");
    const group = target?.closest('[data-testid="event-group"]');
    expect(pages("head").map((page) => page.items.length)).toEqual([
      50, 50, 50,
    ]);
    expect(
      pages("head")[2]
        ?.items.filter((item) => item.type === "event")
        .map((item) => item.id),
    ).toEqual([1001, 1002]);
    expect(target?.classList.contains("anchor-flash")).toBe(true);
    expect(
      group
        ?.querySelector('[data-testid="event-group-toggle"]')
        ?.getAttribute("aria-expanded"),
    ).toBe("true");
    expect(
      Array.from(
        group?.querySelectorAll('[id^="event-"]') ?? [],
        (row) => row.id,
      ),
    ).toEqual(["event-1001", "event-1002"]);
    expect(scroll.reveals("event-1002")).toBe(1);
    expect(scroll.commits).toEqual([
      { element: target, current: target, connected: true },
    ]);
    expect(view.router.state.location.hash).toBe("event-1002");
    expect(controlToggle.getAttribute("aria-expanded")).toBe("false");
    expect(control.querySelectorAll('[id^="event-"]')).toHaveLength(0);

    await release(last.reply, json(last.page));
    await waitFor(() => {
      if (
        view.client.isFetching() !== 0 ||
        view.queryByText("75 hidden comments") === null
      ) {
        throw new Error("Waiting for the final page to render");
      }
    });
    expect(pages("head").map((page) => page.items.length)).toEqual([
      50, 50, 50, 50,
    ]);
    // The last head page overlaps 46 tail rows. These real rendered counts
    // prove seam deduplication without mounting any of the 200 comment bodies.
    expect(
      view
        .getAllByTestId("hidden-block")
        .map(
          (block) =>
            within(block).getByText(/^\d+ hidden comments$/).textContent,
        ),
    ).toEqual([
      "25 hidden comments",
      "100 hidden comments",
      "75 hidden comments",
    ]);
    expect(view.container.querySelectorAll("#event-1002")).toHaveLength(1);
    expect(view.container.querySelectorAll('[id^="comment-"]')).toHaveLength(0);
    expect(
      server
        .timeline()
        .map(({ url }) => url.searchParams.get("after"))
        .filter(Boolean),
    ).toEqual(["cursor-50", "cursor-100", "cursor-150"]);
    expect(server.timeline()).toHaveLength(5);
    expect(server.questions()).toHaveLength(0);
    expect(scroll.bottoms()).toBe(0);
    expect(scroll.reveals("event-1002")).toBe(1);
  });

  it("C13 direct concrete comment links retain their target without selecting another question", async () => {
    const model = card([question(10), question(20)]);
    serve({ "p/7": model });
    const scroll = scrolling();
    const view = renderAt("/projects/p/issues/7#comment-20");
    await landed(view, scroll, 20);
    await waitFor(() => expect(view.client.isFetching()).toBe(0));
    expect(view.router.state.location.hash).toBe("comment-20");
    expect(scroll.reveals("comment-10")).toBe(0);
    expect(scroll.bottoms()).toBe(0);
  });
});

describe("the card's own question badge", () => {
  /** Two questions in one comment, so a count of comments would read 2. */
  function twoQuestions(id: number): IssueQuestionsItem {
    const item = question(id);
    return {
      ...item,
      questions: [
        ...item.questions,
        {
          key: "q2",
          multiple: false,
          question: `Follow-up ${id}?`,
          options: [{ label: "Yes" }, { label: "No" }],
        },
      ],
    };
  }

  const openCard = () =>
    card([twoQuestions(10), answered(question(12), 13), question(14)]);

  const label = (model: Card) =>
    `${model.questions.open} unanswered question(s)`;

  const inTitle = (view: View, model: Card) =>
    within(view.getByTestId("issue-title-block")).queryByRole("link", {
      name: label(model),
    });

  // The mirror is `aria-hidden`: the heading's badge is the one assistive
  // tech reaches.
  const inMirror = (view: View, model: Card) =>
    within(view.getByTestId("floating-title-bar")).queryByRole("link", {
      name: label(model),
      hidden: true,
    });

  async function click(link: HTMLElement | null) {
    expect(link).not.toBeNull();
    await act(async () => {
      fireEvent.click(link as HTMLElement);
    });
  }

  /** Every address the router hands the browser from here on. */
  function writes(view: View) {
    const seen: Array<{ type: string; href: string }> = [];
    disposers.push(
      view.router.history.subscribe(
        ({
          action,
          location,
        }: {
          action: { type: string };
          location: { href: string };
        }) => {
          if (action.type === "PUSH" || action.type === "REPLACE")
            seen.push({ type: action.type, href: location.href });
        },
      ),
    );
    return seen;
  }

  /** The browser's history keeps a row for every address a page writes. */
  const asksInTheAddress = (seen: Array<{ href: string }>) =>
    seen.filter(({ href }) => href.includes(ENTRY));

  it("counts open questions, not comments, in the heading and its mirror", async () => {
    const model = openCard();
    expect(model.questions.open).toBe(3);
    serve({ "p/7": model });
    scrolling();
    const view = renderAt("/projects/p/issues/7");
    await view.findByText("Decision 14?");

    expect(
      view.getAllByRole("link", { name: label(model), hidden: true }),
    ).toHaveLength(2);
    expect(inTitle(view, model)?.getAttribute("href")).toMatch(
      /#unanswered-questions$/,
    );
    expect(inMirror(view, model)?.getAttribute("href")).toMatch(
      /#unanswered-questions$/,
    );
  });

  it("is not worn once every question is answered", async () => {
    const model = card([answered(question(10), 11)]);
    serve({ "p/7": model });
    scrolling();
    const view = renderAt("/projects/p/issues/7");
    await view.findByText("Decision 10?");

    expect(
      view.queryAllByRole("link", {
        name: /unanswered question/,
        hidden: true,
      }),
    ).toHaveLength(0);
  });

  it("is not worn in the trash, where no answer can be given", async () => {
    const model = openCard();
    model.issueReply = () =>
      json({
        ...issue(7, model),
        deleted_at: timestamp(200),
        deleted_by: user,
      } satisfies Issue);
    serve({ "p/7": model });
    scrolling();
    const view = renderAt("/projects/p/issues/7");
    await view.findByText(/In the trash/);
    await view.findByText("Decision 14?");

    expect(
      view.queryAllByRole("link", {
        name: /unanswered question/,
        hidden: true,
      }),
    ).toHaveLength(0);
  });

  it("steps through the open questions writing only the comments it lands on", async () => {
    const model = openCard();
    serve({ "p/7": model });
    const scroll = scrolling();
    const view = renderAt("/projects/p/issues/7");
    await view.findByText("Decision 14?");
    const entries = view.router.history.length;
    const seen = writes(view);

    // A press may write the address it starts from and the comment it lands
    // on, and nothing in between.
    async function press(id: number, count = 1) {
      const from = view.router.state.location.href;
      const start = seen.length;
      await click(inTitle(view, model));
      await landed(view, scroll, id, count);
      expect(
        seen
          .slice(start)
          .map(({ href }) => href)
          .filter(
            (href) =>
              href !== from && href !== `/projects/p/issues/7#comment-${id}`,
          ),
      ).toEqual([]);
    }

    await press(10);
    await waitFor(() =>
      expect(inTitle(view, model)?.getAttribute("href")).toMatch(
        /#unanswered-questions-after-10$/,
      ),
    );
    await press(14);
    // Twice in all: not again on the way from it to 14.
    await press(10, 2);
    expect(scroll.reveals("comment-12")).toBe(0);
    expect(scroll.reveals("comment-14")).toBe(1);
    expect(seen.filter(({ type }) => type === "PUSH")).toEqual([]);
    expect(view.router.history.length).toBe(entries);
  });

  it("keeps the rest of the entry's state", async () => {
    const model = openCard();
    serve({ "p/7": model });
    const scroll = scrolling();
    const view = renderAt("/projects/p/issues/7");
    await view.findByText("Decision 14?");
    // The card's way back (T-407) rides in the same entry.
    const back = {
      origin: {
        v: 1,
        userId: user.id,
        snapshotId: "s1",
        target: { kind: "list", slug: "p", search: { q: "guard" } },
        pages: [{ lane: "flat", extraPages: 2 }],
        scroll: [{ region: "window", x: 0, y: 900, candidates: [] }],
      },
    };
    await act(async () => {
      view.router.history.replace(view.router.state.location.href, {
        todouReturn: back,
      });
    });

    await click(inTitle(view, model));
    await landed(view, scroll, 10);
    await click(inTitle(view, model));
    await landed(view, scroll, 14);
    expect(view.router.state.location.state).toHaveProperty(
      "todouReturn",
      back,
    );
  });

  it("leaves a modified click to the browser", async () => {
    const model = openCard();
    serve({ "p/7": model });
    scrolling();
    const view = renderAt("/projects/p/issues/7");
    await view.findByText("Decision 14?");
    const before = view.router.state.location.href;
    const seen = writes(view);

    for (const modified of [
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { altKey: true },
    ]) {
      let unhandled = false;
      await act(async () => {
        unhandled = fireEvent.click(
          inTitle(view, model) as HTMLElement,
          modified,
        );
      });
      expect(unhandled, JSON.stringify(modified)).toBe(true);
    }
    expect(seen).toEqual([]);
    // The router's, not `window.location`, which happy-dom's own anchor moves.
    expect(view.router.state.location.href).toBe(before);
  });

  it("retries a failed read from the same start without an entry address", async () => {
    const model = openCard();
    const server = serve({ "p/7": model });
    const scroll = scrolling();
    const view = renderAt("/projects/p/issues/7#comment-12");
    await landed(view, scroll, 12);
    const seen = writes(view);
    model.questionReply = () => failure("questions unavailable");

    await click(inTitle(view, model));
    await view.findByText(LOCATE_FAILURE);
    const reads = server.questions().length;
    model.questionReply = undefined;
    fireEvent.click(retryFor(view, LOCATE_FAILURE));

    await landed(view, scroll, 14);
    expect(server.questions()).toHaveLength(reads + 1);
    expect(asksInTheAddress(seen)).toEqual([]);
  });

  it("retries a press whose question is gone without an entry address", async () => {
    // 16 is open after the missing 14, so a Retry going on from the address
    // would land there rather than on the earliest.
    const items = [
      question(10),
      answered(question(12), 13),
      question(14),
      question(16),
    ];
    const model = recoveryCard(items);
    model.items = model.items.filter(
      (item) => item.type !== "comment" || item.id !== 14,
    );
    serve({ "p/7": model });
    const scroll = scrolling();
    const view = renderAt("/projects/p/issues/7#comment-12");
    await landed(view, scroll, 12);
    const back = { origin: { target: { kind: "list", slug: "p" } } };
    await act(async () => {
      view.router.history.replace(view.router.state.location.href, {
        todouReturn: back,
      });
    });

    await click(inTitle(view, model));
    await view.findByText(UNAVAILABLE, {}, { timeout: 3_000 });
    const seen = writes(view);
    fireEvent.click(retryFor(view, UNAVAILABLE));

    // From the earliest again, as before.
    await landed(view, scroll, 10);
    expect(scroll.reveals("comment-16")).toBe(0);
    // The Retry asks without an address of its own: the missing comment's
    // stays until the landing writes the one it found.
    expect(
      seen
        .map(({ href }) => href)
        .filter(
          (href) =>
            href !== "/projects/p/issues/7#comment-14" &&
            href !== "/projects/p/issues/7#comment-10",
        ),
    ).toEqual([]);
    expect(seen.filter(({ type }) => type === "PUSH")).toEqual([]);
    expect(view.router.state.location.state).toHaveProperty(
      "todouReturn",
      back,
    );
  });

  it("in the title mirror lands without the mirror's scroll to the top", async () => {
    const model = openCard();
    serve({ "p/7": model });
    const scroll = scrolling();
    const view = renderAt("/projects/p/issues/7");
    await view.findByText("Decision 14?");
    // Arriving at an address without a hash scrolls to the top on its own.
    const before = scroll.events.length;

    await click(inMirror(view, model));
    await landed(view, scroll, 10);
    expect(scroll.events.slice(before)).not.toContain("scroll:0");
  });

  it("moves past a chosen but unsent answer without asking, and keeps it", async () => {
    const model = openCard();
    serve({ "p/7": model });
    const scroll = scrolling();
    const view = renderAt("/projects/p/issues/7");
    await view.findByText("Decision 14?");

    await click(inTitle(view, model));
    await landed(view, scroll, 10);
    const row = view.container.querySelector("#comment-10");
    const first = within(row as HTMLElement);
    fireEvent.click(first.getByRole("button", { name: "Proceed" }));
    expect(
      first
        .getByRole("button", { name: "Proceed" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    await click(inTitle(view, model));
    await landed(view, scroll, 14);
    expect(
      view.queryByRole("dialog", { name: "Leave with unsaved changes?" }),
    ).toBeNull();
    // The same row, not a remount that happens to be unanswered as well.
    expect(view.container.querySelector("#comment-10")).toBe(row);
    expect(
      first
        .getByRole("button", { name: "Proceed" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("keeps the start while a landing is still reading, so a second press does not lose it", async () => {
    const model = openCard();
    const pending = deferred<Response>();
    model.questionReply = () => pending.promise;
    const server = serve({ "p/7": model });
    const scroll = scrolling();
    const view = renderAt("/projects/p/issues/7#unanswered-questions-after-10");
    await waitFor(() => expect(server.questions()).toHaveLength(1));
    await view.findByText("Decision 14?");

    expect(inTitle(view, model)?.getAttribute("href")).toMatch(
      /#unanswered-questions-after-10$/,
    );
    await release(pending, json(model.questions));
    await landed(view, scroll, 14);
  });

  it("keeps a Retry's start when pressed while it reads", async () => {
    const items = [
      question(10),
      answered(question(12), 13),
      question(14),
      question(16),
    ];
    const model = recoveryCard(items);
    model.items = model.items.filter(
      (item) => item.type !== "comment" || item.id !== 14,
    );
    serve({ "p/7": model });
    const scroll = scrolling();
    const view = renderAt("/projects/p/issues/7#comment-12");
    await landed(view, scroll, 12);

    await click(inTitle(view, model));
    await view.findByText(UNAVAILABLE, {}, { timeout: 3_000 });
    const pending = deferred<Response>();
    model.questionReply = () => pending.promise;
    fireEvent.click(retryFor(view, UNAVAILABLE));
    // The address still names 14; the request being read starts earliest.
    const seen = writes(view);
    await click(inTitle(view, model));
    expect(seen).toEqual([]);
    await release(pending, json(model.questions));

    await landed(view, scroll, 10);
    expect(scroll.reveals("comment-16")).toBe(0);
  });

  it("rereads a failed read when pressed again, as its Retry does", async () => {
    const model = openCard();
    const server = serve({ "p/7": model });
    const scroll = scrolling();
    const view = renderAt("/projects/p/issues/7#comment-12");
    await landed(view, scroll, 12);
    const entries = view.router.history.length;
    const seen = writes(view);
    model.questionReply = () => failure("questions unavailable");

    await click(inTitle(view, model));
    await view.findByText(LOCATE_FAILURE);
    const reads = server.questions().length;
    const failed = seen.length;
    const pending = deferred<Response>();
    model.questionReply = () => pending.promise;

    await click(inTitle(view, model));
    await waitFor(() => expect(server.questions()).toHaveLength(reads + 1));
    // The read under way already answers a press made while it lasts.
    await click(inTitle(view, model));
    expect(server.questions()).toHaveLength(reads + 1);
    expect(view.queryByText(LOCATE_FAILURE)).not.toBeNull();
    expect((retryFor(view, LOCATE_FAILURE) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await release(pending, json(model.questions));

    await landed(view, scroll, 14);
    expect(server.questions()).toHaveLength(reads + 1);
    expect(asksInTheAddress(seen)).toEqual([]);
    // Past the failure, nothing but the comment it lands on.
    expect(
      seen
        .slice(failed)
        .map(({ href }) => href)
        .filter((href) => href !== "/projects/p/issues/7#comment-14"),
    ).toEqual([]);
    expect(seen.filter(({ type }) => type === "PUSH")).toEqual([]);
    expect(view.router.history.length).toBe(entries);
  });

  it("rereads a failed entry from elsewhere when pressed, writing only the comment it lands on", async () => {
    const model = openCard();
    model.questionReply = () => failure("questions unavailable");
    const server = serve({ "p/7": model });
    const scroll = scrolling();
    const view = renderAt(`/projects/p/issues/7#${ENTRY}-after-10`);
    await view.findByText(LOCATE_FAILURE);
    await view.findByText("Decision 14?");
    const seen = writes(view);
    const reads = server.questions().length;
    model.questionReply = undefined;

    await click(inTitle(view, model));
    await landed(view, scroll, 14);
    expect(server.questions()).toHaveLength(reads + 1);
    expect(
      seen
        .map(({ href }) => href)
        .filter((href) => href !== "/projects/p/issues/7#comment-14"),
    ).toEqual([]);
    expect(seen.filter(({ type }) => type === "PUSH")).toEqual([]);
  });

  it("starts from the earliest when the address names a comment that asks nothing", () => {
    const open = questions([
      question(10),
      answered(question(12), 13),
      question(14),
    ]);
    expect(selectNextQuestionLanding(open, 11)).toBe(10);
  });

  it("stays on the comment it starts from once nothing is open", () => {
    const settled = questions([
      answered(question(10), 11),
      answered(question(12), 13),
      answered(question(14), 15),
    ]);
    expect(selectNextQuestionLanding(settled, 12)).toBe(12);
  });

  it("comes back round to the only open question", () => {
    const one = questions([
      answered(question(10), 11),
      question(12),
      answered(question(14), 15),
    ]);
    expect(selectNextQuestionLanding(one, 12)).toBe(12);
  });
});

/**
 * A jump on a card that has already landed glides there, and what
 * the glide carries the page past is not read: a phone's reader in the
 * sidebar below the comment box, New messages pointing up at what arrived,
 * presses the badge for a question above.
 */
describe("gliding on a card that has landed", () => {
  // Page coordinates of a laid-out card: the conversation ends at 8600, a
  // sidebar 1400 tall below it.
  const TOPS: Record<string, number> = {
    "comment-10": 1_000,
    "comment-14": 7_000,
    "comment-30": 7_300,
    "comment-31": 8_400,
  };
  const BELOW = 1_400;
  const ROW = 100;

  /** Where a reveal centres `el` in what the overlays leave. */
  const centred = (el: Element, tops = TOPS) => {
    const usable = usableViewport();
    return (tops[el.id] ?? 0) + ROW / 2 - (usable.top + usable.height / 2);
  };

  /**
   * The rows in `tops` measured where the page is scrolled to, each `ROW`
   * tall unless `heights` says otherwise.
   */
  function layOut(
    scroll: Scrolling,
    tops = TOPS,
    heights: Record<string, number> = {},
  ) {
    const spy = vi.mocked(Element.prototype.getBoundingClientRect);
    const rest = spy.getMockImplementation();
    spy.mockImplementation(function (this: Element) {
      const top = tops[this.id];
      if (top === undefined) return rest?.call(this) ?? new DOMRect();
      const y = top - scroll.position();
      const height = heights[this.id] ?? ROW;
      return { top: y, bottom: y + height, height } as DOMRect;
    });
  }

  /**
   * From here on, frames only as the test runs them, and the clock a glide
   * reads: each frame's callback, the placement made once it is drawn, and
   * the scroll that made, unless `quiet`. Not before the card is open, which
   * runs on real timers.
   */
  function frameByFrame() {
    let clock = performance.now();
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.useFakeTimers({
      toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
    });
    return async (ms = 16, { quiet = false } = {}) => {
      clock += ms;
      await act(async () => {
        vi.advanceTimersByTime(16);
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (!quiet) fireEvent.scroll(window);
      });
    };
  }

  const shownAs = (view: View) =>
    newMessagesShown(view)
      ? view
          .getByRole("button", { name: /^(New messages|\d+ new messages?)$/ })
          .getAttribute("aria-label")
      : null;

  const flashed = (view: View, id: number) =>
    view.container
      .querySelector(`#comment-${id}`)
      ?.classList.contains("anchor-flash") === true;

  async function pressBadge(view: View) {
    const badge = within(view.getByTestId("issue-title-block")).getByRole(
      "link",
      { name: /unanswered question/ },
    );
    await act(async () => {
      fireEvent.click(badge);
    });
  }

  /** Two from someone else, below the reader's screen. */
  async function arrive(view: View, model: Card) {
    model.items.push(theirs(30), theirs(31));
    await refetchTail(view);
    await view.findByText("comment body 31");
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lands on the comment a link names at once, then glides to the badge's next question, reading only where it stops", async () => {
    const model = card([question(10), question(14)]);
    serve({ "p/7": model });
    const scroll = scrolling({ below: BELOW, revealedAt: centred });
    layOut(scroll);
    const view = renderAt("/projects/p/issues/7#comment-10");
    await landed(view, scroll, 10);
    // Arriving on the card: straight there, nothing on the way.
    expect(scroll.events).toEqual(["reveal:comment-10"]);
    scroll.userAt(10_000 - 800);
    await arrive(view, model);
    expect(shownAs(view)).toBe("2 new messages");

    const frame = frameByFrame();
    await pressBadge(view);
    await waitFor(() => expect(flashed(view, 14)).toBe(true));
    expect(scroll.reveals("comment-14")).toBe(0);
    const glided: number[] = [];
    for (let i = 0; i < 8; i++) {
      await frame();
      glided.push(scroll.position());
    }
    // The later arrival on screen on the way, and not read.
    const { top, height } = usableViewport();
    const onScreen = (y: number) =>
      TOPS["comment-31"] - y >= top && TOPS["comment-31"] - y < top + height;
    expect(glided.some(onScreen)).toBe(true);
    expect(scroll.reveals("comment-14")).toBe(0);
    expect(shownAs(view)).toBe("2 new messages");
    // Late past its end: the last placement, and no scroll after it.
    await frame(1_000, { quiet: true });
    await landed(view, scroll, 14);
    expect(scroll.position()).toBe(
      centred(view.container.querySelector("#comment-14") as Element),
    );
    expect(isGliding()).toBe(false);
    // Read where it stopped: the arrival just below the question.
    expect(shownAs(view)).toBe("1 new message");
  });

  it("keeps New messages up through a glide that passes the end", async () => {
    const model = card([question(10), question(14)]);
    serve({ "p/7": model });
    const scroll = scrolling({ below: BELOW, revealedAt: centred });
    layOut(scroll);
    const view = renderAt("/projects/p/issues/7");
    await view.findByText("Decision 14?");
    await waitFor(() => expect(scroll.bottoms()).toBe(1));
    scroll.userAt(10_000 - 800);
    await arrive(view, model);
    expect(newMessagesShown(view)).toBe(true);

    const frame = frameByFrame();
    await pressBadge(view);
    await waitFor(() => expect(flashed(view, 10)).toBe(true));
    const glided: number[] = [];
    for (let i = 0; i < 12; i++) {
      await frame();
      glided.push(scroll.position());
    }
    // Frames on the way, through the end and above it.
    expect(scroll.reveals("comment-10")).toBe(0);
    expect(new Set(glided).size).toBeGreaterThan(5);
    expect(Math.min(...glided)).toBeLessThan(8_600 - 800 - 40);
    expect(newMessagesShown(view)).toBe(true);
    await frame(1_000, { quiet: true });
    await landed(view, scroll, 10);
    expect(newMessagesShown(view)).toBe(true);
  });

  // The end, where New messages goes, reached by a glide whose last steps
  // move the page less than a pixel: no scroll comes after it.
  it("lets New messages go once a glide stops at the end, with no scroll after it", async () => {
    // The first arrival long, its start out of sight above the end.
    const tops = { "comment-30": 6_800, "comment-31": 8_400 };
    const model = card([question(10)]);
    serve({ "p/7": model });
    const scroll = scrolling({
      below: BELOW,
      revealedAt: (el) => centred(el, tops),
    });
    layOut(scroll, tops, { "comment-30": 1_500 });
    const view = renderAt("/projects/p/issues/7");
    await view.findByText("Decision 10?");
    await waitFor(() => expect(scroll.bottoms()).toBe(1));
    scroll.userAt(2_000);
    await arrive(view, model);
    expect(shownAs(view)).toBe("2 new messages");

    const frame = frameByFrame();
    await navigate(view, "comment-31");
    await waitFor(() => expect(flashed(view, 31)).toBe(true));
    for (let i = 0; i < 8; i++) await frame();
    expect(newMessagesShown(view)).toBe(true);
    await frame(1_000, { quiet: true });
    await landed(view, scroll, 31);
    expect(newMessagesShown(view)).toBe(false);
  });

  it("lands on the end at once when a question landing finds none on arriving, and glides there after", async () => {
    const model = card([], [comment(1), comment(2)]);
    serve({ "p/7": model });
    const scroll = scrolling();
    const view = renderAt();
    await waitFor(() => expect(scroll.bottoms()).toBe(1));
    await waitFor(() => expect(view.router.state.location.hash).toBe(""));
    // Arriving: straight to the end, nothing on the way.
    expect(scroll.events).toEqual(["bottom"]);
    scroll.userAt(0);

    const frame = frameByFrame();
    await navigate(view, ENTRY);
    await waitFor(() => expect(view.router.state.location.hash).toBe(""));
    for (let i = 0; i < 4; i++) await frame();
    expect(scroll.bottoms()).toBe(1);
    expect(scroll.events.slice(1).some((e) => e.startsWith("scroll:"))).toBe(
      true,
    );
    await frame(1_000);
    expect(scroll.bottoms()).toBe(2);
  });

  it("glides to a comment a link on the card names", async () => {
    const model = card([question(10), question(14)]);
    serve({ "p/7": model });
    const scroll = scrolling({ below: BELOW, revealedAt: centred });
    layOut(scroll);
    const view = renderAt("/projects/p/issues/7");
    await view.findByText("Decision 14?");
    await waitFor(() => expect(scroll.bottoms()).toBe(1));

    const frame = frameByFrame();
    await navigate(view, "comment-10");
    await waitFor(() => expect(flashed(view, 10)).toBe(true));
    expect(scroll.reveals("comment-10")).toBe(0);
    await frame();
    await frame();
    expect(scroll.reveals("comment-10")).toBe(0);
    await frame(1_000);
    await landed(view, scroll, 10);
    expect(scroll.position()).toBe(
      centred(view.container.querySelector("#comment-10") as Element),
    );
  });
});
