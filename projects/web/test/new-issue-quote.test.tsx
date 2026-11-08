import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import type { Issue, Label, Me, Member, Project, Status } from "@todou/shared";
import { describe, expect, it, vi } from "vitest";
import { issueQuery } from "../src/api/issues.ts";
import {
  labelsQuery,
  membersQuery,
  meQuery,
  projectQuery,
  statusesQuery,
} from "../src/api/queries.ts";
import { questionsQuery } from "../src/api/questions.ts";
import {
  searchCommentRefQuery as commentRefQuery,
  type ResolvedCommentRef,
} from "../src/api/search-refs.ts";
import { NewIssuePage } from "../src/pages/new-issue.tsx";
import { cmGetValue } from "./cm.ts";
import { testQueryClient } from "./render.tsx";

const SLUG = "todou";

const author = {
  id: 2,
  login: "alice",
  display_name: "Alice",
  kind: "human" as const,
  avatar_url: null,
  owner: null,
};

const STATUSES: Status[] = [
  {
    id: 1,
    name: "Todo",
    category: "open",
    color: "#6b7280",
    position: 1,
    is_default: true,
  },
];
const LABELS: Label[] = [];
const MEMBERS: Member[] = [
  { user: author, role: "admin", created_at: "2026-08-01T00:00:00.000Z" },
];
const ME: Me = {
  ...author,
  email: null,
  is_instance_admin: false,
  created_at: "2026-08-01T00:00:00.000Z",
};

const ISSUE: Issue = {
  id: 11,
  number: 370,
  title: "The card",
  body: "the issue body\n\nwith two paragraphs",
  status: STATUSES[0] as Status,
  author,
  assignees: [],
  labels: [],
  created_at: "2026-09-08T09:00:00Z",
  updated_at: "2026-09-08T09:00:00Z",
  body_edited_at: null,
  open_questions: 0,
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

const COMMENT: ResolvedCommentRef = {
  type: "comment",
  id: 4242,
  author,
  body: "the comment body",
  component: null,
  created_at: "2026-09-08T10:00:00Z",
  edited_at: null,
  resolved_at: null,
  hidden_at: null,
  agent_context: null,
  at: { slug: SLUG, number: 370, commentId: 4242 },
};

/** A comment asking one question, as its card shows it. */
const ASKING: ResolvedCommentRef = {
  ...COMMENT,
  body: "One question.",
  component: {
    type: "questions",
    questions: [
      {
        key: "storage",
        header: "Storage",
        question: "Where should X live?",
        multiple: false,
        options: [
          { label: "Reuse the jobs table", description: "Fewer tables." },
          { label: "A new table" },
        ],
      },
    ],
  },
};

/** `/questions` for a card holding `comment`, which was answered. */
function answeredQuestions(comment: ResolvedCommentRef) {
  if (comment.component?.type !== "questions") throw new Error("no questions");
  return {
    items: [
      {
        comment_id: comment.at.commentId,
        author,
        created_at: comment.created_at,
        questions: comment.component.questions,
        answer: {
          event_id: 9,
          actor: author,
          created_at: "2026-09-08T11:00:00Z",
          answers: [
            {
              key: "storage",
              selected: [{ index: 1, label: "A new table" }],
              other: null,
              declined: false,
            },
          ],
        },
      },
    ],
    open: 0,
  };
}

/** The prefill quoting ASKING, from `permalink`. */
function askingPrefill(permalink: string): string {
  return [
    "> One question.",
    ">",
    "> **Storage**",
    ">",
    "> Where should X live?",
    ">",
    "> - Reuse the jobs table — Fewer tables.",
    "> - A new table",
    ">",
    "> **Answer:** A new table",
    "",
    `_Originally posted by @alice in ${permalink}_`,
  ].join("\n");
}

/** `seed` decides what the quoted content resolves to; leave it out to miss. */
function renderAt(
  search: string,
  seed: (client: ReturnType<typeof testQueryClient>) => void = () => {},
) {
  const project: Project = {
    id: 1,
    slug: SLUG,
    name: "todou",
    description: "",
    created_at: "2026-08-01T00:00:00.000Z",
    viewer_role: "admin",
  };
  const client = testQueryClient();
  client.setQueryData(projectQuery(SLUG).queryKey, project);
  client.setQueryData(statusesQuery(SLUG).queryKey, STATUSES);
  client.setQueryData(labelsQuery(SLUG).queryKey, LABELS);
  client.setQueryData(membersQuery(SLUG).queryKey, MEMBERS);
  client.setQueryData(meQuery.queryKey, ME);
  seed(client);

  const rootRoute = createRootRoute();
  const authedRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "authed",
  });
  const projectRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/projects/$slug",
  });
  const newIssueRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: "issues/new",
    component: NewIssuePage,
    validateSearch: (raw: Record<string, unknown>) => raw,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([projectRoute.addChildren([newIssueRoute])]),
    ]),
    history: createMemoryHistory({
      initialEntries: [`/projects/${SLUG}/issues/new${search}`],
    }),
  });
  return render(
    <QueryClientProvider client={client}>
      {/* biome-ignore lint/suspicious/noExplicitAny: shim route tree */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
}

const origin = () => window.location.origin;

describe("a new issue opened to quote something", () => {
  it("prefills the quoted comment and where it came from", async () => {
    const view = renderAt(
      `?quote_project=${SLUG}&quote_issue=370&quote_comment=4242`,
      (client) =>
        client.setQueryData(commentRefQuery(SLUG, 370, 4242).queryKey, COMMENT),
    );
    await waitFor(() =>
      expect(cmGetValue(view.container)).toBe(
        [
          "> the comment body",
          "",
          `_Originally posted by @alice in ${origin()}/projects/${SLUG}/issues/370#comment-4242_`,
        ].join("\n"),
      ),
    );
  });

  it("quotes a question comment with its questions and answer", async () => {
    const view = renderAt(
      `?quote_project=${SLUG}&quote_issue=370&quote_comment=4242`,
      (client) => {
        client.setQueryData(commentRefQuery(SLUG, 370, 4242).queryKey, ASKING);
        // In the cache before the page asks: its refetch on mount fails here,
        // which keeps the data and settles nothing else.
        client.setQueryData(
          questionsQuery(SLUG, 370).queryKey,
          answeredQuestions(ASKING),
        );
      },
    );
    await waitFor(() =>
      expect(cmGetValue(view.container)).toBe(
        askingPrefill(`${origin()}/projects/${SLUG}/issues/370#comment-4242`),
      ),
    );
  });

  it("reads the answer where a question comment has moved to", async () => {
    // The link still names the comment's old address; the comment, and so
    // its card's answers, live at the new one.
    const moved: ResolvedCommentRef = {
      ...ASKING,
      at: { slug: "elsewhere", number: 12, commentId: 99 },
    };
    const view = renderAt(
      `?quote_project=${SLUG}&quote_issue=370&quote_comment=4242`,
      (client) => {
        client.setQueryData(commentRefQuery(SLUG, 370, 4242).queryKey, moved);
        client.setQueryData(
          questionsQuery("elsewhere", 12).queryKey,
          answeredQuestions(moved),
        );
      },
    );
    await waitFor(() =>
      expect(cmGetValue(view.container)).toBe(
        askingPrefill(`${origin()}/projects/${SLUG}/issues/370#comment-4242`),
      ),
    );
  });

  it("waits for the answers rather than quote ones the cache held from before", async () => {
    // The cache still says unanswered; the card was answered since.
    const unanswered = answeredQuestions(ASKING);
    const before = {
      ...unanswered,
      items: unanswered.items.map((item) => ({ ...item, answer: null })),
      open: 1,
    };
    vi.stubGlobal("fetch", async (input: unknown) => {
      const url = String(input);
      if (url.includes(`/projects/${SLUG}/issues/370/questions`)) {
        return Response.json(answeredQuestions(ASKING));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    try {
      const view = renderAt(
        `?quote_project=${SLUG}&quote_issue=370&quote_comment=4242`,
        (client) => {
          client.setQueryData(
            commentRefQuery(SLUG, 370, 4242).queryKey,
            ASKING,
          );
          client.setQueryData(questionsQuery(SLUG, 370).queryKey, before);
        },
      );
      await waitFor(() => expect(view.getByLabelText("Title")).toBeTruthy());
      expect(cmGetValue(view.container)).toBe(
        askingPrefill(`${origin()}/projects/${SLUG}/issues/370#comment-4242`),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    [
      "the answers refetch",
      (client: ReturnType<typeof testQueryClient>) => {
        // What a live event about the card's answers does.
        void client.refetchQueries({ queryKey: ["questions", SLUG, 370] });
      },
    ],
    [
      "the quoted comment turns out to have moved",
      (client: ReturnType<typeof testQueryClient>) => {
        const moved: ResolvedCommentRef = {
          ...ASKING,
          at: { slug: "elsewhere", number: 12, commentId: 4242 },
        };
        client.setQueryData(commentRefQuery(SLUG, 370, 4242).queryKey, moved);
      },
    ],
  ])(
    "keeps the form, and what was typed in it, while %s",
    async (_name, disturb) => {
      let client: ReturnType<typeof testQueryClient> | undefined;
      let held = false;
      let release: (() => void) | undefined;
      vi.stubGlobal("fetch", async (input: unknown) => {
        const url = String(input);
        if (url.includes("/questions")) {
          if (held) await new Promise<void>((resolve) => (release = resolve));
          return Response.json(answeredQuestions(ASKING));
        }
        throw new Error(`unexpected fetch: ${url}`);
      });
      try {
        const view = renderAt(
          `?quote_project=${SLUG}&quote_issue=370&quote_comment=4242`,
          (seeded) => {
            client = seeded;
            // The app's own client keeps a query fresh for 5s, so a card page
            // that just loaded the answers leaves them fresh for this page.
            seeded.setQueryDefaults(["questions"], { staleTime: 5_000 });
            seeded.setQueryData(
              commentRefQuery(SLUG, 370, 4242).queryKey,
              ASKING,
            );
            seeded.setQueryData(
              questionsQuery(SLUG, 370).queryKey,
              answeredQuestions(ASKING),
            );
          },
        );
        const title = await waitFor(() => view.getByLabelText("Title"));
        fireEvent.change(title, { target: { value: "Draft title" } });

        held = true;
        act(() => {
          if (client) disturb(client);
        });
        await waitFor(() => expect(release).toBeDefined());
        expect(view.getByLabelText("Title")).toHaveProperty(
          "value",
          "Draft title",
        );
        release?.();
        await waitFor(() => expect(client?.isFetching()).toBe(0));
        expect(view.getByLabelText("Title")).toHaveProperty(
          "value",
          "Draft title",
        );
      } finally {
        release?.();
        vi.unstubAllGlobals();
      }
    },
  );

  it("quotes the issue body when no comment is named", async () => {
    const view = renderAt(`?quote_project=${SLUG}&quote_issue=370`, (client) =>
      client.setQueryData(issueQuery(SLUG, 370).queryKey, ISSUE),
    );
    await waitFor(() =>
      expect(cmGetValue(view.container)).toBe(
        [
          "> the issue body",
          ">",
          "> with two paragraphs",
          "",
          `_Originally posted by @alice in ${origin()}/projects/${SLUG}/issues/370_`,
        ].join("\n"),
      ),
    );
  });

  it("prefills only the attribution when the quoted entry has no body", async () => {
    const view = renderAt(`?quote_project=${SLUG}&quote_issue=370`, (client) =>
      client.setQueryData(issueQuery(SLUG, 370).queryKey, {
        ...ISSUE,
        body: "   \n",
      }),
    );
    await waitFor(() =>
      expect(cmGetValue(view.container)).toBe(
        `_Originally posted by @alice in ${origin()}/projects/${SLUG}/issues/370_`,
      ),
    );
    // Reading it succeeded — there is simply nothing to quote.
    expect(view.queryByText(/could not be read/)).toBeNull();
  });

  it("still renders the form when the quote cannot be read, and says why", async () => {
    const view = renderAt(
      `?quote_project=${SLUG}&quote_issue=370&quote_comment=4242`,
      (client) =>
        client.setQueryData(commentRefQuery(SLUG, 370, 4242).queryKey, null),
    );
    await waitFor(() => expect(view.getByLabelText("Title")).toBeTruthy());
    expect(cmGetValue(view.container)).toBe("");
    expect(view.getByText(/could not be read/, { exact: false })).toBeTruthy();
  });

  it("leaves the editor empty and unexplained without quote params", async () => {
    const view = renderAt("");
    await waitFor(() => expect(view.getByLabelText("Title")).toBeTruthy());
    expect(cmGetValue(view.container)).toBe("");
    expect(view.queryByText(/could not be read/)).toBeNull();
  });
});
