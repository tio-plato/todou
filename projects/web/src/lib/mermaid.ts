/**
 * Colors a diagram is drawn in, already resolved to `#rrggbb`: mermaid's
 * color math (khroma) cannot parse the app's oklch() custom properties.
 */
export type DiagramPalette = {
  dark: boolean;
  background: string;
  foreground: string;
  muted: string;
  mutedForeground: string;
  border: string;
};

export type DiagramResult =
  | { ok: true; svg: string; width: number; height: number }
  | { ok: false; error: string };

type Mermaid = typeof import("mermaid")["default"];

// mermaid is the heaviest optional dependency (T-523); like @pierre/diffs it
// is only ever reached through this dynamic import, so its chunks are fetched
// the first time a page actually holds a diagram.
let loaded: Promise<Mermaid> | undefined;
function loadMermaid(): Promise<Mermaid> {
  loaded ??= import("mermaid").then((m) => m.default);
  return loaded;
}

// `initialize` is global state, so a render for one palette must not
// interleave with a render for another: every call waits for the last.
let queue: Promise<unknown> = Promise.resolve();
let sequence = 0;

export function renderDiagram(
  source: string,
  palette: DiagramPalette,
  fontFamily: string,
): Promise<DiagramResult> {
  const run = queue.then(async (): Promise<DiagramResult> => {
    const mermaid = await loadMermaid();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      layout: "elk",
      theme: "base",
      fontFamily,
      themeVariables: themeVariables(palette, fontFamily),
    });
    const scratch = scratchHost();
    try {
      // parse() first: a source that does not parse would otherwise be
      // drawn as mermaid's error diagram before render() throws the same
      // message.
      await mermaid.parse(source);
      // mermaid's ELK layout spins forever, before ELK itself even starts,
      // on a diagram whose nesting loops back on itself where an edge
      // touches it, and the queue and the page spin with it.
      const error = nestingCycleError(
        source,
        (await mermaid.mermaidAPI.getDiagramFromText(source)).db,
      );
      if (error !== null) return { ok: false, error };
      const { svg } = await mermaid.render(
        `mermaid-${++sequence}`,
        source,
        scratch,
      );
      return { ok: true, svg, ...viewBoxSize(svg) };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      scratch.remove();
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

type LayoutData = {
  nodes: {
    id: string;
    parentId?: string;
    isGroup?: boolean;
    label?: string;
    shape?: string;
  }[];
  edges: { start?: string; end?: string }[];
};

/**
 * The error for a diagram with an edge that runs into a nesting loop, or
 * null. mermaid files every name a block mentions under that block, so a
 * line in A's block that names A puts A inside A. The parent table is built
 * the way mermaid's layout builds it: keyed by id, and written only for a
 * parent that is a group.
 */
function nestingCycleError(source: string, db: object): string | null {
  if (!("getData" in db) || typeof db.getData !== "function") return null;
  const { nodes, edges } = db.getData() as LayoutData;
  const parent = new Map<string, string>();
  for (const group of nodes) {
    if (!group.isGroup) continue;
    for (const node of nodes) {
      if (node.parentId === group.id) parent.set(node.id, group.id);
    }
  }
  // The loop the walk up from `id` ends in, from the first name it repeats,
  // child first, or null once the walk reaches the top.
  const loopAbove = (id: string): string[] | null => {
    const path: string[] = [];
    for (let at: string | undefined = id; at !== undefined; ) {
      const first = path.indexOf(at);
      if (first !== -1) return path.slice(first);
      path.push(at);
      at = parent.get(at);
    }
    return null;
  };
  // The first loop an edge runs into, and whether the edge's own line is
  // the one that closed it.
  const find = (): { loop: string[]; known: boolean } | null => {
    for (const { start, end } of edges) {
      if (start === end) continue;
      const ends = [start, end].filter((id) => id !== undefined);
      // An end on the loop itself first. When both ends share a block, the
      // edge was written in it, and that line is what put this end there.
      for (const id of ends) {
        const loop = loopAbove(id);
        if (loop?.[0] !== id) continue;
        const other = ends.find((each) => each !== id);
        const known =
          other !== undefined && parent.get(other) === parent.get(id);
        return { loop, known };
      }
      for (const id of ends) {
        const loop = loopAbove(id);
        if (loop !== null) return { loop, known: false };
      }
    }
    return null;
  };
  const found = find();
  if (found === null) return null;

  const byId = new Map(nodes.map((node) => [node.id, node]));
  // A concurrent region is nameless, and its composite's block is all
  // regions: a line moved to another region stays in that block, so the
  // region counts as its composite.
  const blocks = found.loop.filter((id) => byId.get(id)?.shape !== "divider");
  // A generated id (a subgraph titled with spaces gets `subGraph0`) is
  // nowhere in the source, but its title is.
  const names = blocks.map((id) => {
    const label = byId.get(id)?.label;
    return source.includes(id) || !label ? id : `"${label}"`;
  });
  const ring = [...names, names[0]];
  const cycle = `Nesting cycle: ${ring.join(" inside ")}.`;
  if (found.known || names.length === 1) {
    return `${cycle} Move the lines in ${ring[1]}'s block that name ${ring[0]} out of that block.`;
  }
  // The table cannot tell a block's own declaration from a mention of it,
  // so each step of the loop is offered; any one of them breaks or
  // shortens it.
  const moves = names.map(
    (child, i) => `the lines in ${ring[i + 1]}'s block that name ${child}`,
  );
  const last = moves.pop();
  return `${cycle} Move one of these out of its block: ${moves.join(", ")}${moves.length > 1 ? "," : ""} or ${last}.`;
}

/**
 * Where mermaid draws a diagram to measure it (T-703). Left to itself it
 * appends that scratch drawing to the end of <body>, in flow, where it stays
 * on screen below the page for as long as layout takes — a whole queue of
 * diagrams on a long card — and for good if drawing throws. Hidden rather
 * than `display: none`, because text is measured with getBBox(), which needs
 * a layout box.
 */
export function scratchHost(): HTMLDivElement {
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText =
    "position:fixed;top:0;left:0;width:100%;visibility:hidden;pointer-events:none";
  document.body.append(host);
  return host;
}

function themeVariables(p: DiagramPalette, fontFamily: string) {
  return {
    darkMode: p.dark,
    fontFamily,
    background: p.background,
    primaryColor: p.muted,
    primaryTextColor: p.foreground,
    primaryBorderColor: p.mutedForeground,
    secondaryColor: p.muted,
    tertiaryColor: p.background,
    mainBkg: p.muted,
    nodeBorder: p.mutedForeground,
    textColor: p.foreground,
    nodeTextColor: p.foreground,
    lineColor: p.mutedForeground,
    clusterBkg: p.background,
    clusterBorder: p.border,
    edgeLabelBackground: p.background,
    titleColor: p.foreground,
    noteBkgColor: p.muted,
    noteTextColor: p.foreground,
    noteBorderColor: p.border,
  };
}

/** The diagram's natural size, which the fit rule in styles.css scales from. */
export function viewBoxSize(svg: string): { width: number; height: number } {
  const match =
    /viewBox="[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(svg);
  return match
    ? { width: Number(match[1]), height: Number(match[2]) }
    : { width: 0, height: 0 };
}

/**
 * mermaid's parse errors quote the offending line and draw a caret under it,
 * which only lines up in the monospace block the error came from. One line
 * is what fits under the source: where it failed, and what it got there.
 */
export function errorSummary(message: string): string {
  const lines = message
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length <= 1) return lines[0] ?? "";
  const got = lines.at(-1) ?? "";
  return /^Parse error/.test(lines[0] ?? "") && /got /.test(got)
    ? `${lines[0]} ${got}`
    : (lines[0] ?? "");
}
