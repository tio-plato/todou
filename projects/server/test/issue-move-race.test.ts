import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { TestHooks } from "../src/bootstrap.ts";
import { issueMoves } from "../src/db/system-schema.ts";
import { makeTestApp, PLACEMENTS, type TestApp } from "./helpers.ts";

// biome-ignore lint/suspicious/noExplicitAny: test-side response poking
const json = (res: Response): Promise<any> => res.json() as Promise<any>;

type Who = Record<string, string>;

const PG_URL = process.env.TODOU_TEST_POSTGRES_URL;

/**
 * A move against a competing move, trash or edit (T-666).
 *
 * The hooks put the competitor on a chosen side of each gap: committed
 * after the move planned but before it took the card, or after the trash
 * checked but before it wrote. Shared placement exercises the single
 * transaction, the other two the freeze. PGlite serialises every
 * transaction on one connection, so only real postgres has the trash
 * actually wait on the move's row lock — the simultaneous cases are the
 * ones that run there.
 */
describe.each(PLACEMENTS)("move races (%s placement)", (placement) => {
  races(placement, placement !== "shared", (hooks) =>
    makeTestApp(placement, undefined, hooks),
  );
});

describe.skipIf(!PG_URL)("move races on real postgres", () => {
  // The database persists across runs; unique slugs isolate each one.
  races(`pg-${Date.now().toString(36)}`, false, (hooks) =>
    makeTestApp("shared", { systemUrl: PG_URL }, hooks),
  );
});

/** `crossDb`: whether this placement's moves take the step-by-step path. */
function races(
  tag: string,
  crossDb: boolean,
  open: (hooks: TestHooks) => Promise<TestApp>,
) {
  let t: TestApp;
  let admin: Who;
  const A = `race-a-${tag}`;
  const B = `race-b-${tag}`;
  const C = `race-c-${tag}`;

  /** Each hook fires once, so the competitor it starts does not re-enter it. */
  const pending: {
    afterMovePlan?: () => Promise<void>;
    beforeTrashWrite?: () => Promise<void>;
  } = {};
  const once = (key: keyof typeof pending) => async () => {
    const run = pending[key];
    delete pending[key];
    await run?.();
  };
  /** The next move to finish `step` stops there until released. */
  let pause:
    | { step: number; reached: () => void; release: Promise<void> }
    | undefined;
  /** Moves that finish step 2 wait here until `size` of them have. */
  let gate:
    | { size: number; arrived: number; open: () => void; opened: Promise<void> }
    | undefined;
  const hooks: TestHooks = {
    afterMovePlan: once("afterMovePlan"),
    beforeTrashWrite: once("beforeTrashWrite"),
    afterMoveStep: async (step) => {
      const held = pause;
      if (held?.step === step) {
        pause = undefined;
        held.reached();
        await held.release;
        return;
      }
      if (gate !== undefined && step === 2) {
        const waiting = gate;
        waiting.arrived += 1;
        if (waiting.arrived === waiting.size) waiting.open();
        await waiting.opened;
      }
    },
  };
  const pauseAfter = (step: number) => {
    let reached = () => {};
    let release = () => {};
    const atStep = new Promise<void>((resolve) => {
      reached = resolve;
    });
    pause = {
      step,
      reached,
      release: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    return { atStep, release: () => release() };
  };
  const reach = (atStep: Promise<void>, moving: Promise<Response>) =>
    Promise.race([
      atStep,
      moving.then((res) => {
        throw new Error(`the move ended before its pause: ${res.status}`);
      }),
    ]);
  /**
   * Runs `moves` with every one of them held after step 2 until all have
   * got there. A move that ends without getting there opens the gate too,
   * so the others fail instead of waiting out the timeout.
   */
  const together = async (moves: Array<() => Promise<Response>>) => {
    let open = () => {};
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    gate = { size: moves.length, arrived: 0, open, opened };
    try {
      return await Promise.all(moves.map((run) => run().finally(open)));
    } finally {
      gate = undefined;
    }
  };

  const req = (path: string, init?: RequestInit) =>
    Promise.resolve(
      t.app.request(`/api${path}`, {
        ...init,
        headers: init?.body
          ? { "content-type": "application/json", ...admin }
          : admin,
      }),
    );
  const createIssue = async (title: string, slug = A) => {
    const res = await req(`/projects/${slug}/issues`, {
      method: "POST",
      body: JSON.stringify({ title, body: "body" }),
    });
    expect(res.status).toBe(201);
    return (await json(res)) as { number: number };
  };
  const move = (number: number, to: string, from = A) =>
    req(`/projects/${from}/issues/${number}/move`, {
      method: "POST",
      body: JSON.stringify({ to_project: to }),
    });
  const trash = (number: number) =>
    req(`/projects/${A}/issues/${number}`, { method: "DELETE" });
  /** Live cards titled `title` in `slug`, by number. */
  const liveIn = async (slug: string, title: string) =>
    (await json(await req(`/projects/${slug}/issues?limit=100`))).items
      .filter((i: { title: string }) => i.title === title)
      .map((i: { number: number }) => i.number);

  beforeAll(async () => {
    t = await open(hooks);
    admin = { cookie: await t.login() };
    for (const slug of [A, B, C]) {
      const res = await req("/projects", {
        method: "POST",
        body: JSON.stringify({ slug, name: slug }),
      });
      expect(res.status).toBe(201);
    }
  });

  afterAll(async () => {
    await t.cleanup();
  });

  // A test that fails before its move reaches the pause or plans would
  // otherwise leave them set for whichever move comes next.
  afterEach(() => {
    pause = undefined;
    delete pending.afterMovePlan;
    delete pending.beforeTrashWrite;
  });

  it("refuses a move whose card another move took after it planned", async () => {
    const card = await createIssue("contested");
    let second: Response | undefined;
    pending.afterMovePlan = async () => {
      second = await move(card.number, C);
    };

    const first = await move(card.number, B);
    expect(second?.status).toBe(200);
    expect(first.status).toBe(409);
    expect((await json(first)).error.code).toBe("issue_moved");
    expect(await liveIn(B, "contested")).toEqual([]);
    expect(await liveIn(C, "contested")).toHaveLength(1);
    const source = await req(`/projects/${A}/issues/${card.number}`);
    expect(source.status).toBe(301);
    expect(source.headers.get("location")).toContain(`/projects/${C}/`);
  });

  it("refuses a move whose card went to the trash after it planned", async () => {
    const card = await createIssue("trashed mid-move");
    let trashed: Response | undefined;
    pending.afterMovePlan = async () => {
      trashed = await trash(card.number);
    };

    const res = await move(card.number, B);
    expect(trashed?.status).toBe(204);
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("issue_deleted");
    expect(await liveIn(B, "trashed mid-move")).toEqual([]);
    // Still in the trash where it was put, and still restorable.
    const source = await json(
      await req(`/projects/${A}/issues/${card.number}`),
    );
    expect(source.deleted_at).not.toBeNull();
    expect(
      (
        await req(`/projects/${A}/issues/${card.number}/restore`, {
          method: "POST",
        })
      ).status,
    ).toBe(200);
  });

  it("refuses a trash whose card moved after it checked", async () => {
    const card = await createIssue("moved mid-trash");
    let moved: Response | undefined;
    pending.beforeTrashWrite = async () => {
      moved = await move(card.number, B);
    };

    const res = await trash(card.number);
    expect(moved?.status).toBe(200);
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("issue_moved");
    expect(await liveIn(B, "moved mid-trash")).toHaveLength(1);
    // The tombstone was not marked deleted behind the redirect.
    expect((await req(`/projects/${A}/issues/${card.number}`)).status).toBe(
      301,
    );
  });

  it("refuses to trash a tombstone", async () => {
    const card = await createIssue("already gone");
    expect((await move(card.number, B)).status).toBe(200);
    const res = await trash(card.number);
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("issue_moved");
    expect(await liveIn(B, "already gone")).toHaveLength(1);
  });

  it("carries an edit made after the move planned", async () => {
    for (const slug of [A, B]) {
      const res = await req(`/projects/${slug}/labels`, {
        method: "POST",
        body: JSON.stringify({ name: `late-${tag}` }),
      });
      expect(res.status).toBe(201);
    }
    const labelA = (await json(await req(`/projects/${A}/labels`))).find(
      (l: { name: string }) => l.name === `late-${tag}`,
    );
    const statusesA = await json(await req(`/projects/${A}/statuses`));
    const done = statusesA.find((s: { name: string }) => s.name === "Done");
    expect(done).toBeDefined();
    const card = await createIssue("before the edit");
    pending.afterMovePlan = async () => {
      const res = await req(`/projects/${A}/issues/${card.number}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: "after the edit",
          status_id: done.id,
          label_ids: [labelA.id],
        }),
      });
      expect(res.status).toBe(200);
    };

    const res = await move(card.number, B);
    expect(res.status).toBe(200);
    const result = await json(res);
    // The response describes the move that happened, not the plan before it.
    expect(result.mapping.status).toEqual({ from: "Done", to: "Done" });
    expect(result.issue.title).toBe("after the edit");
    expect(result.issue.status.name).toBe("Done");
    expect(result.issue.labels.map((l: { name: string }) => l.name)).toEqual([
      `late-${tag}`,
    ]);
  });

  const ROUNDS = 5;

  it("lets exactly one of two simultaneous moves through", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const title = `simultaneous ${round}`;
      const card = await createIssue(title);
      const results = await Promise.all([
        move(card.number, B),
        move(card.number, C),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const copies = [...(await liveIn(B, title)), ...(await liveIn(C, title))];
      expect(copies).toHaveLength(1);
    }
  });

  // A card's first move mints its lineage, and every card minting one in
  // the same project goes through the same placeholder address row.
  it("lands every first move out of one project at once", async () => {
    const cards = [];
    for (let i = 0; i < 4; i++) cards.push(await createIssue(`first ${i}`));
    const results = await together(
      cards.map((card) => () => move(card.number, B)),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    const landed = new Set<string>();
    for (const card of cards) {
      const source = await req(`/projects/${A}/issues/${card.number}`);
      expect(source.status).toBe(301);
      const location = source.headers.get("location") ?? "";
      expect(location).toMatch(new RegExp(`^/api/projects/${B}/issues/\\d+$`));
      landed.add(location);
    }
    expect(landed.size).toBe(4);
  });

  // Each copy holds a transaction in its destination, which is the other
  // move's source: a copy reading its source inside it waits for the other
  // copy to commit, which is waiting for it.
  it("lands two cards moving opposite ways at once", async () => {
    const x = await createIssue("eastbound", A);
    const y = await createIssue("westbound", B);
    for (let k = 0; k < 3; k++) {
      for (const [slug, card] of [
        [A, x],
        [B, y],
      ] as const) {
        const res = await req(
          `/projects/${slug}/issues/${card.number}/comments`,
          { method: "POST", body: JSON.stringify({ body: `note ${k}` }) },
        );
        expect(res.status).toBe(201);
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const results = await Promise.race([
      together([() => move(x.number, B, A), () => move(y.number, A, B)]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("the two moves hung")),
          10_000,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const [east, west] = await Promise.all(results.map(json));
    expect(east.moved_to.slug).toBe(B);
    expect(west.moved_to.slug).toBe(A);
  });

  // The copy is a live card from step 3, but its address is published only
  // at step 4 and its source emptied only at step 5. A move planned in
  // between reads an address book that does not know the copy yet.
  it.skipIf(!crossDb).each([3, 4, 5])(
    "refuses to move a card still arriving after step %i",
    async (step) => {
      const title = `arriving after ${step}`;
      const card = await createIssue(title);
      const paused = pauseAfter(step);
      const first = move(card.number, B);
      await reach(paused.atStep, first);
      const [copy] = await liveIn(B, title);
      const preview = await req(`/projects/${B}/issues/${copy}/move`, {
        method: "POST",
        body: JSON.stringify({ to_project: A, dry_run: true }),
      });
      const back = await move(copy, A, B);
      paused.release();
      const arrived = await first;

      for (const res of [preview, back]) {
        expect(res.status).toBe(409);
        expect((await json(res)).error.code).toBe("issue_moving");
      }
      expect(arrived.status).toBe(200);
      expect((await json(arrived)).moved_to).toEqual({ slug: B, number: copy });

      const again = await move(copy, A, B);
      expect(again.status).toBe(200);
      const result = await json(again);
      expect(result.reinhabited).toBe(true);
      expect(result.moved_to.number).toBe(card.number);
      const old = await req(`/projects/${B}/issues/${copy}`);
      expect(old.status).toBe(301);
      expect(old.headers.get("location")).toBe(
        `/api/projects/${A}/issues/${card.number}`,
      );
    },
  );

  it.skipIf(!crossDb)(
    "refuses a card that started arriving again after the move planned",
    async () => {
      const title = "arriving again";
      const card = await createIssue(title);
      let away = 0;
      let back: Promise<Response> | undefined;
      let paused: { release: () => void } | undefined;
      // The card leaves for C and is on its way back into the same row when
      // the planned move takes it.
      pending.afterMovePlan = async () => {
        const out = await move(card.number, C);
        expect(out.status).toBe(200);
        away = (await json(out)).moved_to.number;
        const held = pauseAfter(3);
        paused = held;
        back = move(away, A, C);
        await reach(held.atStep, back);
      };

      const res = await move(card.number, B);
      paused?.release();
      const returned = await back;
      expect(res.status).toBe(409);
      expect((await json(res)).error.code).toBe("issue_moving");
      expect(returned?.status).toBe(200);
      expect((await json(returned as Response)).reinhabited).toBe(true);
      // The refused move let go of the card it had frozen.
      expect((await req(`/projects/${A}/issues/${card.number}`)).status).toBe(
        200,
      );
      const comment = await req(
        `/projects/${A}/issues/${card.number}/comments`,
        { method: "POST", body: JSON.stringify({ body: "still writable" }) },
      );
      expect(comment.status).toBe(201);
      const old = await req(`/projects/${C}/issues/${away}`);
      expect(old.status).toBe(301);
      expect(old.headers.get("location")).toBe(
        `/api/projects/${A}/issues/${card.number}`,
      );
      expect(await liveIn(B, title)).toEqual([]);
    },
  );

  // A move whose source project is deleted after step 3 never finishes, so
  // its registration row is never done; the copy must not inherit that.
  it.skipIf(!crossDb)(
    "moves a copy whose source project was deleted mid-move",
    async () => {
      const D = `race-d-${tag}`;
      const created = await req("/projects", {
        method: "POST",
        body: JSON.stringify({ slug: D, name: D }),
      });
      expect(created.status).toBe(201);
      const card = await createIssue("orphaned copy", D);
      const paused = pauseAfter(3);
      const first = move(card.number, B, D);
      await reach(paused.atStep, first);
      const [copy] = await liveIn(B, "orphaned copy");
      expect((await req(`/projects/${D}`, { method: "DELETE" })).status).toBe(
        204,
      );
      paused.release();
      // How the interrupted move answers is not what this pins.
      await first;
      expect((await move(copy, C, B)).status).toBe(200);
    },
  );

  // A move the races above left unfinished stays named in the history every
  // later copy of the card carries; only the latest arrival can be in flight.
  it("moves a card whose earlier arrival never finished", async () => {
    const card = await createIssue("old arrival");
    const there = await move(card.number, B);
    expect(there.status).toBe(200);
    const k = (await json(there)).moved_to.number;
    const on = await move(k, C, B);
    expect(on.status).toBe(200);
    const m = (await json(on)).moved_to.number;
    const from = (await json(await req(`/projects/${A}`))).id;
    const first = and(
      eq(issueMoves.fromProjectId, from),
      eq(issueMoves.fromNumber, card.number),
    );
    const setFirst = (state: "copying" | "done") =>
      t.ctx.router
        .system()
        .update(issueMoves)
        .set({ state })
        .where(first)
        .returning({ id: issueMoves.id });
    expect(await setFirst("copying")).toHaveLength(1);

    const back = await move(m, A, C);
    await setFirst("done");
    expect(back.status).toBe(200);
    const result = await json(back);
    expect(result.reinhabited).toBe(true);
    expect(result.moved_to.number).toBe(card.number);
  });

  // The plan reads the card's address before the move holds the card; a
  // round trip in between leaves a tombstone the plan never saw.
  it("takes the tombstone a card left after the move planned", async () => {
    const card = await createIssue("away and back");
    let away = 0;
    pending.afterMovePlan = async () => {
      const out = await move(card.number, B);
      expect(out.status).toBe(200);
      away = (await json(out)).moved_to.number;
      const back = await move(away, A, B);
      expect(back.status).toBe(200);
      expect((await json(back)).reinhabited).toBe(true);
    };

    const res = await move(card.number, B);
    expect(res.status).toBe(200);
    const result = await json(res);
    expect(result.reinhabited).toBe(true);
    expect(result.moved_to.number).toBe(away);
    const source = await req(`/projects/${A}/issues/${card.number}`);
    expect(source.status).toBe(301);
    expect(source.headers.get("location")).toBe(
      `/api/projects/${B}/issues/${away}`,
    );
  });

  it("never answers both a move and a trash with success", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const title = `move or trash ${round}`;
      const card = await createIssue(title);
      const [m, d] = await Promise.all([
        move(card.number, B),
        trash(card.number),
      ]);
      // Whichever commits first wins; the other is refused, never both.
      expect([m.status, d.status].sort().join()).toMatch(/^(200,409|204,409)$/);
      expect(await liveIn(B, title)).toHaveLength(m.status === 200 ? 1 : 0);
    }
  });
}
