// Print planning: pick a generation range and split the tree into pages so that every
// branch (and sub-branch) sits on one page at a readable size.
import { buildModel, positionModel, drawLayout, svgDefs, el, toFa, cardHeight } from "./tree.js";

// Printable area in CSS px (96dpi) after 8mm margins, minus the page header and legend.
export const PAPERS = {
  a4l: { label: "A4 افقی", size: "A4 landscape", w: 1062, h: 733 },
  a4p: { label: "A4 عمودی", size: "A4 portrait", w: 733, h: 1062 },
  a3l: { label: "A3 افقی", size: "A3 landscape", w: 1527, h: 1062 },
  a3p: { label: "A3 عمودی", size: "A3 portrait", w: 1062, h: 1527 },
};
const HEADER_H = 52;
const FOOTER_H = 40;

// Space for the per-page note list: a column beside the tree, or a band under it on portrait paper.
const NOTES_SIDE_W = 300;
const NOTES_BAND_H = 230;
/** Note lines printed inside each card in "card" mode. */
const CARD_NOTE_LINES = 3;

/** Readable-size presets: the smallest scale cards may be printed at. */
export const SIZES = { small: 0.42, medium: 0.58, large: 0.78 };

/**
 * Build the block forest of the whole family once, with generation numbers.
 * @param {import('./kinship.js').Family} fam
 */
/**
 * @param {{orientation:string, notes:'card'|'list'|'none'}} opts
 */
export function prepare(fam, { orientation, notes }) {
  const model = buildModel(fam, fam, { duplicates: true });
  const hasNotes = [...fam.people.values()].some((p) => p.notes);
  const noteLines = notes === "card" && hasNotes ? CARD_NOTE_LINES : 0;
  const cardH = cardHeight(noteLines);
  const full = positionModel(model, { orientation, cardH });
  full.rows.forEach((r, i) => r.blocks.forEach((b) => model.genOf.set(b.key, i + 1)));
  return { model, full, orientation, cardH, noteLines, notes: hasNotes ? notes : "none", generations: full.rows.length };
}

/**
 * @param {ReturnType<typeof prepare>} prep
 * @param {{from:number, to:number, paper:string, mode:'one'|'auto'|'count', size?:string, pages?:number}} opts
 */
export function planPages(prep, opts) {
  const { model, full, orientation, cardH } = prep;
  const paper = PAPERS[opts.paper] || PAPERS.a4l;
  // the note list takes a side column on landscape paper and a band at the bottom on portrait
  const notesBeside = paper.w > paper.h;
  const listW = prep.notes === "list" && notesBeside ? NOTES_SIDE_W : 0;
  const listH = prep.notes === "list" && !notesBeside ? NOTES_BAND_H : 0;
  const W = paper.w - listW;
  const H = paper.h - HEADER_H - FOOTER_H - listH;
  const inRange = new Set(model.blocks.filter((b) => {
    const g = model.genOf.get(b.key);
    return g >= opts.from && g <= opts.to;
  }));
  // order siblings as they appear in the full drawing
  const across = (b) => {
    const c = full.blockPos.get(b.key).center;
    return orientation === "horizontal" ? c.y : c.x;
  };
  const kids = (b) => model.childBlocks.get(b).filter((c) => inRange.has(c)).sort((a, c) => across(a) - across(c));
  const roots = [...inRange].filter((b) => !model.parentBlocks.get(b).some((p) => inRange.has(p))).sort((a, c) => across(a) - across(c));

  const cache = new Map();
  const layoutOf = (blocks) => {
    const keys = blocks.map((b) => b.key).sort().join(",");
    if (!cache.has(keys)) cache.set(keys, positionModel(model, { keys: new Set(blocks.map((b) => b.key)), orientation, cardH }));
    return cache.get(keys);
  };
  const scaleOf = (blocks) => {
    const L = layoutOf(blocks);
    return Math.min(W / L.bounds.w, H / L.bounds.h);
  };
  /** roots and their descendants down to `depth` generations below them */
  const sub = (rs, depth = Infinity) => {
    const out = [];
    let level = rs;
    for (let d = 0; level.length && d <= depth; d++) {
      out.push(...level);
      level = level.flatMap(kids);
    }
    return out;
  };
  const depthOf = (rs) => {
    let d = 0;
    let level = rs.flatMap(kids);
    while (level.length) {
      d++;
      level = level.flatMap(kids);
    }
    return d;
  };
  const atDepth = (rs, depth) => {
    let level = rs;
    for (let d = 0; d < depth; d++) level = level.flatMap(kids);
    return level;
  };

  /** Split `list` into consecutive groups for which `wrap(group)` still fits at `minScale`. */
  const groupFit = (list, wrap, minScale) => {
    const groups = [];
    let group = [];
    for (const b of list) {
      const cand = [...group, b];
      if (group.length && scaleOf(wrap(cand)) < minScale) {
        groups.push(group);
        group = [b];
      } else group = cand;
    }
    if (group.length) groups.push(group);
    return groups;
  };

  const paginate = (minScale) => {
    const pages = [];
    const queue = [{ roots, parent: null }];
    const addPage = (blocks, item, part) => {
      const page = { blocks, roots: item.roots, parent: item.parent, cont: new Map(), number: pages.length + 1, part };
      pages.push(page);
      if (item.parent && !part?.index) for (const r of item.roots) item.parent.cont.set(r.key, page.number);
      return page;
    };
    // families on a page's last generation that have descendants continue on later pages;
    // neighbours are kept together on one page while they still fit
    const continued = (page, last) =>
      groupFit(last.filter((b) => kids(b).length), (g) => sub(g), minScale).map((g) => ({ roots: g, parent: page }));

    while (queue.length) {
      const item = queue.shift();
      const maxD = depthOf(item.roots);
      let d = maxD;
      if (scaleOf(sub(item.roots, d)) < minScale) {
        d = 0;
        for (let t = maxD - 1; t >= 1; t--) {
          if (scaleOf(sub(item.roots, t)) >= minScale) {
            d = t;
            break;
          }
        }
        if (d === 0) {
          if (item.roots.length > 1) {
            // too many families side by side: give each its own page(s)
            queue.unshift(...item.roots.map((r) => ({ roots: [r], parent: item.parent })));
            continue;
          }
          // one family whose children don't fit side by side: spread the children over
          // several pages, repeating the parents at the top of each
          const root = item.roots[0];
          const groups = groupFit(kids(root), (g) => [root, ...g], minScale);
          if (groups.length > 1) {
            const next = [];
            groups.forEach((g, i) => {
              const page = addPage([root, ...g], item, { index: i, of: groups.length });
              next.push(...continued(page, g));
            });
            queue.unshift(...next);
            continue;
          }
          d = Math.min(1, maxD); // a single child family that is too wide on its own: print it anyway
        }
      }
      const page = addPage(sub(item.roots, d), item);
      if (d < maxD) queue.unshift(...continued(page, atDepth(item.roots, d)));
    }
    return pages;
  };

  let pages;
  if (opts.mode === "one" || !roots.length) {
    pages = roots.length ? [{ blocks: [...inRange], roots, parent: null, cont: new Map(), number: 1 }] : [];
  } else if (opts.mode === "count") {
    // the largest readable size that still fits in the requested number of pages
    const target = Math.max(1, opts.pages || 1);
    let lo = 0.05;
    let hi = 1.2;
    pages = paginate(lo);
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      const p = paginate(mid);
      if (p.length <= target) {
        lo = mid;
        pages = p;
      } else hi = mid;
    }
  } else {
    pages = paginate(SIZES[opts.size] || SIZES.medium);
  }

  for (const p of pages) {
    p.layout = layoutOf(p.blocks);
    p.scale = Math.min(1.2, W / p.layout.bounds.w, H / p.layout.bounds.h);
  }
  return { pages, paper, W, H, listW, listH };
}

function familyName(model, block) {
  const fam = model.fam;
  // the family's own child first, then whoever married in
  const blood = (id) => (model.parentBlocks.get(block).length && (fam.get(Math.abs(id)).father_id || fam.get(Math.abs(id)).mother_id) ? 0 : 1);
  return [...block.members]
    .sort((a, b) => blood(a) - blood(b))
    .map((id) => fam.get(Math.abs(id)))
    .map((p) => `${p.first_name} ${p.last_name || ""}`.trim())
    .join(" و ");
}

/** Render the planned pages into `root` (hidden on screen, shown when printing). */
export function renderPages(root, plan, prep, { title, legendHtml }) {
  root.replaceChildren();
  const total = plan.pages.length;
  let style = document.getElementById("page-size-style");
  if (!style) {
    style = document.createElement("style");
    style.id = "page-size-style";
    document.head.appendChild(style);
  }
  style.textContent = `@page { size: ${plan.paper.size}; margin: 8mm; }`;

  for (const page of plan.pages) {
    const div = document.createElement("section");
    div.className = "print-page";
    div.style.width = `${plan.paper.w}px`;
    div.style.height = `${plan.paper.h}px`;
    const parts = [];
    if (page.parent || page.part) parts.push(`شاخهٔ ${familyName(prep.model, page.roots[0])}${page.roots.length > 1 ? ` و ${toFa(page.roots.length - 1)} خانوادهٔ دیگر` : ""}`);
    if (page.part) parts.push(`بخش ${toFa(page.part.index + 1)} از ${toFa(page.part.of)} فرزندان`);
    if (page.parent) parts.push(`ادامه از صفحهٔ ${toFa(page.parent.number)}`);
    const sub = parts.join(" — ");
    div.innerHTML = `<header class="print-head"><div><h1></h1><div class="print-sub"></div></div><div class="print-num">صفحهٔ ${toFa(page.number)} از ${toFa(total)}</div></header>`;
    div.querySelector("h1").textContent = title;
    div.querySelector(".print-sub").textContent = sub;
    // never enlarge a small branch beyond 120%
    const b = page.layout.bounds;
    const vw = Math.max(b.w, plan.W / 1.2);
    const vh = Math.max(b.h, plan.H / 1.2);
    const vb = `${b.x - (vw - b.w) / 2} ${b.y} ${vw} ${vh}`;
    const svg = el("svg", { class: "print-svg", width: plan.W, height: plan.H, viewBox: vb, preserveAspectRatio: "xMidYMin meet" });
    const defs = svgDefs(svg, `pp${page.number}`);
    const g = el("g", {}, svg);
    const body = document.createElement("div");
    body.className = `print-body${plan.listW ? " beside" : ""}`;
    body.appendChild(svg);
    div.appendChild(body);

    // "list" mode: number the people with notes on this page (reading order) and list them
    let noteRefs = null;
    if (prep.notes === "list") {
      const fam = prep.model.fam;
      const seen = page.layout.pos;
      const ids = [...new Set([...seen.keys()].map(Math.abs))].filter((id) => fam.get(id).notes);
      const at = (id) => seen.get(id) || seen.get(-id);
      ids.sort((a, c) => at(a).y - at(c).y || at(c).x - at(a).x);
      noteRefs = new Map(ids.map((id, i) => [id, i + 1]));
      const aside = document.createElement("aside");
      aside.className = "print-notes";
      aside.style[plan.listW ? "width" : "height"] = `${plan.listW || plan.listH}px`;
      aside.innerHTML = `<h3>یادداشت‌ها</h3>${ids.length ? "<ol></ol>" : `<p class="none">در این صفحه یادداشتی نیست.</p>`}`;
      const ol = aside.querySelector("ol");
      for (const id of ids) {
        const p = fam.get(id);
        const li = document.createElement("li");
        li.value = noteRefs.get(id);
        const b2 = document.createElement("b");
        b2.textContent = `${p.first_name} ${p.last_name || ""}`.trim() + ": ";
        li.append(b2, p.notes);
        ol?.appendChild(li);
      }
      body.appendChild(aside);
    }
    const foot = document.createElement("footer");
    foot.className = "print-foot";
    foot.innerHTML = legendHtml;
    div.appendChild(foot);
    root.appendChild(div);
    const arrow = prep.orientation === "horizontal" ? "◀" : "▼";
    const cont = new Map([...page.cont].map(([k, n]) => [k, `${arrow} ادامه در صفحهٔ ${toFa(n)}`]));
    drawLayout(g, page.layout, { noteLines: prep.noteLines, noteRefs, noteIcon: false, cont, defs, shadow: false });
  }
}
