import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  insightsSettings,
  issues,
  labels,
  statuses,
} from "../src/db/project-schema.ts";
import { projects } from "../src/db/system-schema.ts";
import {
  addUserWithToken,
  makeTestApp,
  PLACEMENTS,
  type TestApp,
} from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

describe.each(PLACEMENTS)("projects domain (%s placement)", (placement) => {
  let t: TestApp;
  let cookie: string;
  let n = 0;
  const slug = () => `proj-${placement.replaceAll(/[^a-z]/g, "")}-${n++}`;

  beforeAll(async () => {
    t = await makeTestApp(placement);
    cookie = await t.login();
  });

  afterAll(async () => {
    await t.cleanup();
  });

  const postProject = (body: Record<string, unknown>) =>
    t.app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    });

  async function createProject(s: string) {
    const res = await postProject({ slug: s, name: `Project ${s}` });
    expect(res.status).toBe(201);
    return json(res);
  }

  const getRefConfig = async (s: string) =>
    json(
      await t.app.request(`/api/projects/${s}/references/config`, {
        headers: { cookie },
      }),
    );

  it("creates a project with seeded statuses and creator as admin", async () => {
    const s = slug();
    const project = await createProject(s);
    expect(project.slug).toBe(s);

    const statusRes = await t.app.request(`/api/projects/${s}/statuses`, {
      headers: { cookie },
    });
    const statuses = await json(statusRes);
    expect(
      statuses.map((x: { name: string; color: string }) => [x.name, x.color]),
    ).toEqual([
      ["Backlog", "#9ca3af"],
      ["Todo", "#6b7280"],
      ["Next", "#06b6d4"],
      ["In Progress", "#3b82f6"],
      ["Ready to Ship", "#f59e0b"],
      ["Shipped", "#8b5cf6"],
      ["Done", "#22c55e"],
      ["Invalid", "#475569"],
    ]);
    expect(
      statuses
        .filter((x: { category: string }) => x.category === "closed")
        .map((x: { name: string }) => x.name),
    ).toEqual(["Done", "Invalid"]);
    // A blocker clears once it ships (T-711), not only once it is verified.
    expect(
      (
        await json(
          await t.app.request(`/api/projects/${s}`, { headers: { cookie } }),
        )
      ).block_clear_status_id,
    ).toBe(statuses.find((x: { name: string }) => x.name === "Shipped").id);
    // Todo is pinned, so new issues land there rather than in Backlog.
    expect(
      statuses
        .filter((x: { is_default: boolean }) => x.is_default)
        .map((x: { name: string }) => x.name),
    ).toEqual(["Todo"]);

    const members = await json(
      await t.app.request(`/api/projects/${s}/members`, {
        headers: { cookie },
      }),
    );
    expect(members).toHaveLength(1);
    expect(members[0].role).toBe("admin");
    expect(members[0].user.login).toBe("user");
  });

  // T-148: the reference format is offered at creation instead of only in
  // settings, so a project never has to start on a spelling nobody chose.
  describe("issue reference format at creation time", () => {
    it("records the prefix as history anchored at the project's own birth", async () => {
      const s = slug();
      const project = await json(
        await postProject({ slug: s, name: `Project ${s}`, ref_prefix: "T" }),
      );
      const config = await getRefConfig(s);
      expect(config.format.prefix).toBe("T");
      expect(config.format.history).toEqual([
        { prefix: "T", effective_from: project.created_at },
      ]);
    });

    it("leaves the project on # when the prefix is omitted or null", async () => {
      const omitted = slug();
      await createProject(omitted);
      expect(await getRefConfig(omitted)).toEqual({
        format: { prefix: null, history: [] },
        autolinks: [],
      });

      const explicit = slug();
      const res = await postProject({
        slug: explicit,
        name: `Project ${explicit}`,
        ref_prefix: null,
      });
      expect(res.status).toBe(201);
      expect((await getRefConfig(explicit)).format).toEqual({
        prefix: null,
        history: [],
      });
    });

    it("refuses a malformed prefix the same way the settings PUT does", async () => {
      for (const bad of ["t", "1T", "T-X", "W".repeat(21)]) {
        const res = await postProject({
          slug: slug(),
          name: "Bad prefix",
          ref_prefix: bad,
        });
        expect(res.status).toBe(422);
      }
      // A refused creation must not have registered the slug either.
      const s = slug();
      expect(
        (await postProject({ slug: s, name: "x", ref_prefix: "t" })).status,
      ).toBe(422);
      expect(
        (await t.app.request(`/api/projects/${s}`, { headers: { cookie } }))
          .status,
      ).toBe(404);
    });

    // effective_from = created_at, so the format covers every instant the
    // project could already hold content — including its very first issue.
    it("parses the new format in content written immediately after creation", async () => {
      const s = slug();
      await postProject({ slug: s, name: `Project ${s}`, ref_prefix: "T" });
      const issue = (body: string) =>
        t.app.request(`/api/projects/${s}/issues`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ title: "t", body }),
        });
      const target = await json(await issue(""));
      await issue(`fixes T-${target.number}`);

      const timeline = await json(
        await t.app.request(
          `/api/projects/${s}/issues/${target.number}/timeline?types=referenced&limit=100`,
          { headers: { cookie } },
        ),
      );
      expect(timeline.items).toHaveLength(1);
    });
  });

  it("409s on duplicate slugs", async () => {
    const s = slug();
    await createProject(s);
    const res = await t.app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ slug: s, name: "again" }),
    });
    expect(res.status).toBe(409);
  });

  it("hides projects from non-members as 404", async () => {
    const s = slug();
    await createProject(s);
    const bob = await addUserWithToken(t.ctx, `bob-${s}`);
    const res = await t.app.request(`/api/projects/${s}`, {
      headers: bob.headers,
    });
    expect(res.status).toBe(404);
  });

  it("enforces role ranks: reader can view but not administer", async () => {
    const s = slug();
    await createProject(s);
    const bob = await addUserWithToken(t.ctx, `bob-${s}`);
    const put = await t.app.request(
      `/api/projects/${s}/members/${bob.user.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ role: "reader" }),
      },
    );
    expect(put.status).toBe(204);

    expect(
      (await t.app.request(`/api/projects/${s}`, { headers: bob.headers }))
        .status,
    ).toBe(200);
    expect(
      (
        await t.app.request(`/api/projects/${s}`, {
          method: "PATCH",
          headers: { "content-type": "application/json", ...bob.headers },
          body: JSON.stringify({ name: "hacked" }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await t.app.request(`/api/projects/${s}/statuses`, {
          method: "POST",
          headers: { "content-type": "application/json", ...bob.headers },
          body: JSON.stringify({ name: "Blocked", category: "open" }),
        })
      ).status,
    ).toBe(403);
  });

  it("lets an admin rename the project and redescribe it", async () => {
    const s = slug();
    await createProject(s);
    const patched = await json(
      await t.app.request(`/api/projects/${s}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ name: "Renamed", description: "Now with why" }),
      }),
    );
    expect(patched.name).toBe("Renamed");
    expect(patched.description).toBe("Now with why");
    expect(patched.slug).toBe(s);

    const fetched = await json(
      await t.app.request(`/api/projects/${s}`, { headers: { cookie } }),
    );
    expect(fetched.name).toBe("Renamed");
    expect(fetched.description).toBe("Now with why");
  });

  it("refuses to demote or remove the last admin", async () => {
    const s = slug();
    await createProject(s);
    const meRes = await json(
      await t.app.request("/api/me", { headers: { cookie } }),
    );
    // The self-membership rule answers first, so this guard is only reachable
    // when someone else acts on the last admin.
    const root = await addUserWithToken(t.ctx, `root-${s}`, {
      instanceAdmin: true,
    });
    const demote = await t.app.request(
      `/api/projects/${s}/members/${meRes.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", ...root.headers },
        body: JSON.stringify({ role: "reader" }),
      },
    );
    expect(demote.status).toBe(409);
    const removed = await t.app.request(
      `/api/projects/${s}/members/${meRes.id}`,
      { method: "DELETE", headers: root.headers },
    );
    expect(removed.status).toBe(409);
  });

  describe("a machine creating a project brings its owner in (T-340)", () => {
    /** login → role, because "two rows" is not what the requirement says. */
    async function rolesIn(s: string): Promise<Record<string, string>> {
      const res = await t.app.request(`/api/projects/${s}/members`, {
        headers: { cookie },
      });
      expect(res.status).toBe(200);
      return Object.fromEntries(
        (await json(res)).map(
          (m: { user: { login: string }; role: string }) => [
            m.user.login,
            m.role,
          ],
        ),
      );
    }

    async function machineWithOwner(tag: string, opts?: { root?: true }) {
      const owner = await addUserWithToken(t.ctx, `owner-${tag}`, {
        instanceAdmin: opts?.root,
      });
      const bot = await addUserWithToken(t.ctx, `bot-${tag}`, {
        kind: "machine",
        ownerId: owner.user.id,
      });
      return { owner, bot };
    }

    const createAs = (headers: Record<string, string>, s: string) =>
      t.app.request("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ slug: s, name: `Project ${s}` }),
      });

    it("writes both rows as admin, and nothing else", async () => {
      const s = slug();
      const { bot } = await machineWithOwner(s);

      expect((await createAs(bot.headers, s)).status).toBe(201);

      // The whole set, keyed by login: counting two rows would pass just as
      // happily on two machine rows, or on an owner who came in as a reader.
      expect(await rolesIn(s)).toEqual({
        [`bot-${s}`]: "admin",
        [`owner-${s}`]: "admin",
      });
    });

    it("leaves a human creator with the single row they always had", async () => {
      const s = slug();
      const alice = await addUserWithToken(t.ctx, `human-${s}`);

      expect((await createAs(alice.headers, s)).status).toBe(201);

      expect(await rolesIn(s)).toEqual({ [`human-${s}`]: "admin" });
    });

    it("writes the owner's row even when they are an instance admin", async () => {
      const s = slug();
      const { bot } = await machineWithOwner(s, { root: true });

      expect((await createAs(bot.headers, s)).status).toBe(201);

      // Their implicit admin is invisible to ensureAdminSurvives, which only
      // counts rows — so a missing row here has no symptom until the day it
      // lets the project be emptied of admins.
      expect(await rolesIn(s)).toEqual({
        [`bot-${s}`]: "admin",
        [`owner-${s}`]: "admin",
      });
    });

    it("cannot then drop the owner back out", async () => {
      const s = slug();
      const { owner, bot } = await machineWithOwner(s);
      expect((await createAs(bot.headers, s)).status).toBe(201);

      const res = await t.app.request(
        `/api/projects/${s}/members/${owner.user.id}`,
        { method: "DELETE", headers: bot.headers },
      );

      // Removing the owner pulls the machine's own row in as collateral, so
      // the admin check sees both leaving and refuses the pair outright.
      expect(res.status).toBe(409);
      expect(await rolesIn(s)).toEqual({
        [`bot-${s}`]: "admin",
        [`owner-${s}`]: "admin",
      });
    });
  });

  it("refuses to change your own membership, co-admin or not", async () => {
    const s = slug();
    await createProject(s);
    const ann = await addUserWithToken(t.ctx, `ann-${s}`);
    const bob = await addUserWithToken(t.ctx, `bob-${s}`);
    for (const who of [ann, bob]) {
      const promoted = await t.app.request(
        `/api/projects/${s}/members/${who.user.id}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ role: "admin" }),
        },
      );
      expect(promoted.status).toBe(204);
    }

    const selfDemote = await t.app.request(
      `/api/projects/${s}/members/${ann.user.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", ...ann.headers },
        body: JSON.stringify({ role: "reader" }),
      },
    );
    expect(selfDemote.status).toBe(403);
    // The role gate answers 403 as well, so the message is what tells the two
    // refusals apart.
    expect((await json(selfDemote)).error.message).toContain("your own");

    const selfRemove = await t.app.request(
      `/api/projects/${s}/members/${ann.user.id}`,
      { method: "DELETE", headers: ann.headers },
    );
    expect(selfRemove.status).toBe(403);
    expect((await json(selfRemove)).error.message).toContain("your own");

    const byCoAdmin = await t.app.request(
      `/api/projects/${s}/members/${ann.user.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", ...bob.headers },
        body: JSON.stringify({ role: "reader" }),
      },
    );
    expect(byCoAdmin.status).toBe(204);

    const root = await addUserWithToken(t.ctx, `root-self-${s}`, {
      instanceAdmin: true,
    });
    const rootSelf = await t.app.request(
      `/api/projects/${s}/members/${root.user.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", ...root.headers },
        body: JSON.stringify({ role: "reader" }),
      },
    );
    expect(rootSelf.status).toBe(403);
  });

  it("manages statuses: append position, rename conflicts, reorder, delete guard", async () => {
    const s = slug();
    const project = await createProject(s);

    const created = await json(
      await t.app.request(`/api/projects/${s}/statuses`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ name: "Blocked", category: "open" }),
      }),
    );
    expect(created.position).toBe(8);

    const rename = await t.app.request(
      `/api/projects/${s}/statuses/${created.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ name: "Todo" }),
      },
    );
    expect(rename.status).toBe(409);

    const reorder = await json(
      await t.app.request(`/api/projects/${s}/statuses/${created.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ position: 0 }),
      }),
    );
    expect(reorder.position).toBe(0);

    // Reference the status from an issue row, then deletion must 409.
    const db = await t.ctx.router.forProject({
      id: project.id,
      slug: s,
      database_url: null,
    });
    await db.insert(issues).values({
      projectId: project.id,
      number: 1,
      title: "uses status",
      statusId: created.id,
      authorId: 1,
    });
    const blocked = await t.app.request(
      `/api/projects/${s}/statuses/${created.id}`,
      { method: "DELETE", headers: { cookie } },
    );
    expect(blocked.status).toBe(409);
  });

  it("keeps a single default status and clears it on demand", async () => {
    const s = slug();
    await createProject(s);
    const listStatuses = async () =>
      json(
        await t.app.request(`/api/projects/${s}/statuses`, {
          headers: { cookie },
        }),
      );
    const patchStatus = (id: number, body: Record<string, unknown>) =>
      t.app.request(`/api/projects/${s}/statuses/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(body),
      });

    // Seeded projects start with exactly one explicit default.
    const seeded = await listStatuses();
    expect(
      seeded
        .filter((x: { is_default: boolean }) => x.is_default)
        .map((x: { name: string }) => x.name),
    ).toEqual(["Todo"]);
    const progress = seeded.find(
      (x: { name: string }) => x.name === "In Progress",
    );
    const done = seeded.find((x: { name: string }) => x.name === "Done");

    const set = await json(
      await patchStatus(progress.id, {
        is_default: true,
      }),
    );
    expect(set.is_default).toBe(true);

    // Promoting another status demotes the previous default.
    await patchStatus(done.id, { is_default: true });
    const switched = await listStatuses();
    const defaults = switched.filter(
      (x: { is_default: boolean }) => x.is_default,
    );
    expect(defaults).toHaveLength(1);
    expect(defaults[0].name).toBe("Done");

    await patchStatus(done.id, { is_default: false });
    const cleared = await listStatuses();
    expect(cleared.every((x: { is_default: boolean }) => !x.is_default)).toBe(
      true,
    );
  });

  it("manages labels with per-project name uniqueness", async () => {
    const s = slug();
    await createProject(s);
    const created = await json(
      await t.app.request(`/api/projects/${s}/labels`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ name: "bug", color: "#ff0000" }),
      }),
    );
    expect(created.name).toBe("bug");

    const dup = await t.app.request(`/api/projects/${s}/labels`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "bug" }),
    });
    expect(dup.status).toBe(409);

    const updated = await json(
      await t.app.request(`/api/projects/${s}/labels/${created.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ color: "#00ff00" }),
      }),
    );
    expect(updated.color).toBe("#00ff00");

    const del = await t.app.request(`/api/projects/${s}/labels/${created.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(del.status).toBe(204);
  });

  // The CLI addresses labels by name and splits `--label 'a,b'` into two of
  // them, so a name it could never say again must not be storable (T-136).
  describe("label names the CLI can always address back", () => {
    const postLabel = (s: string, body: unknown) =>
      t.app.request(`/api/projects/${s}/labels`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(body),
      });

    it("refuses a comma on create and on rename", async () => {
      const s = slug();
      await createProject(s);
      const refused = await postLabel(s, { name: "a,b" });
      expect(refused.status).toBe(422);
      // The reason has to survive to the caller — a CLI user needs to read
      // why, not just see a 422.
      expect((await json(refused)).error.message).toContain(
        "cannot contain a comma",
      );

      const created = await json(await postLabel(s, { name: "keeper" }));
      const renamed = await t.app.request(
        `/api/projects/${s}/labels/${created.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ name: "still,bad" }),
        },
      );
      expect(renamed.status).toBe(422);
      // The refusal must not have half-applied.
      const [after] = await json(
        await t.app.request(`/api/projects/${s}/labels`, {
          headers: { cookie },
        }),
      );
      expect(after.name).toBe("keeper");
    });

    it("stores the canonical spelling of a whitespace-y name", async () => {
      const s = slug();
      await createProject(s);
      const created = await json(
        await postLabel(s, { name: "  area:   cli " }),
      );
      expect(created.name).toBe("area: cli");

      // Canonicalization runs before the uniqueness check, so a differently
      // spaced spelling of a stored name is a duplicate, not a second label.
      expect((await postLabel(s, { name: "area:  cli" })).status).toBe(409);
    });

    it("rejects a name that canonicalizes away to nothing", async () => {
      const s = slug();
      await createProject(s);
      expect((await postLabel(s, { name: "   " })).status).toBe(422);
    });

    it("treats a name differing only in case as the same, yet lets a label change its own case", async () => {
      const s = slug();
      await createProject(s);
      const bug = await json(await postLabel(s, { name: "bug" }));
      expect((await postLabel(s, { name: "Bug" })).status).toBe(409);
      const web = await json(await postLabel(s, { name: "area:web" }));
      const renamed = await t.app.request(
        `/api/projects/${s}/labels/${web.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ name: "BUG" }),
        },
      );
      expect(renamed.status).toBe(409);
      expect((await json(renamed)).error.message).toContain(
        'label "BUG" already exists',
      );

      const recased = await t.app.request(
        `/api/projects/${s}/labels/${bug.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ name: "BUG" }),
        },
      );
      expect(recased.status).toBe(200);
      expect((await json(recased)).name).toBe("BUG");
    });

    it("lets a label resend the name it has beside a twin the database kept", async () => {
      const s = slug();
      const project = await createProject(s);
      const upper = await json(
        await postLabel(s, { name: "\u03a4\u0395\u039b\u039f\u03a3" }),
      );
      // One name to the API, two to lower(): only an upgrade leaves the pair.
      const db = await t.ctx.router.forProject({
        id: project.id,
        slug: s,
        database_url: null,
      });
      const patchLabel = (id: number, body: unknown) =>
        t.app.request(`/api/projects/${s}/labels/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify(body),
        });
      const insert = async (name: string) => {
        const [row] = await db
          .insert(labels)
          .values({ projectId: project.id, name })
          .returning({ id: labels.id });
        return (row as { id: number }).id;
      };
      const lower = await insert("\u03c4\u03b5\u03bb\u03bf\u03c2");
      const resent = await patchLabel(lower, {
        name: "\u03c4\u03b5\u03bb\u03bf\u03c2",
        color: "#000000",
      });
      expect(resent.status).toBe(200);
      expect((await json(resent)).color).toBe("#000000");
      expect(
        (await patchLabel(upper.id, { name: "\u03c4\u03b5\u03bb\u03bf\u03c2" }))
          .status,
      ).toBe(409);

      // A twin kept because only its composition differs (no NFC on the
      // database) resends its own spelling, which the API composes.
      await postLabel(s, { name: "\u00e9tat" });
      const decomposed = await insert("e\u0301tat");
      const recolored = await patchLabel(decomposed, {
        name: "e\u0301tat",
        color: "#000000",
      });
      expect(recolored.status).toBe(200);
      expect(await json(recolored)).toMatchObject({
        name: "e\u0301tat",
        color: "#000000",
      });
    });
  });

  // `issue list --status 'Done '` trims each name it is given, so a stored
  // "Done " is a status the CLI can never select: status names follow the
  // label rule above.
  describe("status names stored canonical, like label names", () => {
    const postStatus = (s: string, body: unknown) =>
      t.app.request(`/api/projects/${s}/statuses`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(body),
      });
    const patchStatus = (s: string, id: number, body: unknown) =>
      t.app.request(`/api/projects/${s}/statuses/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(body),
      });

    it("stores the canonical spelling on create, and a respaced name is a duplicate", async () => {
      const s = slug();
      await createProject(s);
      const created = await postStatus(s, {
        name: "  In   Review ",
        category: "open",
      });
      expect(created.status).toBe(201);
      expect((await json(created)).name).toBe("In Review");

      expect(
        (await postStatus(s, { name: "In Review ", category: "open" })).status,
      ).toBe(409);
    });

    it("renames to the canonical spelling, and refuses a rename that only respaces another name", async () => {
      const s = slug();
      await createProject(s);
      const blocked = await json(
        await postStatus(s, { name: "Blocked", category: "open" }),
      );
      const renamed = await patchStatus(s, blocked.id, {
        name: " Waiting   on  others ",
      });
      expect(renamed.status).toBe(200);
      expect((await json(renamed)).name).toBe("Waiting on others");

      expect((await patchStatus(s, blocked.id, { name: "Todo " })).status).toBe(
        409,
      );
    });

    it("refuses a name that is blank once trimmed, and counts the length after trimming", async () => {
      const s = slug();
      await createProject(s);
      const blank = await postStatus(s, { name: "   ", category: "open" });
      expect(blank.status).toBe(422);
      expect((await json(blank)).error.message).toContain(
        "status names cannot be blank",
      );

      const padded = await postStatus(s, {
        name: `  ${"x".repeat(60)}  `,
        category: "open",
      });
      expect(padded.status).toBe(201);
      const long = await json(padded);
      expect(long.name).toHaveLength(60);

      expect((await patchStatus(s, long.id, { name: " \t " })).status).toBe(
        422,
      );
    });

    it("treats a name differing only in case as the same, yet lets a status change its own case", async () => {
      const s = slug();
      await createProject(s);
      const board: { id: number; name: string }[] = await json(
        await t.app.request(`/api/projects/${s}/statuses`, {
          headers: { cookie },
        }),
      );
      const byName = (name: string) => {
        const found = board.find((x) => x.name === name);
        if (!found) throw new Error(`no status ${name}`);
        return found;
      };

      const created = await postStatus(s, { name: "done", category: "closed" });
      expect(created.status).toBe(409);
      expect((await json(created)).error.message).toContain(
        'status "done" already exists',
      );
      expect(
        (await patchStatus(s, byName("Todo").id, { name: "DONE" })).status,
      ).toBe(409);

      const recased = await patchStatus(s, byName("Done").id, { name: "DONE" });
      expect(recased.status).toBe(200);
      expect((await json(recased)).name).toBe("DONE");
    });

    it("lets a status resend the name it has beside a twin the database kept", async () => {
      const s = slug();
      const project = await createProject(s);
      const upper = await json(
        await postStatus(s, {
          name: "\u03a4\u0395\u039b\u039f\u03a3",
          category: "open",
        }),
      );
      // One name to the API, two to lower(): only an upgrade leaves the pair.
      const db = await t.ctx.router.forProject({
        id: project.id,
        slug: s,
        database_url: null,
      });
      const [lower] = await db
        .insert(statuses)
        .values({
          projectId: project.id,
          name: "\u03c4\u03b5\u03bb\u03bf\u03c2",
          category: "open",
          position: 99,
        })
        .returning({ id: statuses.id });
      const resent = await patchStatus(s, (lower as { id: number }).id, {
        name: "\u03c4\u03b5\u03bb\u03bf\u03c2",
        color: "#000000",
      });
      expect(resent.status).toBe(200);
      expect((await json(resent)).color).toBe("#000000");
      expect(
        (
          await patchStatus(s, upper.id, {
            name: "\u03c4\u03b5\u03bb\u03bf\u03c2",
          })
        ).status,
      ).toBe(409);

      // A twin kept because only its composition differs (no NFC on the
      // database) resends its own spelling, which the API composes.
      await postStatus(s, { name: "\u00e9tat", category: "open" });
      const [decomposed] = await db
        .insert(statuses)
        .values({
          projectId: project.id,
          name: "e\u0301tat",
          category: "open",
          position: 100,
        })
        .returning({ id: statuses.id });
      const recolored = await patchStatus(
        s,
        (decomposed as { id: number }).id,
        { name: "e\u0301tat", color: "#000000" },
      );
      expect(recolored.status).toBe(200);
      expect(await json(recolored)).toMatchObject({
        name: "e\u0301tat",
        color: "#000000",
      });
    });
  });

  describe("statuses and labels from a template", () => {
    const get = async (path: string) =>
      json(await t.app.request(`/api${path}`, { headers: { cookie } }));
    const post = (
      path: string,
      body: unknown,
      who: Record<string, string> = { cookie },
    ) =>
      t.app.request(`/api${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...who },
        body: JSON.stringify(body),
      });

    /** Everything a template decides, read back through the API. */
    async function laidOut(s: string) {
      const [statuses, project, settings, labels] = await Promise.all([
        get(`/projects/${s}/statuses`),
        get(`/projects/${s}`),
        get(`/projects/${s}/insights/settings`),
        get(`/projects/${s}/labels`),
      ]);
      return {
        statuses: statuses.map(
          (x: {
            name: string;
            category: string;
            color: string;
            is_default: boolean;
          }) => [x.name, x.category, x.color, x.is_default],
        ),
        line:
          statuses.find(
            (x: { id: number }) => x.id === project.block_clear_status_id,
          )?.name ?? null,
        source: settings.source,
        roles: Object.fromEntries(
          settings.roles.map((r: { name: string; role: string }) => [
            r.name,
            r.role,
          ]),
        ),
        labels: labels.map((l: { name: string; color: string }) => [
          l.name,
          l.color,
        ]),
      };
    }

    const body = (reviewRole: string) => ({
      statuses: [
        {
          name: "Doing",
          category: "open",
          color: "#3b82f6",
          chart_role: "remaining",
        },
        {
          name: "Review",
          category: "open",
          color: "#f59e0b",
          chart_role: reviewRole,
          block_clear: true,
        },
        {
          name: "Queued",
          category: "open",
          color: "#9ca3af",
          chart_role: "remaining",
          is_default: true,
        },
        {
          name: "Done",
          category: "closed",
          color: "#22c55e",
          chart_role: "completed",
        },
      ],
      labels: [
        { name: "area:web", color: "#0ea5e9" },
        { name: "urgent", color: "#f97316" },
      ],
    });

    async function myTemplate(content: unknown): Promise<number> {
      const res = await post("/me/project-templates", {
        name: "Mine",
        body: content,
      });
      expect(res.status).toBe(201);
      return (await json(res)).ref;
    }

    it("lays a project out the way one of my templates says", async () => {
      const template = await myTemplate(body("excluded"));
      const s = slug();
      expect((await postProject({ slug: s, name: s, template })).status).toBe(
        201,
      );

      expect(await laidOut(s)).toEqual({
        statuses: [
          ["Doing", "open", "#3b82f6", false],
          ["Review", "open", "#f59e0b", false],
          ["Queued", "open", "#9ca3af", true],
          ["Done", "closed", "#22c55e", false],
        ],
        line: "Review",
        source: "saved",
        roles: {
          Doing: "remaining",
          Review: "excluded",
          Queued: "remaining",
          Done: "completed",
        },
        labels: [
          ["area:web", "#0ea5e9"],
          ["urgent", "#f97316"],
        ],
      });
    });

    it("stores no chart roles when every one is the default", async () => {
      const template = await myTemplate(body("remaining"));
      const s = slug();
      expect((await postProject({ slug: s, name: s, template })).status).toBe(
        201,
      );
      expect((await laidOut(s)).source).toBe("default");
    });

    it("gives a project that names no template the built-in Default", async () => {
      const plain = slug();
      await createProject(plain);
      const named = slug();
      expect(
        (await postProject({ slug: named, name: named, template: "default" }))
          .status,
      ).toBe(201);

      const omitted = await laidOut(plain);
      expect(omitted.labels.map(([name]: [string]) => name)).toEqual([
        "kind:bug",
        "kind:chore",
        "kind:feature",
        "needs-brainstorm",
      ]);
      expect(await laidOut(named)).toEqual(omitted);
    });

    it("refuses a template that is not there or not mine, and leaves the slug free", async () => {
      const other = await addUserWithToken(t.ctx, `tpl-owner-${slug()}`);
      const theirs = await post(
        "/me/project-templates",
        { name: "Theirs", body: body("remaining") },
        other.headers,
      );
      expect(theirs.status).toBe(201);
      const s = slug();
      for (const template of [(await json(theirs)).ref, 999_999]) {
        const res = await postProject({ slug: s, name: s, template });
        expect(res.status).toBe(404);
        expect((await json(res)).error.message).toBe("template not found");
      }
      await createProject(s);
    });

    it("copies another project's statuses and labels", async () => {
      const source = slug();
      await createProject(source);
      const statuses = await get(`/projects/${source}/statuses`);
      const ids = statuses.map((x: { id: number }) => x.id);
      expect(
        (
          await t.app.request(`/api/projects/${source}/statuses/order`, {
            method: "PUT",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ ids: [...ids].reverse() }),
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await post(`/projects/${source}/labels`, {
            name: "area:cli",
            color: "#14b8a6",
          })
        ).status,
      ).toBe(201);

      const copy = slug();
      expect(
        (await postProject({ slug: copy, name: copy, from_project: source }))
          .status,
      ).toBe(201);
      const [from, to] = [await laidOut(source), await laidOut(copy)];
      expect(to.statuses).toEqual(from.statuses);
      expect(to.labels).toEqual(from.labels);
      expect(to.labels).toContainEqual(["area:cli", "#14b8a6"]);
    });

    it("refuses a source project the caller cannot see, and leaves the slug free", async () => {
      const source = slug();
      await createProject(source);
      const outsider = await addUserWithToken(t.ctx, `outsider-${source}`);
      const s = slug();
      const refused = await post(
        "/projects",
        { slug: s, name: s, from_project: source },
        outsider.headers,
      );
      expect(refused.status).toBe(404);
      expect(
        (await post("/projects", { slug: s, name: s }, outsider.headers))
          .status,
      ).toBe(201);
    });
  });

  describe("agents joining a new project", () => {
    const tag = placement.replaceAll(/[^a-z]/g, "");
    let owner: Awaited<ReturnType<typeof addUserWithToken>>;
    const as = (headers: Record<string, string>) => ({
      "content-type": "application/json",
      ...headers,
    });

    beforeAll(async () => {
      owner = await addUserWithToken(t.ctx, `agent-owner-${tag}`);
    });

    async function agent(name: string, joinAs: string | null = null) {
      const res = await t.app.request("/api/agents", {
        method: "POST",
        headers: as(owner.headers),
        body: JSON.stringify({ login: `${name}-${tag}`, display_name: name }),
      });
      expect(res.status).toBe(201);
      const created = await json(res);
      if (joinAs !== null) await setJoinRole(created.id, joinAs);
      return created as { id: number; login: string };
    }

    async function setJoinRole(id: number, role: string | null) {
      const res = await t.app.request(`/api/agents/${id}`, {
        method: "PATCH",
        headers: as(owner.headers),
        body: JSON.stringify({ new_project_role: role }),
      });
      expect(res.status).toBe(200);
    }

    const create = (
      body: Record<string, unknown>,
      headers: Record<string, string> = owner.headers,
    ) =>
      t.app.request("/api/projects", {
        method: "POST",
        headers: as(headers),
        body: JSON.stringify({ name: String(body.slug), ...body }),
      });

    async function rolesIn(s: string): Promise<Record<string, string>> {
      const res = await t.app.request(`/api/projects/${s}/members`, {
        headers: owner.headers,
      });
      expect(res.status).toBe(200);
      return Object.fromEntries(
        (await json(res)).map(
          (m: { user: { login: string }; role: string }) => [
            m.user.login,
            m.role,
          ],
        ),
      );
    }

    // Each test retires the join roles it set, so the next starts with none.
    async function cleared(...agents: Array<{ id: number }>) {
      for (const a of agents) await setJoinRole(a.id, null);
    }

    it("adds exactly the agents it is given", async () => {
      const one = await agent("bot-given");
      const s = slug();
      expect(
        (
          await create({
            slug: s,
            agents: [{ login: one.login, role: "writer" }],
          })
        ).status,
      ).toBe(201);
      expect(await rolesIn(s)).toEqual({
        [`agent-owner-${tag}`]: "admin",
        [one.login]: "writer",
      });
    });

    it("adds each enabled agent with a join role when given none", async () => {
      const one = await agent("bot-joins", "reporter");
      await agent("bot-stays");
      const off = await agent("bot-off", "writer");
      expect(
        (
          await t.app.request(`/api/agents/${off.id}`, {
            method: "DELETE",
            headers: owner.headers,
          })
        ).status,
      ).toBe(204);
      const s = slug();
      expect((await create({ slug: s })).status).toBe(201);
      expect(await rolesIn(s)).toEqual({
        [`agent-owner-${tag}`]: "admin",
        [one.login]: "reporter",
      });

      const none = slug();
      expect((await create({ slug: none, agents: [] })).status).toBe(201);
      expect(await rolesIn(none)).toEqual({
        [`agent-owner-${tag}`]: "admin",
      });
      await cleared(one, off);
    });

    it("refuses an agent that is not the caller's, and one named twice", async () => {
      const mine = await agent("bot-twice");
      const stranger = await addUserWithToken(t.ctx, `stranger-${tag}`, {
        kind: "machine",
        ownerId: (await addUserWithToken(t.ctx, `other-owner-${tag}`)).user.id,
      });
      const s = slug();
      const messages: string[] = [];
      for (const login of [stranger.user.login, `nobody-${tag}`]) {
        const res = await create({
          slug: s,
          agents: [{ login, role: "reader" }],
        });
        expect(res.status).toBe(422);
        messages.push((await json(res)).error.message);
      }
      expect(messages).toEqual([
        `@${stranger.user.login} is not one of your agents`,
        `@nobody-${tag} is not one of your agents`,
      ]);
      const twice = await create({
        slug: s,
        agents: [
          { login: mine.login, role: "reader" },
          { login: mine.login, role: "writer" },
        ],
      });
      expect(twice.status).toBe(422);
      expect((await create({ slug: s })).status).toBe(201);
    });

    it("brings a machine creator's fellow agents, and not the creator twice", async () => {
      const creator = await agent("bot-creator", "writer");
      const fellow = await agent("bot-fellow", "reporter");
      const token = await t.app.request(`/api/agents/${creator.id}/tokens`, {
        method: "POST",
        headers: as(owner.headers),
        body: JSON.stringify({ name: "create" }),
      });
      expect(token.status).toBe(201);
      const s = slug();
      expect(
        (
          await create(
            { slug: s },
            { authorization: `Bearer ${(await json(token)).token}` },
          )
        ).status,
      ).toBe(201);
      expect(await rolesIn(s)).toEqual({
        [`agent-owner-${tag}`]: "admin",
        [creator.login]: "admin",
        [fellow.login]: "reporter",
      });
      await cleared(creator, fellow);
    });
  });

  it("deletes a project and its insights roles before it stops routing", async () => {
    const s = slug();
    const project = await createProject(s);
    const db = await t.ctx.router.forProject({
      id: project.id,
      slug: s,
      database_url: null,
    });
    const settings = await json(
      await t.app.request(`/api/projects/${s}/insights/settings`, {
        headers: { cookie },
      }),
    );
    const saved = await t.app.request(`/api/projects/${s}/insights/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        version: settings.version,
        roles: settings.roles.map(
          (entry: { status_id: number; role: string }, index: number) => ({
            status_id: entry.status_id,
            role: index === 0 ? "excluded" : entry.role,
          }),
        ),
      }),
    });
    expect(saved.status).toBe(200);
    const stored = () =>
      db
        .select()
        .from(insightsSettings)
        .where(eq(insightsSettings.projectId, project.id));
    expect(await stored()).toHaveLength(1);

    const del = await t.app.request(`/api/projects/${s}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(del.status).toBe(204);
    expect(
      (await t.app.request(`/api/projects/${s}`, { headers: { cookie } }))
        .status,
    ).toBe(404);
    expect(await stored()).toHaveLength(0);
  });
});

describe("provision failure compensation", () => {
  it("removes the registry row when project-db provisioning fails", async () => {
    const t = await makeTestApp("dedicated", {
      // /dev/null cannot contain a data directory — provisioning must fail.
      urlTemplate: "pglite:///dev/null/nope-${project.id}",
    });
    try {
      const cookie = await t.login();
      const res = await t.app.request("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ slug: "doomed", name: "Doomed" }),
      });
      expect(res.status).toBe(500);
      const rows = await t.ctx.router.system().select().from(projects);
      expect(rows).toHaveLength(0);
    } finally {
      await t.cleanup();
    }
  });
});
