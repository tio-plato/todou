import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

const BODY = {
  statuses: [
    {
      name: "Open",
      category: "open",
      color: "#3b82f6",
      chart_role: "remaining",
      is_default: true,
    },
    {
      name: "Shut",
      category: "closed",
      color: "#22c55e",
      chart_role: "completed",
      block_clear: true,
    },
  ],
  labels: [
    { name: "area:web", color: "#0ea5e9" },
    { name: "kind:bug", color: "#ef4444" },
  ],
};

// The table lives in the system tier only; reading a project into a body is
// covered under every placement by the from_project creation tests.
describe("project templates", () => {
  let t: TestApp;
  let cookie: string;
  let n = 0;
  const headers = () => ({ "content-type": "application/json", cookie });

  beforeAll(async () => {
    t = await makeTestApp();
    cookie = await t.login();
  });

  afterAll(async () => {
    await t.cleanup();
  });

  const request = (
    path: string,
    method: string,
    body?: unknown,
    who: Record<string, string> = headers(),
  ) =>
    t.app.request(`/api${path}`, {
      method,
      headers: { "content-type": "application/json", ...who },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  async function createTemplate(
    body: unknown,
    who?: Record<string, string>,
  ): Promise<{ status: number; data: any }> {
    const res = await request("/me/project-templates", "POST", body, who);
    return { status: res.status, data: await json(res) };
  }

  async function createProject(who?: Record<string, string>) {
    const slug = `tpl-src-${n++}`;
    const res = await request(
      "/projects",
      "POST",
      { slug, name: `Source ${slug}` },
      who,
    );
    expect(res.status).toBe(201);
    return slug;
  }

  async function statuses(slug: string) {
    return json(await request(`/projects/${slug}/statuses`, "GET"));
  }

  const idOf = async (slug: string, name: string): Promise<number> =>
    (await statuses(slug)).find((s: { name: string }) => s.name === name).id;

  it("lists the built-in Default first, then my own by name, and nobody else's", async () => {
    const other = await addUserWithToken(t.ctx, "tpl-other");
    expect(
      (await createTemplate({ name: "Theirs", body: BODY }, other.headers))
        .status,
    ).toBe(201);
    for (const name of ["Zeta", "Alpha"]) {
      expect((await createTemplate({ name, body: BODY })).status).toBe(201);
    }

    const list = await json(await request("/me/project-templates", "GET"));
    expect(
      list.map((x: { name: string; builtin: boolean }) => [x.name, x.builtin]),
    ).toEqual([
      ["Default", true],
      ["Alpha", false],
      ["Zeta", false],
    ]);
    expect(list[0].ref).toBe("default");
  });

  it("reads back a created body at revision 0", async () => {
    const { status, data } = await createTemplate({
      name: "  Round trip ",
      body: BODY,
    });
    expect(status).toBe(201);
    const list = await json(await request("/me/project-templates", "GET"));
    const stored = list.find((x: { ref: unknown }) => x.ref === data.ref);
    expect(stored).toEqual({
      ref: data.ref,
      name: "Round trip",
      builtin: false,
      revision: 0,
      body: BODY,
    });
  });

  it("saves a project's order, default, line, chart roles and labels", async () => {
    const slug = await createProject();
    const ids = (await statuses(slug)).map((s: { id: number }) => s.id);
    const next = await idOf(slug, "Next");
    const done = await idOf(slug, "Done");
    // Next dragged above Backlog, the line onto Done.
    const order = [next, ...ids.filter((id: number) => id !== next)];
    expect(
      (
        await request(`/projects/${slug}/statuses/order`, "PUT", {
          ids: order,
          block_clear_status_id: done,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(`/projects/${slug}/statuses/${next}`, "PATCH", {
          is_default: true,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          `/projects/${slug}/insights/settings/roles/${done}`,
          "PUT",
          { role: "excluded" },
        )
      ).status,
    ).toBe(200);
    for (const [name, color] of [
      ["area:cli", "#14b8a6"],
      ["urgent", "#f97316"],
    ]) {
      expect(
        (await request(`/projects/${slug}/labels`, "POST", { name, color }))
          .status,
      ).toBe(201);
    }

    const { status, data } = await createTemplate({
      name: "From project",
      from_project: slug,
    });
    expect(status).toBe(201);
    const saved = data.body.statuses;
    expect(saved.map((s: { name: string }) => s.name)).toEqual([
      "Next",
      "Backlog",
      "Todo",
      "In Progress",
      "Ready to Ship",
      "Shipped",
      "Done",
      "Invalid",
    ]);
    expect(
      saved.filter((s: { is_default?: true }) => s.is_default),
    ).toMatchObject([{ name: "Next" }]);
    expect(
      saved.filter((s: { block_clear?: true }) => s.block_clear),
    ).toMatchObject([{ name: "Done" }]);
    const roles = Object.fromEntries(
      saved.map((s: { name: string; chart_role: string }) => [
        s.name,
        s.chart_role,
      ]),
    );
    expect(roles).toMatchObject({
      Done: "excluded",
      Shipped: "completed",
      Invalid: "excluded",
      Next: "remaining",
    });
    const labels = await json(await request(`/projects/${slug}/labels`, "GET"));
    expect(data.body.labels).toEqual(
      labels.map((l: { name: string; color: string }) => ({
        name: l.name,
        color: l.color,
      })),
    );
    expect(data.body.labels).toContainEqual({
      name: "urgent",
      color: "#f97316",
    });
  });

  it("refuses a stale revision and bumps the current one", async () => {
    const { data } = await createTemplate({ name: "Versioned", body: BODY });
    const put = (revision: number) =>
      request(`/me/project-templates/${data.ref}`, "PUT", {
        revision,
        name: "Versioned",
        body: { ...BODY, labels: [] },
      });

    expect((await put(0)).status).toBe(200);
    const stale = await put(0);
    expect(stale.status).toBe(409);
    expect((await json(stale)).error.details).toEqual({ current_revision: 1 });
    const fresh = await put(1);
    expect(fresh.status).toBe(200);
    expect((await json(fresh)).revision).toBe(2);
  });

  it("answers another user's template like a missing one", async () => {
    const { data } = await createTemplate({ name: "Mine", body: BODY });
    const other = await addUserWithToken(t.ctx, "tpl-snoop");
    const who = { "content-type": "application/json", ...other.headers };
    expect(
      (
        await t.app.request(`/api/me/project-templates/${data.ref}`, {
          method: "PUT",
          headers: who,
          body: JSON.stringify({ revision: 0, name: "x", body: BODY }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await t.app.request(`/api/me/project-templates/${data.ref}`, {
          method: "DELETE",
          headers: who,
        })
      ).status,
    ).toBe(404);
    expect(
      (await request(`/me/project-templates/${data.ref}`, "DELETE")).status,
    ).toBe(204);
  });

  it("will not read a project the caller cannot see", async () => {
    const slug = await createProject();
    const outsider = await addUserWithToken(t.ctx, "tpl-outsider");
    const { status } = await createTemplate(
      { name: "Peek", from_project: slug },
      outsider.headers,
    );
    expect(status).toBe(404);
  });

  it("stores a status name trimmed, and refuses two that become one", async () => {
    const slug = await createProject();
    const done = await idOf(slug, "Done");
    expect(
      (
        await request(`/projects/${slug}/statuses/${done}`, "PATCH", {
          name: "Done ",
        })
      ).status,
    ).toBe(200);
    const { status, data } = await createTemplate({
      name: "Trimmed",
      from_project: slug,
    });
    expect(status).toBe(201);
    expect(data.body.statuses.map((s: { name: string }) => s.name)).toContain(
      "Done",
    );

    expect(
      (
        await request(`/projects/${slug}/statuses`, "POST", {
          name: "Done",
          category: "closed",
        })
      ).status,
    ).toBe(201);
    const refused = await createTemplate({
      name: "Clash",
      from_project: slug,
    });
    expect(refused.status).toBe(422);
    expect(refused.data.error.message).toContain('"Done "');
    expect(refused.data.error.message).toContain('"Done"');
  });
});
