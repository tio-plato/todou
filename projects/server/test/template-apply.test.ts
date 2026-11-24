import { BUILTIN_TEMPLATES } from "@todou/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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

  async function created(path: string, body: unknown): ReturnType<typeof json> {
    const res = await call("POST", path, body);
    expect(res.status, path).toBe(201);
    return json(res);
  }

  /**
   * A project drifted from Basic: Parked (empty) and Discard (one card)
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

  const preview = async (s: string, template: unknown = "basic") => {
    const res = await call("POST", `/projects/${s}/template/preview`, {
      template,
    });
    expect(res.status).toBe(200);
    return json(res) as Promise<{
      expected: string;
      changes: Row[];
      project: unknown;
      template: unknown;
    }>;
  };
  type Drawn = {
    order: Array<number | string>;
    line: number | string | null;
    default: number | string | null;
  };
  const apply = (
    s: string,
    expected: string,
    selected: string[],
    template: unknown = "basic",
    drawn?: Drawn,
    labelIssues?: Record<string, number>,
  ) =>
    call("POST", `/projects/${s}/template/apply`, {
      template,
      expected,
      selected,
      ...(drawn && { drawn }),
      ...(labelIssues && { label_issues: labelIssues }),
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
    const res = await apply(p.s, plan.expected, selected, "basic", undefined, {
      [`label.delete:${p.docs}`]: 1,
    });
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
        `status.recolour:${done}`,
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

  it("hands back the project and the template the plan was computed from", async () => {
    const p = await drifted();
    const plan = await preview(p.s);
    const roles = (await get(`/projects/${p.s}/insights/settings`)).roles;
    const byId = <T extends { id: number }>(rows: T[]) =>
      [...rows].sort((a, b) => a.id - b.id);
    expect(plan.template).toEqual(BUILTIN_TEMPLATES.basic.body);
    const project = plan.project as {
      statuses: unknown[];
      line: number | null;
      labels: Array<{ id: number }>;
    };
    expect(project.statuses).toEqual(
      (await get(`/projects/${p.s}/statuses`)).map(
        (s: {
          id: number;
          name: string;
          color: string;
          category: string;
          is_default: boolean;
        }) => ({
          id: s.id,
          name: s.name,
          color: s.color,
          category: s.category,
          role: roles.find((r: { status_id: number }) => r.status_id === s.id)
            .role,
          is_default: s.is_default,
        }),
      ),
    );
    expect(project.line).toBe(
      (await get(`/projects/${p.s}`)).block_clear_status_id,
    );
    expect(byId(project.labels)).toEqual(
      byId(
        (await get(`/projects/${p.s}/labels`)).map(
          (l: { id: number; name: string; color: string }) => ({
            id: l.id,
            name: l.name,
            color: l.color,
          }),
        ),
      ),
    );
  });

  /** Drifted's statuses once Invalid is added and Parked deleted. */
  async function drawnFor(p: Awaited<ReturnType<typeof drifted>>) {
    const id = (name: string) => p.statusId(name);
    return {
      order: [
        ...(await Promise.all(
          ["Backlog", "Todo", "Next", "In Progress", "Ready to Ship"].map(id),
        )),
        await id("Shipped"),
        await id("Done"),
        "Invalid",
        p.discard,
      ],
      line: await id("Shipped"),
      default: await id("Todo"),
    } satisfies Drawn;
  }

  it("refuses an apply that comes to anything but what was drawn, and changes nothing", async () => {
    const p = await drifted();
    const plan = await preview(p.s);
    const selected = ["status.add:Invalid", `status.delete:${p.parked}`];
    const drawn = await drawnFor(p);
    const before = await snapshot(p.s);
    for (const wrong of [
      { ...drawn, order: [...drawn.order].reverse() },
      { ...drawn, order: drawn.order.filter((key) => key !== "Invalid") },
      { ...drawn, line: await p.statusId("Done") },
      { ...drawn, default: null },
    ]) {
      const res = await apply(p.s, plan.expected, selected, "basic", wrong);
      expect(res.status, JSON.stringify(wrong)).toBe(409);
      // Its own code: previewing again would draw the same.
      expect((await json(res)).error.code).toBe("drawn_mismatch");
    }
    expect(await snapshot(p.s)).toEqual(before);

    const res = await apply(p.s, plan.expected, selected, "basic", drawn);
    expect(res.status).toBe(200);
    const statuses = await get(`/projects/${p.s}/statuses`);
    expect(statuses.map((s: { id: number; name: string }) => s.id)).toEqual(
      drawn.order.map((key) =>
        key === "Invalid"
          ? statuses.find((s: { name: string }) => s.name === "Invalid").id
          : key,
      ),
    );
  });

  it("skips a status that took an issue after the preview, as drawn without it", async () => {
    const p = await drifted();
    const plan = await preview(p.s);
    expect(
      (
        await call("PATCH", `/projects/${p.s}/issues/${p.card}`, {
          status_id: p.parked,
        })
      ).status,
    ).toBe(200);
    const res = await apply(
      p.s,
      plan.expected,
      ["status.add:Invalid", `status.delete:${p.parked}`],
      "basic",
      await drawnFor(p),
    );
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      skipped: [`status.delete:${p.parked}`],
    });
    expect(await p.statusId("Parked")).toBe(p.parked);
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

  it("counts the trashed cards a label deletion takes it off", async () => {
    const s = slug();
    await created("/projects", { slug: s, name: s });
    const old = await created(`/projects/${s}/labels`, { name: "area:old" });
    const card = await created(`/projects/${s}/issues`, {
      title: "binned",
      label_ids: [old.id],
    });
    expect(
      (await call("DELETE", `/projects/${s}/issues/${card.number}`)).status,
    ).toBe(204);
    const plan = await preview(s);
    expect(
      plan.changes.find((r) => r.id === `label.delete:${old.id}`),
    ).toMatchObject({ issues: 0, trashed: 1 });
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
    // Basic's default status is Todo; renamed away, it has to be added.
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
    const res = await apply(
      p.s,
      plan.expected,
      [`status.delete:${p.discard}`, `label.delete:${p.docs}`],
      "basic",
      undefined,
      { [`label.delete:${p.docs}`]: 1 },
    );
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

  it("refuses an apply whose ticked label deletion now comes off another number of issues, and applies with the number it comes off", async () => {
    const p = await drifted();
    const wontfix = await created(`/projects/${p.s}/labels`, {
      name: "wontfix",
    });
    const plan = await preview(p.s);
    const id = `label.delete:${wontfix.id}`;
    expect(plan.changes.find((r) => r.id === id)).toMatchObject({
      issues: 0,
      trashed: 0,
    });
    expect(
      (
        await call("PATCH", `/projects/${p.s}/issues/${p.parkedCard}`, {
          label_ids: [wontfix.id],
        })
      ).status,
    ).toBe(200);
    const selected = ["status.add:Invalid", id];
    const before = await snapshot(p.s);
    const refused = await apply(
      p.s,
      plan.expected,
      selected,
      "basic",
      undefined,
      { [id]: 0 },
    );
    expect(refused.status).toBe(409);
    expect((await json(refused)).error).toMatchObject({
      code: "conflict",
      details: { id, shown: 0, now: 1 },
    });
    expect(await snapshot(p.s)).toEqual(before);
    const parked = await get(`/projects/${p.s}/issues/${p.parkedCard}`);
    expect(parked.labels.map((l: { name: string }) => l.name)).toEqual([
      "wontfix",
    ]);

    // Its one card goes to the trash, which a preview still counts, and a
    // card takes kind:docs, whose deletion is not ticked.
    expect(
      (await call("DELETE", `/projects/${p.s}/issues/${p.parkedCard}`)).status,
    ).toBe(204);
    await created(`/projects/${p.s}/issues`, {
      title: "docs",
      label_ids: [p.docs],
    });
    // The number sent for kind:docs, the one it was previewed on, is not
    // held against a deletion nobody ticked.
    const res = await apply(p.s, plan.expected, selected, "basic", undefined, {
      [id]: 1,
      [`label.delete:${p.docs}`]: 1,
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ skipped: [] });
    const labels = (await get(`/projects/${p.s}/labels`)).map(
      (l: { name: string }) => l.name,
    );
    expect(labels).not.toContain("wontfix");
    expect(labels).toContain("kind:docs");
    expect(await p.statusId("Invalid")).toEqual(expect.any(Number));
  });

  it("refuses too when a ticked label came off issues since the preview", async () => {
    const p = await drifted();
    const plan = await preview(p.s);
    const id = `label.delete:${p.docs}`;
    expect(plan.changes.find((r) => r.id === id)).toMatchObject({
      issues: 1,
      trashed: 0,
    });
    expect(
      (
        await call("PATCH", `/projects/${p.s}/issues/${p.card}`, {
          label_ids: [p.web],
        })
      ).status,
    ).toBe(200);
    const before = await snapshot(p.s);
    const res = await apply(p.s, plan.expected, [id], "basic", undefined, {
      [id]: 1,
    });
    expect(res.status).toBe(409);
    expect((await json(res)).error).toMatchObject({
      code: "conflict",
      details: { id, shown: 1, now: 0 },
    });
    expect(await snapshot(p.s)).toEqual(before);
  });

  it("refuses a ticked label deletion that does not say how many issues it was shown, and changes nothing", async () => {
    const p = await drifted();
    const plan = await preview(p.s);
    const id = `label.delete:${p.docs}`;
    const before = await snapshot(p.s);
    const res = await apply(p.s, plan.expected, [id]);
    expect(res.status).toBe(422);
    expect((await json(res)).error).toMatchObject({
      code: "validation_failed",
      details: { missing: [id] },
    });
    expect(await snapshot(p.s)).toEqual(before);
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
          { template: "basic" },
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
            template: "basic",
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

/**
 * A status of the same name created between an apply's read and its insert
 * reaches the insert as a unique violation, a race PGlite cannot stage: the
 * hook raises one in its place, once.
 */
describe("applying a template into a name clash", () => {
  let armed: string | null = null;
  let t: TestApp;
  let cookie: string;

  beforeAll(async () => {
    t = await makeTestApp("shared", undefined, {
      onQuery: (sql: string) => {
        if (armed !== null && /insert into "statuses"/.test(sql)) {
          const constraint = armed;
          armed = null;
          throw Object.assign(
            new Error(
              `duplicate key value violates unique constraint "${constraint}"`,
            ),
            { code: "23505", constraint },
          );
        }
      },
    });
    cookie = await t.login();
  });

  afterAll(async () => {
    await t.cleanup();
  });

  afterEach(() => {
    armed = null;
  });

  const call = (method: string, path: string, body?: unknown) =>
    t.app.request(`/api${path}`, {
      method,
      headers: { "content-type": "application/json", cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it("asks for a new preview on a name clash, and leaves any other duplicate a 500", async () => {
    for (const [slug, index, status] of [
      ["clash-name", "statuses_project_name_idx", 409],
      ["clash-other", "some_other_idx", 500],
    ] as const) {
      expect(
        (await call("POST", "/projects", { slug, name: slug })).status,
      ).toBe(201);
      const invalid = (
        await json(await call("GET", `/projects/${slug}/statuses`))
      ).find((s: { name: string }) => s.name === "Invalid");
      expect(
        (await call("DELETE", `/projects/${slug}/statuses/${invalid.id}`))
          .status,
      ).toBe(204);
      const plan = await json(
        await call("POST", `/projects/${slug}/template/preview`, {
          template: "basic",
        }),
      );
      armed = index;
      const res = await call("POST", `/projects/${slug}/template/apply`, {
        template: "basic",
        expected: plan.expected,
        selected: ["status.add:Invalid"],
      });
      expect(res.status, index).toBe(status);
    }
  });
});
