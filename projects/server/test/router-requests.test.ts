import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "./helpers.ts";
import { testTmpDir } from "./setup.ts";

function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

let t: TestApp | undefined;

afterEach(async () => {
  await t?.cleanup();
  t = undefined;
});

// File-backed, because a pglite://memory handle is never evicted; worker
// hosted, because that is what dedicated placement runs by default.
it("keeps a request's databases open while other requests open more", async () => {
  const dir = testTmpDir("todou-router-requests-");
  const paused = gate();
  const resume = gate();
  t = await makeTestApp(
    "dedicated",
    {
      maxOpen: 2,
      workers: true,
      urlTemplate: `pglite://${dir}/p\${project.id}`,
    },
    {
      // Between the freeze and the copy no statement is running on either
      // database, so only the request's hold can keep them open.
      afterMoveStep: async (step) => {
        if (step !== 2) return;
        paused.open();
        await resume.wait;
      },
    },
  );
  const cookie = await t.login();
  const request = (path: string, body?: unknown) =>
    (t as TestApp).app.request(`/api${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  // c and d first: by the time the move starts they have been evicted.
  for (const slug of ["c", "d", "a", "b"]) {
    expect((await request("/projects", { slug, name: slug })).status).toBe(201);
  }
  expect(
    (await request("/projects/a/issues", { title: "moving" })).status,
  ).toBe(201);

  const move = request("/projects/a/issues/1/move", { to_project: "b" });
  await paused.wait;
  // Each opens a database the cache has no room for.
  expect((await request("/projects/c/issues")).status).toBe(200);
  expect((await request("/projects/d/issues")).status).toBe(200);
  resume.open();
  expect((await move).status).toBe(200);
}, 60_000);

// max_open = 1 and three other projects: a request that held every database
// it went through would leave four open, one that lets each go when done
// leaves at most max_open plus the one it works in.
describe("a request going through many project databases", () => {
  const MAX_OPEN = 1;
  const TARGETS = ["t1", "t2", "t3"];

  async function setup() {
    const dir = testTmpDir("todou-router-fanout-");
    const app = await makeTestApp("dedicated", {
      maxOpen: MAX_OPEN,
      urlTemplate: `pglite://${dir}/p\${project.id}`,
    });
    t = app;
    const cookie = await app.login();
    const request = (path: string, method = "GET", body?: unknown) =>
      app.app.request(`/api${path}`, {
        method,
        headers: { "content-type": "application/json", cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    for (const slug of ["home", ...TARGETS]) {
      expect(
        (await request("/projects", "POST", { slug, name: slug })).status,
      ).toBe(201);
    }
    for (const slug of ["home", ...TARGETS]) {
      expect(
        (await request(`/projects/${slug}/issues`, "POST", { title: slug }))
          .status,
      ).toBe(201);
    }
    return { app, cookie, request };
  }

  it("lets each referenced project go once its references are checked and recorded", async () => {
    const { app, request } = await setup();
    const body = TARGETS.map((slug) => `${slug}#1`).join(", ");
    expect(
      (await request("/projects/home/issues", "POST", { title: "refs", body }))
        .status,
    ).toBe(201);
    expect(app.ctx.router.openHandleCount()).toBeLessThanOrEqual(MAX_OPEN + 1);
    const timeline = await request("/projects/t3/issues/1/timeline?limit=100");
    expect(JSON.stringify(await timeline.json())).toContain("referenced");
  }, 120_000);

  it("lets each blocked card's project go once its event has landed", async () => {
    const { app, request } = await setup();
    for (const slug of TARGETS) {
      expect(
        (
          await request(`/projects/${slug}/issues/1/blocked-by`, "POST", {
            ref: "home#1",
          })
        ).status,
      ).toBe(200);
    }
    const statuses = (await (
      await request("/projects/home/statuses")
    ).json()) as {
      id: number;
      name: string;
    }[];
    const done = statuses.find((s) => s.name === "Done");
    expect(
      (
        await request("/projects/home/issues/1", "PATCH", {
          status_id: done?.id,
        })
      ).status,
    ).toBe(200);
    expect(app.ctx.router.openHandleCount()).toBeLessThanOrEqual(MAX_OPEN + 1);
    const timeline = await request("/projects/t3/issues/1/timeline?limit=100");
    expect(JSON.stringify(await timeline.json())).toContain("block_cleared");
  }, 120_000);

  it("lets each project go once a deleted project's files are looked up in it", async () => {
    const { app, cookie, request } = await setup();
    const form = new FormData();
    form.set("file", new File(["potato"], "notes.txt", { type: "text/plain" }));
    form.set("issue_number", "1");
    const uploaded = await app.app.request("/api/projects/home/attachments", {
      method: "POST",
      headers: { cookie },
      body: form,
    });
    expect(uploaded.status).toBe(201);
    const scanned: string[] = [];
    const forProject = app.ctx.router.forProject.bind(app.ctx.router);
    app.ctx.router.forProject = async (project) => {
      scanned.push(project.slug);
      return forProject(project);
    };
    expect((await request("/projects/home", "DELETE")).status).toBe(204);
    // The deleted project's files were looked for in every other database.
    expect(scanned).toEqual(expect.arrayContaining(TARGETS));
    expect(app.ctx.router.openHandleCount()).toBeLessThanOrEqual(MAX_OPEN + 1);
  }, 120_000);
});
