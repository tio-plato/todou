import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addUserWithToken, makeTestApp, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

/**
 * The label catalog moved from admin to writer (T-264). One placement is
 * enough: the gate reads `project_members` out of the system tier, which no
 * placement mode moves.
 */
describe("who may edit the label catalog", () => {
  let t: TestApp;
  let cookie: string;
  const slug = "label-roles";
  const admin = () => ({ "content-type": "application/json", cookie });

  const tokens: Record<"reader" | "reporter" | "writer", string> = {
    reader: "",
    reporter: "",
    writer: "",
  };
  const as = (who: keyof typeof tokens) => ({
    "content-type": "application/json",
    authorization: tokens[who],
  });

  const createLabel = (headers: Record<string, string>, name: string) =>
    t.app.request(`/api/projects/${slug}/labels`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name }),
    });

  beforeAll(async () => {
    t = await makeTestApp("shared");
    cookie = await t.login();
    const created = await t.app.request("/api/projects", {
      method: "POST",
      headers: admin(),
      body: JSON.stringify({ slug, name: "Label roles" }),
    });
    expect(created.status).toBe(201);

    for (const role of ["reader", "reporter", "writer"] as const) {
      const added = await addUserWithToken(t.ctx, `${role}-of-${slug}`);
      const res = await t.app.request(
        `/api/projects/${slug}/members/${added.user.id}`,
        {
          method: "PUT",
          headers: admin(),
          body: JSON.stringify({ role }),
        },
      );
      expect(res.status).toBe(204);
      tokens[role] = added.headers.authorization;
    }
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("lets a writer create, rename, recolor and delete", async () => {
    const created = await createLabel(as("writer"), "flaky");
    expect(created.status).toBe(201);
    const label = await json(created);

    const renamed = await t.app.request(
      `/api/projects/${slug}/labels/${label.id}`,
      {
        method: "PATCH",
        headers: as("writer"),
        body: JSON.stringify({ name: "flaky-test", color: "#ff0000" }),
      },
    );
    expect(renamed.status).toBe(200);
    expect(await json(renamed)).toMatchObject({
      name: "flaky-test",
      color: "#ff0000",
    });

    const removed = await t.app.request(
      `/api/projects/${slug}/labels/${label.id}`,
      { method: "DELETE", headers: as("writer") },
    );
    expect(removed.status).toBe(204);
  });

  it("still lets an admin do the same", async () => {
    const created = await createLabel(admin(), "wontfix");
    expect(created.status).toBe(201);
    const label = await json(created);
    const removed = await t.app.request(
      `/api/projects/${slug}/labels/${label.id}`,
      { method: "DELETE", headers: admin() },
    );
    expect(removed.status).toBe(204);
  });

  it("refuses a reporter and a reader", async () => {
    expect((await createLabel(as("reporter"), "from-reporter")).status).toBe(
      403,
    );
    expect((await createLabel(as("reader"), "from-reader")).status).toBe(403);
  });

  it("names the capability in the refusal", async () => {
    const res = await createLabel(as("reader"), "denied");
    expect((await json(res)).error.message).toBe(
      "requires writer role (label.create)",
    );
  });

  it("keeps reading the catalog open to every member", async () => {
    for (const who of ["reader", "reporter", "writer"] as const) {
      const res = await t.app.request(`/api/projects/${slug}/labels`, {
        headers: as(who),
      });
      expect(res.status).toBe(200);
    }
  });
});

/**
 * T-713: the settings page shows how many issues carry each label, and links
 * the number to the issue list — so open means the status category, the
 * trash is left out, and an issue with two labels counts once under each.
 */
describe("label usage", () => {
  let t: TestApp;
  let cookie: string;
  const slug = "label-usage";
  const headers = () => ({ "content-type": "application/json", cookie });
  const post = (path: string, body: unknown) =>
    t.app.request(`/api/projects/${slug}${path}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    t = await makeTestApp("shared");
    cookie = await t.login();
    const created = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug, name: "Label usage" }),
    });
    expect(created.status).toBe(201);
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("counts open and all issues per label, skipping the trash", async () => {
    const bug = await json(await post("/labels", { name: "kind:defect" }));
    const docs = await json(await post("/labels", { name: "area:docs" }));
    const unused = await json(await post("/labels", { name: "unused" }));
    const statuses = await json(
      await t.app.request(`/api/projects/${slug}/statuses`, {
        headers: headers(),
      }),
    );
    // biome-ignore lint/suspicious/noExplicitAny: test-side response poking
    const closed = statuses.find((s: any) => s.category === "closed");
    expect(closed).toBeDefined();

    const issue = async (body: Record<string, unknown>) => {
      const res = await post("/issues", { title: "t", ...body });
      expect(res.status).toBe(201);
      return json(res);
    };
    await issue({ label_ids: [bug.id, docs.id] });
    await issue({ label_ids: [bug.id] });
    await issue({ label_ids: [bug.id], status_id: closed.id });
    const trashed = await issue({ label_ids: [bug.id, docs.id] });
    const removed = await t.app.request(
      `/api/projects/${slug}/issues/${trashed.number}`,
      { method: "DELETE", headers: headers() },
    );
    expect(removed.status).toBe(204);

    const res = await t.app.request(`/api/projects/${slug}/labels/usage`, {
      headers: headers(),
    });
    expect(res.status).toBe(200);
    const usage = await json(res);
    // The three above, and the four the project started with, all unused.
    expect(usage).toHaveLength(7);
    expect(usage).toEqual(
      expect.arrayContaining([
        { id: bug.id, open_issues: 2, issues: 3 },
        { id: docs.id, open_issues: 1, issues: 1 },
        { id: unused.id, open_issues: 0, issues: 0 },
      ]),
    );
  });
});

/**
 * A label is drawn as a tinted or a solid chip. Tinted is what every label
 * looked like before the choice existed, so it is what a label gets when
 * none is given, and a row that predates the column reads as tinted.
 */
describe("label chip style", () => {
  let t: TestApp;
  let cookie: string;
  const slug = "label-style";
  const headers = () => ({ "content-type": "application/json", cookie });
  const request = (path: string, method = "GET", body?: unknown) =>
    t.app.request(`/api/projects/${slug}${path}`, {
      method,
      headers: headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const listed = async (id: number) => {
    const res = await request("/labels");
    expect(res.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: test-side response poking
    return (await json(res)).find((l: any) => l.id === id);
  };

  beforeAll(async () => {
    t = await makeTestApp("shared");
    cookie = await t.login();
    const created = await t.app.request("/api/projects", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ slug, name: "Label style" }),
    });
    expect(created.status).toBe(201);
  });

  afterAll(async () => {
    await t.cleanup();
  });

  it("stores a chip style, tint unless one is given", async () => {
    const plain = await request("/labels", "POST", { name: "plain" });
    expect(plain.status).toBe(201);
    const tint = await json(plain);
    expect(tint.style).toBe("tint");
    expect((await listed(tint.id)).style).toBe("tint");

    const bold = await request("/labels", "POST", {
      name: "bold",
      style: "solid",
    });
    expect(bold.status).toBe(201);
    const solid = await json(bold);
    expect(solid.style).toBe("solid");
    expect((await listed(solid.id)).style).toBe("solid");

    // Issue rows and board cards draw their chips from the issue's labels.
    const issue = await request("/issues", "POST", {
      title: "t",
      label_ids: [solid.id],
    });
    expect(issue.status).toBe(201);
    expect((await json(issue)).labels).toMatchObject([
      { id: solid.id, style: "solid" },
    ]);
  });

  it("changes the style on its own", async () => {
    const created = await json(
      await request("/labels", "POST", { name: "restyled", color: "#10b981" }),
    );
    expect(created.style).toBe("tint");

    const res = await request(`/labels/${created.id}`, "PATCH", {
      style: "solid",
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      id: created.id,
      name: "restyled",
      color: "#10b981",
      style: "solid",
    });
    expect((await listed(created.id)).style).toBe("solid");
  });
});
