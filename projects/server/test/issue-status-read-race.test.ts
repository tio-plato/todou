import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { TestHooks } from "../src/bootstrap.ts";
import { makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/**
 * A card read whose statuses go away under it.
 *
 * Reads take the cards in one statement and their statuses in a later one;
 * the hook commits the competitor between the two. Shared placement only:
 * the status read uses the handle the cards came from under every
 * placement, and deleting a project from `pglite://memory` runs the same
 * cleanup transaction under each of them. The hook fixes the order, and
 * the read holds no lock, so real postgres would run the same statements.
 */
describe("card reads racing a status going away", () => {
  let t: TestApp;
  let cookie: string;
  let seq = 0;

  /** Fires once, so a competitor that reads cards itself does not re-enter it. */
  const pending: { beforeStatusRead?: () => Promise<void> } = {};
  const once = (key: keyof typeof pending) => async () => {
    const run = pending[key];
    delete pending[key];
    await run?.();
  };
  const hooks: TestHooks = { beforeStatusRead: once("beforeStatusRead") };

  const req = (path: string, init?: RequestInit) =>
    Promise.resolve(
      t.app.request(`/api${path}`, {
        ...init,
        headers: init?.body
          ? { "content-type": "application/json", cookie }
          : { cookie },
      }),
    );
  const createProject = async (name: string) => {
    seq += 1;
    const slug = `${name}-${seq}`;
    const res = await req("/projects", {
      method: "POST",
      body: JSON.stringify({ slug, name: slug }),
    });
    expect(res.status).toBe(201);
    return slug;
  };
  const createIssue = async (slug: string, title: string) => {
    const res = await req(`/projects/${slug}/issues`, {
      method: "POST",
      body: JSON.stringify({ title }),
    });
    expect(res.status).toBe(201);
    return (await json(res)) as { number: number; status: { id: number } };
  };
  const deleteProject = async (slug: string) => {
    const res = await req(`/projects/${slug}`, { method: "DELETE" });
    expect(res.status).toBe(204);
  };

  beforeAll(async () => {
    t = await makeTestApp("shared", undefined, hooks);
    cookie = await t.login();
  });

  afterAll(async () => {
    await t.cleanup();
  });

  // A test that fails before its read reaches the hook would otherwise
  // leave it set for whichever read comes next.
  afterEach(() => {
    delete pending.beforeStatusRead;
  });

  it("answers a card whose project went away 404", async () => {
    const slug = await createProject("gone");
    const card = await createIssue(slug, "doomed");
    pending.beforeStatusRead = () => deleteProject(slug);

    const res = await req(`/projects/${slug}/issues/${card.number}`);
    expect(pending.beforeStatusRead).toBeUndefined();
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe("not_found");
  });

  it("leaves a gone project's cards out of a list across projects", async () => {
    const gone = await createProject("listed-gone");
    const kept = await createProject("listed-kept");
    await createIssue(gone, "doomed");
    await createIssue(kept, "kept");
    const { login } = await json(await req("/me"));
    pending.beforeStatusRead = () => deleteProject(gone);

    const res = await req(`/users/${login}/issues`);
    expect(pending.beforeStatusRead).toBeUndefined();
    expect(res.status).toBe(200);
    const slugs = (await json(res)).items.map(
      (i: { project: { slug: string } }) => i.project.slug,
    );
    expect(slugs).toContain(kept);
    expect(slugs).not.toContain(gone);
  });

  it("answers a card whose old status went away with the status it has now", async () => {
    const slug = await createProject("swapped");
    const card = await createIssue(slug, "moved on");
    const before = card.status.id;
    const statuses = (await json(
      await req(`/projects/${slug}/statuses`),
    )) as Array<{ id: number }>;
    const after = statuses.find((s) => s.id !== before)?.id;
    expect(after).toBeDefined();
    pending.beforeStatusRead = async () => {
      const moved = await req(`/projects/${slug}/issues/${card.number}`, {
        method: "PATCH",
        body: JSON.stringify({ status_id: after }),
      });
      expect(moved.status).toBe(200);
      const deleted = await req(`/projects/${slug}/statuses/${before}`, {
        method: "DELETE",
      });
      expect(deleted.status).toBe(204);
    };

    const res = await req(`/projects/${slug}/issues/${card.number}`);
    expect(pending.beforeStatusRead).toBeUndefined();
    expect(res.status).toBe(200);
    expect((await json(res)).status.id).toBe(after);
  });
});
