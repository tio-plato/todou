import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addUserWithToken,
  makeTestApp,
  PLACEMENTS,
  type TestApp,
} from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

type Row = { id: string; type: string; name?: string; selectable: boolean };

describe.each(PLACEMENTS)("applying a template (%s placement)", (placement) => {
  let t: TestApp;
  let cookie: string;
  let n = 0;
  const slug = () => `apply-${placement.replaceAll(/[^a-z]/g, "")}-${n++}`;

  beforeAll(async () => {
    t = await makeTestApp(placement);
    cookie = await t.login();
  });

  afterAll(async () => {
    await t.cleanup();
  });

  const call = (
    method: string,
    path: string,
    body?: unknown,
    who: Record<string, string> = { cookie },
  ) =>
    t.app.request(`/api${path}`, {
      method,
      headers: { "content-type": "application/json", ...who },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const get = async (path: string) => json(await call("GET", path));

  async function created(path: string, body: unknown): Promise<any> {
    const res = await call("POST", path, body);
    expect(res.status, path).toBe(201);
    return json(res);
  }

  /**
   * A project drifted from Default: Parked (empty) and Discard (one card)
   * added, Invalid gone, kind:bug recoloured, kind:docs and area:web added
   * and each put on a card.
   */
  async function drifted() {
    const s = slug();
    await created("/projects", { slug: s, name: s });
    const statusId = async (name: string) =>
      (await get(`/projects/${s}/statuses`)).find(
        (x: { name: string }) => x.name === name,
      )?.id as number;
    const invalid = await statusId("Invalid");
    expect(
      (await call("DELETE", `/projects/${s}/statuses/${invalid}`)).status,
    ).toBe(204);
    const parked = await created(`/projects/${s}/statuses`, {
      name: "Parked",
      category: "open",
    });
    const discard = await created(`/projects/${s}/statuses`, {
      name: "Discard",
      category: "closed",
    });
    const labelId = async (name: string) =>
      (await get(`/projects/${s}/labels`)).find(
        (x: { name: string }) => x.name === name,
      )?.id as number;
    const bug = await labelId("kind:bug");
    expect(
      (
        await call("PATCH", `/projects/${s}/labels/${bug}`, {
          color: "#3b82f6",
        })
      ).status,
    ).toBe(200);
    const docs = await created(`/projects/${s}/labels`, { name: "kind:docs" });
    const web = await created(`/projects/${s}/labels`, { name: "area:web" });
    const card = await created(`/projects/${s}/issues`, {
      title: "labelled",
      label_ids: [docs.id, web.id],
    });
    const parkedCard = await created(`/projects/${s}/issues`, {
      title: "discarded",
      status_id: discard.id,
    });
    return {
      s,
      parked: parked.id as number,
      discard: discard.id as number,
      docs: docs.id as number,
      web: web.id as number,
      bug,
      card: card.number as number,
      parkedCard: parkedCard.number as number,
      statusId,
    };
  }

  const preview = async (s: string, template: unknown = "default") => {
    const res = await call("POST", `/projects/${s}/template/preview`, {
      template,
    });
    expect(res.status).toBe(200);
    return json(res) as Promise<{ expected: string; changes: Row[] }>;
  };
  const apply = (
    s: string,
    expected: string,
    selected: string[],
    template: unknown = "default",
  ) =>
    call("POST", `/projects/${s}/template/apply`, {
      template,
      expected,
      selected,
    });

  /** Everything an apply could change, to compare before and after. */
  const snapshot = async (s: string) => ({
    statuses: await get(`/projects/${s}/statuses`),
    labels: await get(`/projects/${s}/labels`),
    line: (await get(`/projects/${s}`)).block_clear_status_id,
    settings: await get(`/projects/${s}/insights/settings`),
  });

  it("carries out the selected rows and only those", async () => {
    const p = await drifted();
    const plan = await preview(p.s);
    const selected = [
      "status.add:Invalid",
      `label.change:${p.bug}`,
      `label.delete:${p.docs}`,
      `status.delete:${p.parked}`,
    ];
    const res = await apply(p.s, plan.expected, selected);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ skipped: [] });

    const statuses = (await get(`/projects/${p.s}/statuses`)).map(
      (x: { name: string }) => x.name,
    );
    expect(statuses).toEqual([
      "Backlog",
      "Todo",
      "Next",
      "In Progress",
      "Ready to Ship",
      "Shipped",
      "Done",
      "Invalid",
      "Discard",
    ]);
    const labels = await get(`/projects/${p.s}/labels`);
    expect(
      labels.find((l: { name: string }) => l.name === "kind:bug").color,
    ).toBe("#ef4444");
    expect(labels.map((l: { name: string }) => l.name)).toContain("area:web");
    expect(labels.map((l: { name: string }) => l.name)).not.toContain(
      "kind:docs",
    );
    const card = await get(`/projects/${p.s}/issues/${p.card}`);
    expect(card.labels.map((l: { name: string }) => l.name)).toEqual([
      "area:web",
    ]);
    const settings = await get(`/projects/${p.s}/insights/settings`);
    expect(
      settings.roles.find((r: { name: string }) => r.name === "Invalid").role,
    ).toBe("excluded");
  });

  it("changes paired statuses, the default and the roles, and adds labels", async () => {
    const s = slug();
    await created("/projects", { slug: s, name: s });
    const statusId = async (name: string) =>
      (await get(`/projects/${s}/statuses`)).find(
        (x: { name: string }) => x.name === name,
      )?.id as number;
    const done = await statusId("Done");
    const shipped = await statusId("Shipped");
    const next = await statusId("Next");
    for (const [path, body] of [
      [
        `/projects/${s}/statuses/${done}`,
        { color: "#000000", category: "open" },
      ],
      [`/projects/${s}/statuses/${next}`, { is_default: true }],
    ] as const) {
      expect((await call("PATCH", path, body)).status).toBe(200);
    }
    // Shipped differs in its chart role alone.
    expect(
      (
        await call("PUT", `/projects/${s}/insights/settings/roles/${shipped}`, {
          role: "excluded",
        })
      ).status,
    ).toBe(200);
    const chore = (await get(`/projects/${s}/labels`)).find(
      (l: { name: string }) => l.name === "kind:chore",
    );
    expect(
      (await call("DELETE", `/projects/${s}/labels/${chore.id}`)).status,
    ).toBe(204);

    const plan = await preview(s);
    const selected = plan.changes
      .filter((r) => (r as { default_selected?: boolean }).default_selected)
      .map((r) => r.id);
    expect(selected.sort()).toEqual(
      [
        `status.change:${done}`,
        `status.change:${shipped}`,
        "status.default",
        "label.add:kind:chore",
      ].sort(),
    );
    const res = await apply(s, plan.expected, selected);
    expect(res.status).toBe(200);

    const statuses = await get(`/projects/${s}/statuses`);
    const byName = (name: string) =>
      statuses.find((x: { name: string }) => x.name === name);
    expect(byName("Done")).toMatchObject({
      color: "#22c55e",
      category: "closed",
    });
    expect(
      statuses.filter((x: { is_default: boolean }) => x.is_default),
    ).toMatchObject([{ name: "Todo" }]);
    const roles = (await get(`/projects/${s}/insights/settings`)).roles;
    expect(roles.find((r: { name: string }) => r.name === "Shipped").role).toBe(
      "completed",
    );
    expect(
      (await get(`/projects/${s}/labels`)).map((l: { name: string }) => l.name),
    ).toContain("kind:chore");
    expect((await preview(s)).changes).toEqual([]);
  });

  it("will not offer to delete a status holding only trashed issues", async () => {
    const s = slug();
    await created("/projects", { slug: s, name: s });
    const binned = await created(`/projects/${s}/statuses`, {
      name: "Binned",
      category: "closed",
    });
    const card = await created(`/projects/${s}/issues`, {
      title: "trashed",
      status_id: binned.id,
    });
    expect(
      (await call("DELETE", `/projects/${s}/issues/${card.number}`)).status,
    ).toBe(204);
    const plan = await preview(s);
    expect(
      plan.changes.find((r) => r.id === `status.delete:${binned.id}`),
    ).toMatchObject({ selectable: false, issues: 0, trashed: 1 });
  });

  it("refuses a preview the project has moved on from, and changes nothing", async () => {
    const p = await drifted();
    const plan = await preview(p.s);
    expect(
      (
        await call("PATCH", `/projects/${p.s}/labels/${p.web}`, {
          name: "area:www",
        })
      ).status,
    ).toBe(200);
    const before = await snapshot(p.s);
    const res = await apply(
      p.s,
      plan.expected,
      plan.changes.map((row) => row.id),
    );
    expect(res.status).toBe(409);
    expect(await snapshot(p.s)).toEqual(before);
  });

  it("refuses a preview of a template that changed since", async () => {
    const p = await drifted();
    const template = await created("/me/project-templates", {
      name: `Changes ${p.s}`,
      from_project: p.s,
    });
    const body = template.body;
    body.labels = body.labels.filter(
      (l: { name: string }) => l.name !== "kind:docs",
    );
    const put = (revision: number) =>
      call("PUT", `/me/project-templates/${template.ref}`, {
        revision,
        name: template.name,
        body,
      });
    expect((await put(0)).status).toBe(200);
    const plan = await preview(p.s, template.ref);
    expect(plan.changes.map((r) => r.id)).toEqual([`label.delete:${p.docs}`]);
    // Another tab drops area:web from the template too.
    body.labels = body.labels.filter(
      (l: { name: string }) => l.name !== "area:web",
    );
    expect((await put(1)).status).toBe(200);
    const before = await snapshot(p.s);
    const res = await apply(
      p.s,
      plan.expected,
      [`label.delete:${p.docs}`],
      template.ref,
    );
    expect(res.status).toBe(409);
    expect(await snapshot(p.s)).toEqual(before);
  });

  it("refuses a row that is not in the plan, or one missing what it needs", async () => {
    const p = await drifted();
    // Default's default status is Todo; renamed away, it has to be added.
    const todo = await p.statusId("Todo");
    expect(
      (
        await call("PATCH", `/projects/${p.s}/statuses/${todo}`, {
          name: "To do",
        })
      ).status,
    ).toBe(200);
    const plan = await preview(p.s);
    expect(plan.changes.find((r) => r.id === "status.default")).toMatchObject({
      requires: ["status.add:Todo"],
    });
    const before = await snapshot(p.s);
    for (const selected of [["status.add:Nope"], ["status.default"]]) {
      const res = await apply(p.s, plan.expected, selected);
      expect(res.status, selected.join()).toBe(422);
    }
    expect(await snapshot(p.s)).toEqual(before);
  });

  it("skips deleting a status that holds issues and does the rest", async () => {
    const p = await drifted();
    const plan = await preview(p.s);
    const row = plan.changes.find((r) => r.id === `status.delete:${p.discard}`);
    expect(row?.selectable).toBe(false);
    const res = await apply(p.s, plan.expected, [
      `status.delete:${p.discard}`,
      `label.delete:${p.docs}`,
    ]);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      skipped: [`status.delete:${p.discard}`],
    });
    expect(await p.statusId("Discard")).toBe(p.discard);
    expect(
      (await get(`/projects/${p.s}/labels`)).map(
        (l: { name: string }) => l.name,
      ),
    ).not.toContain("kind:docs");
  });

  it("skips a status that took an issue after the preview", async () => {
    const p = await drifted();
    const plan = await preview(p.s);
    expect(
      (
        await call("PATCH", `/projects/${p.s}/issues/${p.card}`, {
          status_id: p.parked,
        })
      ).status,
    ).toBe(200);
    const res = await apply(p.s, plan.expected, [`status.delete:${p.parked}`]);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      skipped: [`status.delete:${p.parked}`],
    });
    expect(await p.statusId("Parked")).toBe(p.parked);
  });

  it("is an admin's to preview and to apply", async () => {
    const p = await drifted();
    const writer = await addUserWithToken(t.ctx, `writer-${p.s}`);
    expect(
      (
        await call("POST", `/projects/${p.s}/members`, {
          login: `writer-${p.s}`,
          role: "writer",
        })
      ).status,
    ).toBe(201);
    const who = writer.headers;
    expect(
      (
        await call(
          "POST",
          `/projects/${p.s}/template/preview`,
          { template: "default" },
          who,
        )
      ).status,
    ).toBe(403);
    const plan = await preview(p.s);
    expect(
      (
        await call(
          "POST",
          `/projects/${p.s}/template/apply`,
          {
            template: "default",
            expected: plan.expected,
            selected: ["status.add:Invalid"],
          },
          who,
        )
      ).status,
    ).toBe(403);
  });

  it("re-decides blocks when the line moves", async () => {
    const s = slug();
    await created("/projects", { slug: s, name: s });
    const blocked = (await created(`/projects/${s}/issues`, { title: "A" }))
      .number;
    const blocker = (await created(`/projects/${s}/issues`, { title: "B" }))
      .number;
    expect(
      (
        await call("POST", `/projects/${s}/issues/${blocked}/blocked-by`, {
          ref: `#${blocker}`,
        })
      ).status,
    ).toBe(200);
    const inProgress = (await get(`/projects/${s}/statuses`)).find(
      (x: { name: string }) => x.name === "In Progress",
    ).id;
    expect(
      (
        await call("PATCH", `/projects/${s}/issues/${blocker}`, {
          status_id: inProgress,
        })
      ).status,
    ).toBe(200);
    const blockedBy = async () =>
      (await get(`/projects/${s}/issues/${blocked}`)).blocked_by[0];
    expect((await blockedBy()).cleared_at).toBeNull();

    const template = await created("/me/project-templates", {
      name: `Line at In Progress ${s}`,
      from_project: s,
    });
    const body = template.body;
    for (const status of body.statuses) {
      delete status.block_clear;
      if (status.name === "In Progress") status.block_clear = true;
    }
    expect(
      (
        await call("PUT", `/me/project-templates/${template.ref}`, {
          revision: 0,
          name: template.name,
          body,
        })
      ).status,
    ).toBe(200);
    const plan = await preview(s, template.ref);
    expect(plan.changes.map((r) => r.id)).toEqual(["status.line"]);
    expect(
      (await apply(s, plan.expected, ["status.line"], template.ref)).status,
    ).toBe(200);
    expect((await get(`/projects/${s}`)).block_clear_status_id).toBe(
      inProgress,
    );
    expect((await blockedBy()).cleared_at).not.toBeNull();
  });
});
