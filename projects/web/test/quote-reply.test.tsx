import { QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CommentItem } from "../src/components/timeline/comment-item.tsx";
import { Composer } from "../src/components/timeline/composer.tsx";
import {
  QuoteReplyProvider,
  useQuoteReply,
} from "../src/components/timeline/quote-reply.tsx";
import { cmGetValue, cmSetValue } from "./cm.ts";
import { renderWithProviders, testQueryClient } from "./render.tsx";

type QuoteApi = { quote: (markdown: string) => void; available: boolean };

/** Hands the channel to the test, the way an entry's menu reaches it. */
function Handle({ onRender }: { onRender: (api: QuoteApi) => void }) {
  const { quote, available } = useQuoteReply();
  onRender({ quote, available });
  return null;
}

function mount(withComposer: boolean) {
  let api: QuoteApi = { quote: () => {}, available: false };
  const view = render(
    <QueryClientProvider client={testQueryClient()}>
      <QuoteReplyProvider>
        <Handle
          onRender={(next) => {
            api = next;
          }}
        />
        {withComposer && (
          <Composer
            slug="p"
            issueNumber={1}
            onSend={() => {}}
            onSendWithCommands={async () => undefined}
            failed={[]}
            onRetry={() => {}}
          />
        )}
      </QuoteReplyProvider>
    </QueryClientProvider>,
  );
  return { view, api: () => api };
}

describe("Quote reply channel", () => {
  it("writes the quoted markdown into the comment box", async () => {
    const { view, api } = mount(true);
    await waitFor(() => expect(api().available).toBe(true));

    api().quote("the finding\n\nand the number");
    await waitFor(() =>
      expect(cmGetValue(view.container)).toBe(
        "> the finding\n>\n> and the number\n\n",
      ),
    );
  });

  it("keeps a blank line between what was already typed and the quote", async () => {
    const { view, api } = mount(true);
    await waitFor(() => expect(api().available).toBe(true));

    // Typed text ends without a newline, which is the case that needs both:
    // run straight on, and the quote would be a lazy continuation of it.
    cmSetValue(view.container, "my own words");
    api().quote("first");
    await waitFor(() =>
      expect(cmGetValue(view.container)).toBe("my own words\n\n> first\n\n"),
    );
  });

  it("adds no second blank line to a box that already ends in one", async () => {
    const { view, api } = mount(true);
    await waitFor(() => expect(api().available).toBe(true));

    api().quote("first");
    await waitFor(() => expect(cmGetValue(view.container)).toBe("> first\n\n"));
    api().quote("second");
    await waitFor(() =>
      expect(cmGetValue(view.container)).toBe("> first\n\n> second\n\n"),
    );
  });

  it("reports no channel when the card has no comment box", async () => {
    const { api } = mount(false);
    await waitFor(() => expect(api().available).toBe(false));
    // Nothing to write into, and asking anyway is not an error.
    expect(() => api().quote("anything")).not.toThrow();
  });

  it("leaves the caret in the comment box after Quote reply from an entry's menu", async () => {
    const view = renderWithProviders(
      <QuoteReplyProvider>
        <CommentItem
          slug="p"
          issueNumber={7}
          comment={{
            type: "comment",
            id: 1234,
            author: {
              id: 2,
              login: "alice",
              display_name: "Alice",
              kind: "human",
              avatar_url: null,
              owner: null,
            },
            body: "the finding",
            component: null,
            created_at: "2026-08-11T00:00:00Z",
            edited_at: null,
            resolved_at: null,
            hidden_at: null,
            agent_context: null,
          }}
          viewer={null}
        />
        <Composer
          slug="p"
          issueNumber={1}
          onSend={() => {}}
          onSendWithCommands={async () => undefined}
          failed={[]}
          onRetry={() => {}}
        />
      </QuoteReplyProvider>,
    );
    const trigger = await waitFor(() =>
      within(view.container).getByRole("button", { name: "comment actions" }),
    );
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    await waitFor(() => expect(screen.getByRole("menu")).toBeTruthy());
    const editor = view.container.querySelector(
      '[aria-label="Write a comment"]',
    );
    expect(editor).not.toBeNull();

    fireEvent.click(
      within(screen.getByRole("menu")).getByRole("menuitem", {
        name: "Quote reply",
      }),
    );
    // Within the press itself, with nothing awaited: iOS raises the keyboard
    // for no focus made later.
    expect(editor?.contains(document.activeElement)).toBe(true);

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    // Radix hands the focus back from a timer once the menu has unmounted.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(editor?.contains(document.activeElement)).toBe(true);
  });
});
