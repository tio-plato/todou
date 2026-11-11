// Lock-order stress bench for PostgreSQL. Runs the real app in this process
// (bootstrap + createApp, requests through app.request, as the tests do),
// fires random concurrent writes at every write endpoint, and reports whether
// any transaction deadlocked or any request hung.
//
//   TODOU_DATABASE_SYSTEM=postgres://user@host/db node bench/lock-stress.ts
//   node bench/lock-stress.ts --seconds 30 --workers 16 --json out.json
//
// Configuration comes from the app's own environment variables, never from a
// todou.toml: TODOU_DATABASE_SYSTEM (postgres:// only),
// TODOU_DATABASE_PROJECTS_PLACEMENT, TODOU_DATABASE_PROJECTS_URL_TEMPLATE and
// TODOU_DATABASE_POOL_MAX; TODOU_DATABASE_AUTO_MIGRATE defaults to true here.
// The system database must hold no projects yet, and every database a
// template names must already exist. Files go to a scratch directory. A
// bucketed template such as `postgres://…/db_b${project.id % 2}` keeps the
// number of databases fixed while projects are created and deleted, and a
// move between two projects in one bucket takes the copy that shares the
// project database.
//
// The pool is the app's own, 10 connections per database unless
// TODOU_DATABASE_POOL_MAX says otherwise; 40 brings out far more lock waits.
// The pool size times the number of databases has to stay under the server's
// max_connections, 100 by default.
//
// To widen the windows between locks, this bench (and only this bench)
// monkey-patches pg.Client.prototype.query to wait a random 0..--jitter-ms
// before each statement. One connection's statements still go out in the
// order they were sent.
//
// Deadlocks are counted two ways. The total is the change in
// pg_stat_database.deadlocks over every database involved. The breakdown
// counts the statements aborted with SQLSTATE 40P01, by their text, which
// also catches the deadlocks that never become a 500: the project cleanup,
// the block announcements, the draft reaper and the housekeeping tick log
// their failures and carry on. A request still pending after --hang-ms counts
// as hung and is abandoned so the run can end. Exits 1 on any deadlock or
// hang; 5xx responses are listed but leave the exit code alone.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import pg from "pg";
import { createApp } from "../src/app.ts";
import { bootstrap } from "../src/bootstrap.ts";
import { loadConfig } from "../src/config.ts";
import { users } from "../src/db/system-schema.ts";
import { runHousekeepingTick } from "../src/services/housekeeping.ts";
import { sweepMoves } from "../src/services/move/execute.ts";
import { reapDraftAttachments } from "../src/services/storage-admin.ts";
import { issueToken } from "../src/services/tokens.ts";

const { values: flags } = parseArgs({
  options: {
    seconds: { type: "string", default: "90" },
    workers: { type: "string", default: "48" },
    "jitter-ms": { type: "string", default: "10" },
    cards: { type: "string", default: "3" },
    "hang-ms": { type: "string", default: "20000" },
    json: { type: "string" },
  },
});

/** A flag's value as a number, or the run stops: NaN would run nothing. */
function count(name: keyof typeof flags, min: number): number {
  const value = Number(flags[name]);
  if (!Number.isInteger(value) || value < min) {
    console.error(`--${name} must be a whole number of at least ${min}`);
    process.exit(2);
  }
  return value;
}
const SECONDS = count("seconds", 1);
const WORKERS = count("workers", 1);
const JITTER_MS = count("jitter-ms", 0);
/** Cards made in each project before the run starts. */
const CARDS = count("cards", 1);
const HANG_MS = count("hang-ms", 1);

const systemUrl = process.env.TODOU_DATABASE_SYSTEM ?? "";
if (!/^postgres(ql)?:\/\//.test(systemUrl)) {
  console.error(
    "TODOU_DATABASE_SYSTEM must be a postgres:// URL: deadlocks are read from pg_stat_database, which PGlite does not have",
  );
  process.exit(2);
}

// The draft reaper runs at a zero-hour threshold over every project the
// system database registers, so a database with projects of its own would
// lose every unsent draft. Checked before the app migrates anything.
{
  const client = new pg.Client({ connectionString: systemUrl });
  await client.connect();
  try {
    // The table the app's unqualified queries reach, and the one in public.
    const present = await client.query<{ here: boolean; public: boolean }>(
      `SELECT to_regclass('projects') IS NOT NULL AS here,
              to_regclass('public.projects') IS NOT NULL AS public`,
    );
    const any = async (sql: string) =>
      (await client.query(sql)).rows.length > 0;
    const found =
      (present.rows[0]?.here === true &&
        (await any("SELECT 1 FROM projects LIMIT 1"))) ||
      (present.rows[0]?.public === true &&
        (await any("SELECT 1 FROM public.projects LIMIT 1")));
    if (found) {
      console.error(
        "TODOU_DATABASE_SYSTEM must name an empty database: this bench deletes every draft in every project it finds there",
      );
      process.exit(2);
    }
  } finally {
    await client.end();
  }
}

// ——— statement jitter and aborted statements ————————————————————————————

/** Statements aborted by the deadlock detector, by their text. */
const aborted = new Map<string, number>();
let injecting = false;

type Patched = { lockStressTurn?: Promise<void> };
const proto = pg.Client.prototype as unknown as {
  query: (this: Patched, ...args: unknown[]) => unknown;
};
const query = proto.query;
proto.query = function (this: Patched, ...args: unknown[]) {
  const first = args[0] as string | { text?: string } | undefined;
  const text = typeof first === "string" ? first : first?.text;
  const note = (err: unknown) => {
    if ((err as { code?: unknown } | null)?.code !== "40P01") return;
    const key = String(text).replace(/\s+/g, " ").trim().slice(0, 120);
    aborted.set(key, (aborted.get(key) ?? 0) + 1);
  };
  const last = args.at(-1);
  if (typeof last === "function") {
    args[args.length - 1] = (err: unknown, ...rest: unknown[]) => {
      note(err);
      return last(err, ...rest);
    };
  }
  const send = () => {
    const result = query.apply(this, args);
    if (result instanceof Promise) result.catch(note);
    return result;
  };
  if (!injecting || JITTER_MS <= 0) return send();
  const delay = Math.random() * JITTER_MS;
  const turn = (this.lockStressTurn ?? Promise.resolve()).then(
    () => new Promise<void>((resolve) => setTimeout(resolve, delay)),
  );
  this.lockStressTurn = turn;
  if (typeof last === "function") {
    void turn.then(send);
    return undefined;
  }
  return turn.then(send);
};

// ——— the app ————————————————————————————————————————————————————————————

const storagePath = await mkdtemp(join(tmpdir(), "todou-lock-stress-"));
const config = loadConfig({
  tomlSource: "",
  env: {
    ...process.env,
    // Files go to a scratch directory, whatever backend the environment names.
    TODOU_STORAGE_BACKEND: "fs",
    TODOU_STORAGE_PATH: storagePath,
    TODOU_DATABASE_AUTO_MIGRATE:
      process.env.TODOU_DATABASE_AUTO_MIGRATE ?? "true",
  },
});
const ctx = await bootstrap(config);
const app = createApp(ctx);

type User = { id: number; login: string; headers: { authorization: string } };
type Card = { id: number; number: number };

const stamp = Date.now().toString(36);

async function addUser(login: string): Promise<User> {
  const [row] = await ctx.router
    .system()
    .insert(users)
    .values({ kind: "human", login, displayName: login })
    .returning();
  if (!row) throw new Error("user insert returned no row");
  const token = await issueToken(ctx.router.system(), row.id, {
    name: `${login}-token`,
  });
  return {
    id: row.id,
    login,
    headers: { authorization: `Bearer ${token.token}` },
  };
}

const request = (
  user: User,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> =>
  Promise.resolve(
    app.request(`/api${path}`, {
      method,
      headers: {
        ...user.headers,
        ...(body === undefined || body instanceof FormData
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(body === undefined
        ? {}
        : { body: body instanceof FormData ? body : JSON.stringify(body) }),
    }),
  );

// biome-ignore lint/suspicious/noExplicitAny: response poking
const json = async (response: Response): Promise<any> => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

// ——— deadlock totals ————————————————————————————————————————————————————

/** pg_stat_database.deadlocks of each database involved, at first sight. */
const deadlocksBefore = new Map<string, number>();

async function deadlocksOf(url: string): Promise<number> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query<{ deadlocks: string }>(
      "SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()",
    );
    return Number(result.rows[0]?.deadlocks ?? 0);
  } finally {
    await client.end();
  }
}

/** Starts counting the database a project lives in, if it is a new one. */
async function track(projectId: number, slug: string): Promise<string> {
  const url = ctx.router.resolveProjectUrl({
    id: projectId,
    slug,
    database_url: null,
  });
  if (!deadlocksBefore.has(url)) {
    deadlocksBefore.set(url, -1);
    deadlocksBefore.set(url, await deadlocksOf(url));
  }
  return url;
}

deadlocksBefore.set(systemUrl, await deadlocksOf(systemUrl));

// ——— fixtures ———————————————————————————————————————————————————————————

const owner = await addUser(`lk-${stamp}-alice`);
const people = [owner, await addUser(`lk-${stamp}-bob`)];
// Three, so that under a bucketed template two of them share a database and
// the moves between them take the copy that shares the project database.
const slugs = ["a", "b", "c"].map((name) => `lk-${stamp}-${name}`);
const projectIds = new Map<number, string>();
const projectDbs = new Set<string>();

/** A project both people administer; returns where it lives. */
async function createProject(slug: string): Promise<[number, string]> {
  const created = await request(owner, "POST", "/projects", {
    slug,
    name: slug,
  });
  if (created.status !== 201) {
    throw new Error(
      `creating ${slug}: ${created.status} ${await created.text()}`,
    );
  }
  const id = (await json(created)).id as number;
  const url = await track(id, slug);
  const added = await request(owner, "POST", `/projects/${slug}/members`, {
    login: (people[1] as User).login,
    role: "admin",
  });
  if (added.status >= 300) throw new Error(`adding a member: ${added.status}`);
  return [id, url];
}

for (const slug of slugs) {
  const [id, url] = await createProject(slug);
  projectIds.set(id, slug);
  projectDbs.add(url);
  for (let i = 0; i < CARDS; i++) {
    await request(owner, "POST", `/projects/${slug}/issues`, {
      title: `card ${i}`,
    });
  }
  for (const name of ["l1", "l2", "l3"]) {
    await request(owner, "POST", `/projects/${slug}/labels`, { name });
  }
}
// Renamed over and over by the workload; never written otherwise, so the
// other operations keep their slugs.
const [renamed] = await createProject(`lk-${stamp}-r`);

// Plain connections for reading the fixtures back, outside the app's pools.
const observer = new pg.Client({ connectionString: systemUrl });
await observer.connect();
const projectClients = await Promise.all(
  [...projectDbs].map(async (url) => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    return client;
  }),
);

/** One query over every project database, the rows put together. */
async function projectQuery<R extends pg.QueryResultRow>(
  text: string,
  params: unknown[],
): Promise<R[]> {
  const parts = await Promise.all(
    projectClients.map((client) => client.query<R>(text, params)),
  );
  return parts.flatMap((part) => part.rows);
}

/** What the workload picks from, re-read every few hundred milliseconds. */
const live = {
  cards: new Map<string, Card[]>(),
  trashed: new Map<string, number[]>(),
  comments: [] as Array<{
    slug: string;
    number: number;
    id: number;
    type: string;
  }>,
  attachments: [] as Array<{
    slug: string;
    id: number;
    draft: boolean;
    uploader: number;
  }>,
  edges: [] as Array<{ slug: string; number: number; edgeId: number }>,
  labels: new Map<string, number[]>(),
  statuses: new Map<string, number[]>(),
  specs: [] as Array<{ slug: string; number: number; version: number }>,
};

const push = <K, V>(map: Map<K, V[]>, key: K, value: V) =>
  map.set(key, [...(map.get(key) ?? []), value]);

async function refresh(): Promise<void> {
  const ids = [...projectIds.keys()];
  const slugOfId = (id: string) => projectIds.get(Number(id)) as string;
  const cards = await projectQuery<{
    project_id: string;
    id: string;
    number: string;
    deleted: boolean;
  }>(
    `SELECT project_id, id, number, deleted_at IS NOT NULL AS deleted
     FROM issues WHERE project_id = ANY($1) AND moved_at IS NULL`,
    [ids],
  );
  const nextCards = new Map<string, Card[]>();
  const nextTrashed = new Map<string, number[]>();
  const byId = new Map<number, { slug: string; number: number }>();
  for (const row of cards) {
    const slug = slugOfId(row.project_id);
    byId.set(Number(row.id), { slug, number: Number(row.number) });
    if (row.deleted) push(nextTrashed, slug, Number(row.number));
    else
      push(nextCards, slug, { id: Number(row.id), number: Number(row.number) });
  }
  live.cards = nextCards;
  live.trashed = nextTrashed;

  const comments = await projectQuery<{
    issue_id: string;
    id: string;
    type: string | null;
  }>(
    `SELECT issue_id, id, component->>'type' AS type FROM comments
     WHERE project_id = ANY($1) ORDER BY id DESC LIMIT 400`,
    [ids],
  );
  live.comments = comments.flatMap((row) => {
    const card = byId.get(Number(row.issue_id));
    return card === undefined
      ? []
      : [{ ...card, id: Number(row.id), type: row.type ?? "plain" }];
  });

  const attachments = await projectQuery<{
    project_id: string;
    id: string;
    draft: boolean;
    uploader_id: string;
  }>(
    `SELECT project_id, id, draft, uploader_id FROM attachments
     WHERE project_id = ANY($1) ORDER BY id DESC LIMIT 200`,
    [ids],
  );
  live.attachments = attachments.map((row) => ({
    slug: slugOfId(row.project_id),
    id: Number(row.id),
    draft: row.draft,
    uploader: Number(row.uploader_id),
  }));

  const edges = await observer.query<{
    id: string;
    blocked_project_id: string;
    blocked_number: string;
  }>(
    `SELECT id, blocked_project_id, blocked_number FROM issue_blocks
     WHERE blocked_project_id = ANY($1) ORDER BY id DESC LIMIT 100`,
    [ids],
  );
  live.edges = edges.rows.map((row) => ({
    slug: slugOfId(row.blocked_project_id),
    number: Number(row.blocked_number),
    edgeId: Number(row.id),
  }));

  const labels = await projectQuery<{ project_id: string; id: string }>(
    "SELECT project_id, id FROM labels WHERE project_id = ANY($1)",
    [ids],
  );
  live.labels = new Map();
  for (const row of labels)
    push(live.labels, slugOfId(row.project_id), Number(row.id));

  const statuses = await projectQuery<{ project_id: string; id: string }>(
    "SELECT project_id, id FROM statuses WHERE project_id = ANY($1)",
    [ids],
  );
  live.statuses = new Map();
  for (const row of statuses) {
    push(live.statuses, slugOfId(row.project_id), Number(row.id));
  }

  const specs = await projectQuery<{ issue_id: string; version: string }>(
    `SELECT issue_id, max(number) AS version FROM spec_versions
     WHERE project_id = ANY($1) GROUP BY issue_id`,
    [ids],
  );
  live.specs = specs.flatMap((row) => {
    const card = byId.get(Number(row.issue_id));
    return card === undefined
      ? []
      : [{ ...card, version: Number(row.version) }];
  });
}

await refresh();

// ——— the workload ———————————————————————————————————————————————————————

const pick = <T>(values: readonly T[]): T | undefined =>
  values.length === 0
    ? undefined
    : values[Math.floor(Math.random() * values.length)];
const chance = (p: number) => Math.random() < p;
const slugOf = () => pick(slugs) as string;
const otherSlug = (slug: string) =>
  pick(slugs.filter((s) => s !== slug)) as string;
const cardOf = (slug: string) => pick(live.cards.get(slug) ?? []);
const personOf = () => pick(people) as User;
const on = (slug: string, number: number, path = "") =>
  `/projects/${slug}/issues/${number}${path}`;

/** Up to two references, one in five into another project. */
function refsIn(slug: string): string {
  const out: string[] = [];
  const n = Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) {
    if (chance(0.2)) {
      const other = otherSlug(slug);
      const card = cardOf(other);
      if (card) out.push(`${other}#${card.number}`);
    } else {
      const card = cardOf(slug);
      if (card) out.push(`#${card.number}`);
    }
  }
  return out.join(" ");
}

/** A link to one of the writer's own drafts, two times in five. */
function draftLink(slug: string, user: User): string {
  if (chance(0.6)) return "";
  const draft = pick(
    live.attachments.filter(
      (a) => a.slug === slug && a.draft && a.uploader === user.id,
    ),
  );
  return draft ? ` [f](/api/projects/${slug}/attachments/${draft.id})` : "";
}

const textFor = (slug: string, user: User) =>
  `stress ${refsIn(slug)}${draftLink(slug, user)}`;

function someComments(slug: string, number: number, type?: string): number[] {
  const all = live.comments.filter(
    (c) =>
      c.slug === slug &&
      c.number === number &&
      (type === undefined || c.type === type),
  );
  const out = new Set<number>();
  const n = 1 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n && all.length > 0; i++) {
    out.add((pick(all) as { id: number }).id);
  }
  return [...out];
}

function uploadForm(number: number | null, draft: boolean): FormData {
  const form = new FormData();
  form.set(
    "file",
    new File([`b${Math.random()}`], `f${Math.floor(Math.random() * 4)}.txt`, {
      type: "text/plain",
    }),
  );
  if (number !== null) form.set("issue_number", String(number));
  if (draft) form.set("draft", "true");
  return form;
}

const questions = {
  type: "questions",
  questions: [
    { question: "Which?", options: [{ label: "a" }, { label: "b" }] },
  ],
};

/** The first 5xx of a batch, or else the last response. */
const worstOf = (responses: Response[]): Response =>
  responses.find((r) => r.status >= 500) ?? (responses.at(-1) as Response);

type Op = (user: User) => Promise<Response | null>;
/** Each operation and its weight; null means it found nothing to act on. */
const ops: Record<string, [number, Op]> = {
  comment: [
    8,
    async (u) => {
      const s = slugOf();
      const c = cardOf(s);
      if (!c) return null;
      return request(u, "POST", on(s, c.number, "/comments"), {
        body: textFor(s, u),
      });
    },
  ],
  ask: [
    3,
    async (u) => {
      const s = slugOf();
      const c = cardOf(s);
      if (!c) return null;
      return request(u, "POST", on(s, c.number, "/comments"), {
        body: `q ${refsIn(s)}`,
        component: questions,
      });
    },
  ],
  answer: [
    3,
    async (u) => {
      const q = pick(live.comments.filter((c) => c.type === "questions"));
      if (!q) return null;
      return request(
        u,
        "POST",
        on(q.slug, q.number, `/comments/${q.id}/answers`),
        { answers: [{ key: "q1", selected: [Math.floor(Math.random() * 2)] }] },
      );
    },
  ],
  withdraw: [
    2,
    async (u) => {
      const q = pick(live.comments.filter((c) => c.type === "questions"));
      if (!q) return null;
      return request(
        u,
        "POST",
        on(q.slug, q.number, `/comments/${q.id}/questions/withdraw`),
        { reason: "moot" },
      );
    },
  ],
  editComment: [
    4,
    async (u) => {
      const c = pick(live.comments.filter((c) => c.type === "plain"));
      if (!c) return null;
      return request(u, "PATCH", on(c.slug, c.number, `/comments/${c.id}`), {
        body: textFor(c.slug, u),
      });
    },
  ],
  deleteComment: [
    2,
    async (u) => {
      const c = pick(live.comments);
      if (!c) return null;
      return request(u, "DELETE", on(c.slug, c.number, `/comments/${c.id}`));
    },
  ],
  hide: [
    3,
    async (u) => {
      const s = slugOf();
      const c = cardOf(s);
      if (!c) return null;
      const ids = someComments(s, c.number);
      if (ids.length === 0) return null;
      return request(u, "POST", on(s, c.number, "/comments/hide"), {
        hidden: chance(0.7),
        comment_ids: ids,
      });
    },
  ],
  commandHide: [
    2,
    async (u) => {
      const s = slugOf();
      const c = cardOf(s);
      if (!c) return null;
      const ids = someComments(s, c.number);
      if (ids.length === 0) return null;
      return request(u, "POST", on(s, c.number, "/commands"), {
        body: chance(0.5) ? "" : textFor(s, u),
        commands: [{ type: "comments_hide", hidden: true, comment_ids: ids }],
      });
    },
  ],
  commandMisc: [
    3,
    async (u) => {
      const s = slugOf();
      const c = cardOf(s);
      if (!c) return null;
      const label = pick(live.labels.get(s) ?? []);
      const status = pick(live.statuses.get(s) ?? []);
      const who = personOf();
      const command = pick([
        ...(label === undefined
          ? []
          : [
              { type: "label_add", label_id: label },
              { type: "label_remove", label_id: label },
            ]),
        { type: "assign", user_id: who.id },
        { type: "unassign", user_id: who.id },
        ...(status === undefined
          ? []
          : [{ type: "status", status_id: status }]),
      ]);
      return request(u, "POST", on(s, c.number, "/commands"), {
        body: chance(0.5) ? "" : textFor(s, u),
        commands: [command],
      });
    },
  ],
  // A command that takes a label off and puts it back, while the label is
  // deleted and another one made.
  relabel: [
    1,
    async (u) => {
      const s = slugOf();
      const c = cardOf(s);
      const label = pick(live.labels.get(s) ?? []);
      if (!c || label === undefined || (live.labels.get(s) ?? []).length < 4) {
        return null;
      }
      const added = await request(u, "POST", on(s, c.number, "/commands"), {
        body: "",
        commands: [{ type: "label_add", label_id: label }],
      });
      if (added.status !== 200) return added;
      const raced = await Promise.all([
        request(u, "POST", on(s, c.number, "/commands"), {
          body: "",
          commands: [
            { type: "label_remove", label_id: label },
            { type: "label_add", label_id: label },
          ],
        }),
        request(u, "DELETE", `/projects/${s}/labels/${label}`),
      ]);
      const made = await request(u, "POST", `/projects/${s}/labels`, {
        name: `x${Math.floor(Math.random() * 1e9)}`,
      });
      return worstOf([...raced, made]);
    },
  ],
  editIssue: [
    5,
    async (u) => {
      const s = slugOf();
      const c = cardOf(s);
      if (!c) return null;
      const r = Math.random();
      const body =
        r < 0.3
          ? { body: textFor(s, u) }
          : r < 0.5
            ? { title: `t${Math.random()}` }
            : r < 0.7
              ? {
                  assignee_ids: people
                    .filter(() => chance(0.5))
                    .map((p) => p.id),
                }
              : r < 0.85
                ? {
                    label_ids: (live.labels.get(s) ?? []).filter(() =>
                      chance(0.5),
                    ),
                  }
                : { status_id: pick(live.statuses.get(s) ?? []) };
      return request(u, "PATCH", on(s, c.number), body);
    },
  ],
  createIssue: [
    2,
    async (u) => {
      const s = slugOf();
      return request(u, "POST", `/projects/${s}/issues`, {
        title: `new ${Math.random()}`,
        body: textFor(s, u),
      });
    },
  ],
  trash: [
    1,
    async (u) => {
      const s = slugOf();
      const c = cardOf(s);
      if (!c || (live.cards.get(s) ?? []).length < 4) return null;
      return request(u, "DELETE", on(s, c.number));
    },
  ],
  restore: [
    2,
    async (u) => {
      const s = slugOf();
      const n = pick(live.trashed.get(s) ?? []);
      if (n === undefined) return null;
      return request(u, "POST", on(s, n, "/restore"));
    },
  ],
  move: [
    1,
    async (u) => {
      const s = slugOf();
      const c = cardOf(s);
      if (!c || (live.cards.get(s) ?? []).length < 4) return null;
      return request(u, "POST", on(s, c.number, "/move"), {
        to_project: otherSlug(s),
      });
    },
  ],
  metadata: [
    3,
    async (u) => {
      const s = slugOf();
      const c = cardOf(s);
      if (!c) return null;
      return request(u, "PATCH", on(s, c.number, "/metadata"), {
        entries: [
          {
            namespace: "orch",
            key: `k${Math.floor(Math.random() * 3)}`,
            value: `${Math.random()}`,
          },
        ],
      });
    },
  ],
  blockAdd: [
    2,
    async (u) => {
      const s = slugOf();
      const c = cardOf(s);
      const other = chance(0.2) ? otherSlug(s) : s;
      const d = cardOf(other);
      if (!c || !d || c.id === d.id) return null;
      return request(
        u,
        "POST",
        on(s, c.number, chance(0.5) ? "/blocked-by" : "/blocks"),
        { ref: other === s ? `#${d.number}` : `${other}#${d.number}` },
      );
    },
  ],
  blockRemove: [
    1,
    async (u) => {
      const e = pick(live.edges);
      if (!e) return null;
      return request(
        u,
        "DELETE",
        on(e.slug, e.number, `/blocked-by/${e.edgeId}`),
      );
    },
  ],
  upload: [
    3,
    async (u) => {
      const s = slugOf();
      const c = cardOf(s);
      if (!c) return null;
      return request(
        u,
        "POST",
        `/projects/${s}/attachments`,
        uploadForm(c.number, chance(0.6)),
      );
    },
  ],
  looseDraft: [
    1,
    async (u) =>
      request(
        u,
        "POST",
        `/projects/${slugOf()}/attachments`,
        uploadForm(null, true),
      ),
  ],
  deleteAttachment: [
    2,
    async (u) => {
      const a = pick(
        live.attachments.filter((a) => a.uploader === u.id || !a.draft),
      );
      if (!a) return null;
      return request(u, "DELETE", `/projects/${a.slug}/attachments/${a.id}`);
    },
  ],
  specPush: [
    2,
    async (u) => {
      const s = slugOf();
      const c = cardOf(s);
      if (!c) return null;
      return request(u, "POST", on(s, c.number, "/spec/push"), {
        files: [{ path: "design.md", body: `One ${Math.random()}.\nTwo.\n` }],
      });
    },
  ],
  specReview: [
    2,
    async (u) => {
      const spec = pick(live.specs);
      if (!spec) return null;
      return request(u, "POST", on(spec.slug, spec.number, "/spec/reviews"), {
        version: spec.version,
        verdict: "comment",
        comments: [
          {
            anchor: {
              version: spec.version,
              path: "design.md",
              line_start: 1,
              line_end: 1,
            },
            body: `note ${refsIn(spec.slug)}`,
          },
        ],
      });
    },
  ],
  specWithdraw: [
    1,
    async (u) => {
      const spec = pick(live.specs);
      if (!spec) return null;
      return request(u, "POST", on(spec.slug, spec.number, "/spec/withdraw"), {
        version: spec.version,
      });
    },
  ],
  specResolve: [
    2,
    async (u) => {
      const spec = pick(live.specs);
      if (!spec) return null;
      const ids = someComments(spec.slug, spec.number, "spec_comment");
      if (ids.length === 0) return null;
      return request(
        u,
        "POST",
        on(spec.slug, spec.number, "/spec/comments/resolve"),
        { comment_ids: ids },
      );
    },
  ],
  read: [
    3,
    async (u) => {
      const s = slugOf();
      const c = cardOf(s);
      if (!c) return null;
      return request(u, "PUT", on(s, c.number, "/read"), {});
    },
  ],
  // Two of the same reader's "mark all read" at once.
  bulkRead: [
    1,
    async (u) =>
      worstOf(
        await Promise.all([
          request(u, "PUT", "/me/read", { projects: slugs }),
          request(u, "PUT", "/me/read", { projects: [...slugs].reverse() }),
        ]),
      ),
  ],
  mute: [
    1,
    async (u) => {
      const s = slugOf();
      const c = cardOf(s);
      if (!c) return null;
      return chance(0.5)
        ? request(u, "PUT", on(s, c.number, "/mute"), {
            mode: chance(0.5) ? "forever" : "until_activity",
          })
        : request(u, "DELETE", on(s, c.number, "/mute"));
    },
  ],
  labelChurn: [
    1,
    async (u) => {
      const s = slugOf();
      if (chance(0.5)) {
        return request(u, "POST", `/projects/${s}/labels`, {
          name: `x${Math.floor(Math.random() * 1e9)}`,
        });
      }
      const label = pick(live.labels.get(s) ?? []);
      if (label === undefined || (live.labels.get(s) ?? []).length < 4) {
        return null;
      }
      return request(u, "DELETE", `/projects/${s}/labels/${label}`);
    },
  ],
  // Two renames of one project at once.
  rename: [
    1,
    async (u) => {
      const at = () => `lk-${stamp}-r${Math.floor(Math.random() * 1e9)}`;
      return worstOf(
        await Promise.all([
          request(u, "PATCH", `/projects/${renamed}`, { slug: at() }),
          request(u, "PATCH", `/projects/${renamed}`, { slug: at() }),
        ]),
      );
    },
  ],
  // A project deleted while its cards are being written to.
  projectChurn: [
    1,
    async () => {
      const slug = `lk-${stamp}-x${Math.floor(Math.random() * 1e9)}`;
      await createProject(slug);
      const cards: Card[] = [];
      for (let i = 0; i < 3; i++) {
        const created = await request(
          owner,
          "POST",
          `/projects/${slug}/issues`,
          {
            title: `x${i}`,
          },
        );
        if (created.status === 201) cards.push(await json(created));
      }
      const asked: number[] = [];
      for (const card of cards) {
        const created = await request(
          owner,
          "POST",
          on(slug, card.number, "/comments"),
          { body: "q", component: questions },
        );
        if (created.status === 201) asked.push((await json(created)).id);
      }
      const refs = cards.map((d) => `#${d.number}`);
      const writes = cards.flatMap((card, i) => [
        request(owner, "POST", on(slug, card.number, "/comments"), {
          body: refs.join(" "),
        }),
        request(owner, "POST", on(slug, card.number, "/comments/hide"), {
          hidden: true,
          comment_ids: asked.slice(i, i + 1),
        }),
        request(owner, "PATCH", on(slug, card.number), {
          body: [...refs].reverse().join(" "),
        }),
        request(owner, "PUT", on(slug, card.number, "/read"), {}),
      ]);
      const deleted = request(owner, "DELETE", `/projects/${slug}`);
      return worstOf(await Promise.all([...writes, deleted]));
    },
  ],
  readTimeline: [
    2,
    async (u) => {
      const s = slugOf();
      const c = cardOf(s);
      if (!c) return null;
      return request(u, "GET", on(s, c.number, "/timeline?limit=50"));
    },
  ],
};

const enabled = Object.entries(ops);
const totalWeight = enabled.reduce((n, [, [weight]]) => n + weight, 0);
function choose(): readonly [string, Op] {
  let r = Math.random() * totalWeight;
  for (const [name, [weight, op]] of enabled) {
    r -= weight;
    if (r < 0) return [name, op];
  }
  const [name, [, op]] = enabled[0] as [string, [number, Op]];
  return [name, op];
}

// ——— the run ————————————————————————————————————————————————————————————

const statuses = new Map<string, Record<string, number>>();
const failures: Array<{ op: string; status: number; body: unknown }> = [];
const hangs: Array<{ op: string; activity: unknown }> = [];
const tally = (op: string, key: string) => {
  const counts = statuses.get(op) ?? {};
  counts[key] = (counts[key] ?? 0) + 1;
  statuses.set(op, counts);
};

const until = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([
    promise,
    new Promise<undefined>((resolve) =>
      setTimeout(() => resolve(undefined), ms),
    ),
  ]);

let stopped = false;
const refresher = (async () => {
  while (!stopped) {
    await until(
      refresh().catch(() => undefined),
      5000,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
})();
// The draft reaper at a zero-hour threshold, the housekeeping tick and the
// move recovery, which the server runs on an interval of its own, back to
// back for the whole run.
const chores = (async () => {
  while (!stopped) {
    await reapDraftAttachments(ctx.router, ctx.storage, {
      dryRun: false,
      minAgeHours: 0,
      log: (line) => {
        if (line.startsWith("FAIL")) {
          failures.push({ op: "reaper", status: -2, body: line });
        }
      },
    }).catch((cause) =>
      failures.push({ op: "reaper", status: -2, body: String(cause) }),
    );
    await runHousekeepingTick(ctx).catch((cause) =>
      failures.push({ op: "tick", status: -2, body: String(cause) }),
    );
    await sweepMoves(ctx).catch((cause) =>
      failures.push({ op: "sweep", status: -2, body: String(cause) }),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
})();

async function activity(): Promise<unknown> {
  return until(
    observer
      .query(
        `SELECT pid, datname, state, wait_event_type, wait_event,
                pg_blocking_pids(pid) AS blockers,
                now() - xact_start AS xact_age, left(query, 200) AS query
         FROM pg_stat_activity WHERE state <> 'idle'`,
      )
      .then((result) => result.rows)
      .catch((cause) => String(cause)),
    5000,
  );
}

const started = Date.now();
const deadline = started + SECONDS * 1000;
injecting = true;
async function worker(): Promise<void> {
  while (Date.now() < deadline) {
    const [name, op] = choose();
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      op(personOf()).then(
        (response) => ({ kind: "done" as const, response }),
        (cause) => ({ kind: "threw" as const, cause }),
      ),
      new Promise<{ kind: "hung" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "hung" }), HANG_MS);
      }),
    ]);
    clearTimeout(timer);
    if (outcome.kind === "hung") {
      tally(name, "hung");
      // Abandoned: a request that waits on a lock forever never settles.
      if (hangs.length < 5)
        hangs.push({ op: name, activity: await activity() });
      else hangs.push({ op: name, activity: null });
      continue;
    }
    if (outcome.kind === "threw") {
      tally(name, "threw");
      failures.push({ op: name, status: -1, body: String(outcome.cause) });
      continue;
    }
    if (outcome.response === null) {
      tally(name, "skipped");
      continue;
    }
    const status = outcome.response.status;
    tally(name, String(status));
    if (status >= 500) {
      failures.push({ op: name, status, body: await json(outcome.response) });
    } else {
      await outcome.response.body?.cancel().catch(() => undefined);
    }
  }
}
await Promise.all(Array.from({ length: WORKERS }, worker));
injecting = false;
stopped = true;
await until(Promise.all([refresher, chores]), 10_000);

// Closing the pools ends their backends, which flushes the statistics the
// totals are read from. A hung request keeps its connection, so the close is
// given up on after a while.
await Promise.allSettled([
  observer.end(),
  ...projectClients.map((c) => c.end()),
]);
await until(ctx.router.close(), 10_000);
await new Promise((resolve) => setTimeout(resolve, 1500));

const byDatabase: Record<string, number> = {};
for (const [url, before] of deadlocksBefore) {
  const name = new URL(url).pathname.slice(1);
  byDatabase[name] = (await deadlocksOf(url)) - before;
}
const total = Object.values(byDatabase).reduce((n, d) => n + d, 0);
const hungByOp: Record<string, number> = {};
for (const hang of hangs) hungByOp[hang.op] = (hungByOp[hang.op] ?? 0) + 1;

const result = {
  config: {
    seconds: SECONDS,
    workers: WORKERS,
    jitterMs: JITTER_MS,
    cards: CARDS,
    hangMs: HANG_MS,
    placement: config.database.projects.placement,
    poolMax: config.database.pool.max,
  },
  deadlocks: {
    total,
    byDatabase,
    byStatement: Object.fromEntries([...aborted].sort(([, a], [, b]) => b - a)),
  },
  hangs: { total: hangs.length, byOp: hungByOp, samples: hangs.slice(0, 5) },
  statuses: Object.fromEntries(
    [...statuses].sort(([a], [b]) => a.localeCompare(b)),
  ),
  failures: { total: failures.length, list: failures },
};

if (flags.json !== undefined) {
  await writeFile(flags.json, `${JSON.stringify(result, null, 2)}\n`);
}
await rm(storagePath, { recursive: true, force: true });

console.log(
  `${SECONDS}s, ${WORKERS} workers, ${config.database.projects.placement} placement, pool ${config.database.pool.max}`,
);
console.log(`deadlocks: ${total}`, byDatabase);
for (const [statement, count] of Object.entries(result.deadlocks.byStatement)) {
  console.log(`  ${count}  ${statement}`);
}
console.log(`hung requests: ${hangs.length}`, hungByOp);
console.log(`5xx and other failures: ${failures.length}`);
for (const failure of failures.slice(0, 20)) {
  console.log(
    `  ${failure.op} ${failure.status} ${JSON.stringify(failure.body)}`,
  );
}
process.exit(total > 0 || aborted.size > 0 || hangs.length > 0 ? 1 : 0);
