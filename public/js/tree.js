// Family tree layout (dagre over couple blocks) and SVG rendering with pan / zoom / minimap.
import dagre from "../vendor/dagre.esm.js";

export const CARD_W = 172;
export const CARD_H = 62;
/** Card height with room for `lines` lines of notes. */
export const cardHeight = (lines = 0) => (lines > 0 ? 66 + lines * 15 : CARD_H);
const SVG_NS = "http://www.w3.org/2000/svg";

const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
export const toFa = (s) => String(s ?? "").replace(/\d/g, (d) => FA_DIGITS[d]);

/** First 3–4 digit number in a free-form date (Persian, Arabic or Latin digits). */
export function yearOf(s) {
  const t = String(s || "")
    .replace(/[۰-۹]/g, (d) => FA_DIGITS.indexOf(d))
    .replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d));
  const m = t.match(/\d{3,4}/);
  return m ? Number(m[0]) : null;
}

/** "علی رحیمی"; someone entered without a first name shows as «بی‌نام». */
export function displayName(p) {
  if (!p) return "؟";
  return `${p.first_name || "بی‌نام"} ${p.last_name || ""}`.trim();
}

/**
 * Children announced on a person (sons_count / daughters_count) but not yet in the tree.
 * Counts nobody filled in mean "unknown", so nothing is missing.
 */
export function missingChildren(fam, p) {
  const kids = fam.childrenOf(p.id).map((c) => fam.get(c));
  const gap = (count, gender) => (count == null ? 0 : Math.max(0, count - kids.filter((k) => k.gender === gender).length));
  return { sons: gap(p.sons_count, "male"), daughters: gap(p.daughters_count, "female") };
}

export function missingLabel({ sons, daughters }) {
  return [sons ? `${toFa(sons)} پسر` : "", daughters ? `${toFa(daughters)} دختر` : ""].filter(Boolean).join(" و ");
}

export function lifeSpan(p) {
  const b = p.birth_date || "";
  const d = p.death_date || "";
  if (!b && !d) return p.is_deceased ? "درگذشته" : "";
  if (!d) return toFa(p.is_deceased ? `${b} – ؟` : b);
  return toFa(`${b || "؟"} – ${d}`);
}

const maleFirst = (fam) => (a, b) =>
  fam.get(a).gender === fam.get(b).gender ? a - b : fam.get(a).gender === "male" ? -1 : 1;

/** Order the members of a marriage component so that spouses sit next to each other. */
function orderBlock(members, adj) {
  if (members.length === 1) return members;
  const center = [...members].sort((a, b) => adj.get(b).size - adj.get(a).size || a - b)[0];
  const nbrs = [...adj.get(center)];
  const half = Math.ceil(nbrs.length / 2);
  const order = [...nbrs.slice(0, half), center, ...nbrs.slice(half)];
  const placed = new Set(order);
  const queue = [...order];
  while (queue.length) {
    const cur = queue.shift();
    for (const n of adj.get(cur)) {
      if (placed.has(n)) continue;
      const i = order.indexOf(cur);
      if (i === 0) order.unshift(n);
      else if (i === order.length - 1) order.push(n);
      else order.splice(i + (i < order.indexOf(center) ? 0 : 1), 0, n);
      placed.add(n);
      queue.push(n);
    }
  }
  return order;
}

/**
 * Married people (and unmarried parent pairs) form one "block"; blocks are ranked by
 * generation. A cousin marriage gives a block two parent families — still a DAG.
 *
 * duplicates (print): every block keeps at most one parent family. Someone who married
 * into another branch is drawn a second time under their own parents (a "copy", using the
 * negated person id) and both copies share a numbered marker. The blocks then form a forest,
 * which is what lets the print view split branches onto pages.
 *
 * @param {import('./kinship.js').Family} fam  people to draw
 * @param {import('./kinship.js').Family} full the whole family (for consanguinity)
 */
export function buildModel(fam, full = fam, { duplicates = false, gens = null } = {}) {
  const has = (id) => id != null && fam.people.has(id);

  const couples = new Map();
  for (const m of fam.marriages) {
    couples.set(`${m.husband_id}|${m.wife_id}`, { key: `m${m.id}`, h: m.husband_id, w: m.wife_id, marriage: m, children: [] });
  }
  const singles = new Map();
  for (const p of fam.people.values()) {
    const f = has(p.father_id) ? p.father_id : null;
    const mo = has(p.mother_id) ? p.mother_id : null;
    if (f && mo) {
      const k = `${f}|${mo}`;
      if (!couples.has(k)) couples.set(k, { key: `u${f}_${mo}`, h: f, w: mo, marriage: null, children: [] });
      couples.get(k).children.push(p.id);
    } else if (f || mo) {
      const pid = f || mo;
      if (!singles.has(pid)) singles.set(pid, { key: `s${pid}`, single: pid, children: [] });
      singles.get(pid).children.push(p.id);
    }
  }
  const unions = [...couples.values(), ...singles.values()];
  for (const u of unions) u.consanguinity = u.marriage ? full.consanguinity(u.marriage) : null;

  // blocks: connected components of the marriage graph
  const adj = new Map([...fam.people.keys()].map((id) => [id, new Set()]));
  for (const c of couples.values()) {
    adj.get(c.h).add(c.w);
    adj.get(c.w).add(c.h);
  }
  const blockOf = new Map();
  const blocks = [];
  for (const id of fam.people.keys()) {
    if (blockOf.has(id)) continue;
    const comp = [];
    const stack = [id];
    blockOf.set(id, null);
    while (stack.length) {
      const cur = stack.pop();
      comp.push(cur);
      for (const n of adj.get(cur)) if (!blockOf.has(n)) (blockOf.set(n, null), stack.push(n));
    }
    comp.sort(maleFirst(fam));
    const block = { key: `b${blocks.length}`, members: orderBlock(comp, adj) };
    blocks.push(block);
    for (const m of block.members) blockOf.set(m, block);
  }

  const markers = new Map();
  if (duplicates) {
    const parentUnion = new Map();
    for (const u of unions) for (const c of u.children) parentUnion.set(c, u);
    for (const b of [...blocks]) {
      const fromOutside = b.members.filter((id) => {
        const u = parentUnion.get(id);
        return u && blockOf.get(u.h ?? u.single) !== b;
      });
      if (fromOutside.length < 2) continue;
      fromOutside.sort(maleFirst(fam));
      for (const id of fromOutside.slice(1)) {
        const u = parentUnion.get(id);
        u.children = u.children.map((c) => (c === id ? -id : c));
        const copy = { key: `b${blocks.length}`, members: [-id], copy: true };
        blocks.push(copy);
        blockOf.set(-id, copy);
        markers.set(id, markers.size + 1);
      }
    }
  }

  // block graph: parent block(s) → child blocks
  const childBlocks = new Map(blocks.map((b) => [b, []]));
  const parentBlocks = new Map(blocks.map((b) => [b, []]));
  for (const u of unions) {
    const src = blockOf.get(u.h ?? u.single);
    for (const c of u.children) {
      const dst = blockOf.get(c);
      if (dst === src) continue;
      if (!childBlocks.get(src).includes(dst)) childBlocks.get(src).push(dst);
      if (!parentBlocks.get(dst).includes(src)) parentBlocks.get(dst).push(src);
    }
  }
  // generation of each block (from generations.js) for the row labels and print ranges
  const genOf = new Map();
  if (gens) {
    for (const b of blocks) {
      const g = Math.min(...b.members.map((id) => gens.get(Math.abs(id)) ?? Infinity));
      if (Number.isFinite(g)) genOf.set(b.key, g);
    }
  }
  return { fam, unions, blocks, blockOf, markers, childBlocks, parentBlocks, genOf };
}

/**
 * Position a model (or a subset of its blocks) with dagre.
 * Works in an abstract frame — u: across a generation, v: down the generations — and maps it
 * to the screen: vertical → (u, v); horizontal → (−v, u), i.e. generations run right-to-left
 * and children are stacked under each other, which keeps wide families narrow.
 * siblingOrder "birth" lays the blocks out as a tree with siblings in birth order (see
 * birthLayout) instead of letting dagre order them to minimise crossings.
 * @param {{keys?:Set<string>|null, orientation?:'vertical'|'horizontal', cardH?:number, siblingOrder?:'auto'|'birth'}} opts
 */
export function positionModel(model, { keys = null, orientation = "vertical", cardH = CARD_H, siblingOrder = "auto" } = {}) {
  const vertical = orientation !== "horizontal";
  const cw = CARD_W;
  const ch = cardH;
  const cC = vertical ? cw : ch; // card extent across a generation
  const cM = vertical ? ch : cw; // card extent along the generations
  const GAP = vertical ? 46 : 34; // between spouses (room for the rings)
  const RANK_SEP = vertical ? 78 : 76;
  const map = vertical ? (u, v) => ({ x: u, y: v }) : (u, v) => ({ x: -v, y: u });

  const blocks = keys ? model.blocks.filter((b) => keys.has(b.key)) : model.blocks;
  const inSet = new Set(blocks);
  const { blockOf } = model;
  const size = (b) => b.members.length * cC + (b.members.length - 1) * GAP;

  const unions = model.unions.filter((u) => inSet.has(blockOf.get(u.h ?? u.single)));
  const NODE_SEP = vertical ? 34 : 18;
  // block centres (abstract frame) and, for dagre, the routed points of long edges
  const node = new Map();
  let edgePoints = () => null;
  let primary = null; // birth layout: "src>dst" links that shape the tree; the others are drawn as curves
  if (siblingOrder === "birth") {
    primary = birthLayout(model, blocks, inSet, unions, { size, cM, RANK_SEP, NODE_SEP, eldestFirst: !vertical }, node);
  } else {
    const g = new dagre.graphlib.Graph({ multigraph: true });
    g.setGraph({ rankdir: "TB", nodesep: NODE_SEP, ranksep: RANK_SEP, marginx: 0, marginy: 0 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const b of blocks) g.setNode(b.key, { width: size(b), height: cM });
    for (const u of unions) {
      const src = blockOf.get(u.h ?? u.single);
      for (const c of u.children) {
        const dst = blockOf.get(c);
        if (dst !== src && inSet.has(dst)) g.setEdge(src.key, dst.key, { minlen: 1, weight: 1 }, `${u.key}>${c}`);
      }
    }
    dagre.layout(g);
    for (const b of blocks) node.set(b.key, g.node(b.key));
    edgePoints = (src, dst, name) => g.edge(src, dst, name)?.points || null;
  }

  // abstract positions of every member
  const ap = new Map();
  const order = new Map(blocks.map((b) => [b, [...b.members]]));
  const place = (b) => {
    const n = node.get(b.key);
    const start = n.x - size(b) / 2;
    order.get(b).forEach((id, i) => ap.set(id, { u: start + i * (cC + GAP) + cC / 2, v: n.y }));
  };
  const unionOfChild = new Map();
  for (const u of unions) for (const c of u.children) unionOfChild.set(c, u);
  const dropU = (u) => (u.single != null ? ap.get(u.single).u : (ap.get(u.h).u + ap.get(u.w).u) / 2);

  // Generation by generation, mirror a block when that brings members closer to their parents.
  const sorted = [...blocks].sort((a, b) => node.get(a.key).y - node.get(b.key).y);
  for (const b of sorted) {
    place(b);
    if (b.members.length < 2) continue;
    const cost = () =>
      order.get(b).reduce((s, id) => {
        const u = unionOfChild.get(id);
        const src = u && blockOf.get(u.h ?? u.single);
        return src && src !== b && inSet.has(src) ? s + Math.abs(ap.get(id).u - dropU(u)) : s;
      }, 0);
    const before = cost();
    order.get(b).reverse();
    place(b);
    if (cost() >= before) {
      order.get(b).reverse();
      place(b);
    }
  }

  const pt = (u, v) => {
    const q = map(u, v);
    return `${q.x},${q.y}`;
  };
  const pathOf = (cmds) => cmds.map(([c, ...pts]) => c + pts.map((p) => pt(p[0], p[1])).join(" ")).join(" ");

  // unions: drop point, spouse line
  const out = [];
  for (const u of unions) {
    const r = { ...u };
    if (u.single != null) {
      const p = ap.get(u.single);
      Object.assign(r, { du: p.u, dv: p.v + cM / 2, kind: "single" });
    } else {
      const b = blockOf.get(u.h);
      const o = order.get(b);
      const adjacent = Math.abs(o.indexOf(u.h) - o.indexOf(u.w)) === 1;
      const [h, w] = [ap.get(u.h), ap.get(u.w)];
      r.kind = adjacent ? "ring" : "arc";
      r.du = (h.u + w.u) / 2;
      r.dv = adjacent ? h.v : h.v + cM / 2 + 18;
      if (adjacent) {
        const [a, c] = h.u < w.u ? [h.u + cC / 2, w.u - cC / 2] : [w.u + cC / 2, h.u - cC / 2];
        r.spousePath = pathOf([["M", [a, h.v]], ["L", [c, h.v]]]);
      } else {
        const bv = h.v + cM / 2;
        r.spousePath = pathOf([["M", [h.u, bv]], ["C", [h.u, bv + 26], [w.u, bv + 26], [w.u, bv]]]);
      }
    }
    const q = map(r.du, r.dv);
    r.x = q.x;
    r.y = q.y;
    r.cut = u.children.some((c) => !inSet.has(blockOf.get(c)));
    out.push(r);
  }

  // connectors to children
  const links = [];
  for (const u of out) {
    const src = blockOf.get(u.h ?? u.single);
    const rowEnd = node.get(src.key).y + cM / 2;
    for (const c of u.children) {
      const dst = blockOf.get(c);
      if (!inSet.has(dst) || dst === src) continue;
      const p = ap.get(c);
      const top = p.v - cM / 2;
      // a second parent family in the birth layout (e.g. a cousin marriage) is joined with a curve
      const cross = primary && !primary.has(`${src.key}>${dst.key}`);
      const long = cross || top - rowEnd > RANK_SEP + 8;
      let cmds;
      if (!long) {
        const bus = rowEnd + (top - rowEnd) / 2;
        cmds = [["M", [u.du, u.dv]], ["L", [u.du, bus]], ["L", [p.u, bus]], ["L", [p.u, top]]];
      } else {
        const mids = (edgePoints(src.key, dst.key, `${u.key}>${c}`) || []).slice(1, -1).map((q) => [q.x, q.y]);
        const pts = [[u.du, rowEnd + 16], ...mids, [p.u, top - 16]];
        cmds = [["M", [u.du, u.dv]], ["L", pts[0]]];
        for (let i = 1; i < pts.length; i++) {
          const [a, b] = [pts[i - 1], pts[i]];
          const my = (a[1] + b[1]) / 2;
          cmds.push(["C", [a[0], my], [b[0], my], b]);
        }
        cmds.push(["L", [p.u, top]]);
      }
      links.push({ d: pathOf(cmds), union: u, child: c, long });
    }
  }

  // generation rows (labels sit before the first block of each row)
  const rowMap = new Map();
  let minU = Infinity;
  for (const b of blocks) {
    const n = node.get(b.key);
    minU = Math.min(minU, n.x - size(b) / 2);
    const v = Math.round(n.y);
    if (!rowMap.has(v)) rowMap.set(v, []);
    rowMap.get(v).push(b);
  }
  const labelU = minU - (vertical ? 100 : 50);
  const rows = [...rowMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([v, bs], i) => {
      const ids = bs.flatMap((b) => b.members).filter((id) => id > 0);
      const years = ids.map((id) => yearOf(model.fam.get(id).birth_date)).filter((x) => x);
      const avg = years.length ? Math.round(years.reduce((s, x) => s + x, 0) / years.length / 10) * 10 : null;
      const gen = Math.min(...bs.map((b) => model.genOf.get(b.key) ?? i + 1));
      const q = map(labelU, v);
      return { v, x: q.x, y: q.y, gen, year: avg, blocks: bs };
    });

  // screen positions and bounds
  const pos = new Map();
  const blockPos = new Map();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (x, y, hw, hh) => {
    x0 = Math.min(x0, x - hw);
    x1 = Math.max(x1, x + hw);
    y0 = Math.min(y0, y - hh);
    y1 = Math.max(y1, y + hh);
  };
  for (const [id, a] of ap) {
    const q = map(a.u, a.v);
    pos.set(id, q);
    grow(q.x, q.y, cw / 2, ch / 2 + 14);
  }
  for (const b of blocks) {
    const n = node.get(b.key);
    blockPos.set(b.key, { center: map(n.x, n.y), after: map(n.x, n.y + cM / 2 + 22) });
  }
  for (const r of rows) grow(r.x, r.y, 62, 24);
  const M = 30;
  return {
    model,
    orientation: vertical ? "vertical" : "horizontal",
    cw,
    ch,
    pos,
    blockPos,
    blocks,
    unions: out,
    links,
    rows,
    markers: model.markers,
    bounds: { x: x0 - M, y: y0 - M, w: x1 - x0 + 2 * M, h: y1 - y0 + 2 * M },
  };
}

/**
 * Siblings in birth order: the year of birth decides first; «فرزند چندم» decides when a year is
 * missing (common for older generations) or the same; otherwise the order they were entered.
 * @param {(item:any)=>number} idOf  person id of an item (items may be ids or wrappers)
 */
export function sortSiblings(fam, items, idOf = (x) => x) {
  const info = (it) => {
    const p = fam.get(Math.abs(idOf(it)));
    return { year: yearOf(p?.birth_date), order: p?.birth_order ?? null, id: Math.abs(idOf(it)) };
  };
  return [...items].sort((a, b) => {
    const [x, y] = [info(a), info(b)];
    if (x.year && y.year && x.year !== y.year) return x.year - y.year;
    if (x.order != null && y.order != null && x.order !== y.order) return x.order - y.order;
    if (!x.year !== !y.year && (x.order == null || y.order == null)) return x.year ? -1 : 1;
    if ((x.order != null) !== (y.order != null)) return x.order != null ? -1 : 1;
    return x.id - y.id;
  });
}

/**
 * Tree layout with siblings in birth order. Every block hangs under one parent family (the
 * nearest; the father's on a tie) and each family gets its own band, so nothing overlaps;
 * a block's other parent family is linked with a curve. Rows are the longest path from the
 * top, as with dagre. Fills `node` with block centres; returns the "src>dst" tree links.
 */
function birthLayout(model, blocks, inSet, unions, { size, cM, RANK_SEP, NODE_SEP, eldestFirst }, node) {
  const { blockOf, fam } = model;
  const parents = new Map(blocks.map((b) => [b, []]));
  for (const u of unions) {
    const src = blockOf.get(u.h ?? u.single);
    for (const c of u.children) {
      const dst = blockOf.get(c);
      if (dst !== src && inSet.has(dst)) parents.get(dst).push({ src, child: c, father: u.h ?? (fam.get(Math.abs(u.single))?.gender === "male" ? u.single : null) });
    }
  }
  const rank = new Map();
  const rankOf = (b, seen = new Set()) => {
    if (rank.has(b)) return rank.get(b);
    if (seen.has(b)) return 0; // cycle guard (shouldn't happen in a family)
    seen.add(b);
    const r = Math.max(0, ...parents.get(b).map((p) => rankOf(p.src, seen) + 1));
    rank.set(b, r);
    return r;
  };
  blocks.forEach((b) => rankOf(b));

  const kids = new Map(blocks.map((b) => [b, []]));
  const tree = new Set();
  const roots = [];
  for (const b of blocks) {
    const ps = parents.get(b);
    if (!ps.length) {
      roots.push({ b, child: b.members[0] });
      continue;
    }
    // nearest parent family; on a tie, the one the child's father belongs to
    const best = [...ps].sort((x, y) => rank.get(y.src) - rank.get(x.src) || (y.father != null) - (x.father != null))[0];
    kids.get(best.src).push({ b, child: best.child });
    tree.add(`${best.src.key}>${b.key}`);
  }
  const sortKids = (list) => {
    const sorted = sortSiblings(fam, list, (k) => k.child);
    list.splice(0, list.length, ...sorted);
    return list;
  };
  const width = new Map();
  const widthOf = (b) => {
    if (width.has(b)) return width.get(b);
    const ks = sortKids(kids.get(b));
    const inner = ks.reduce((s, k) => s + widthOf(k.b), 0) + NODE_SEP * Math.max(0, ks.length - 1);
    const w = Math.max(size(b), inner);
    width.set(b, w);
    return w;
  };
  // vertical RTL: the eldest on the right; horizontal: the eldest on top
  const lay = (list) => (eldestFirst ? list : [...list].reverse());
  const place = (b, left) => {
    const w = widthOf(b);
    const ks = lay(kids.get(b));
    const inner = ks.reduce((s, k) => s + widthOf(k.b), 0) + NODE_SEP * Math.max(0, ks.length - 1);
    let x = left + (w - inner) / 2;
    const centres = [];
    for (const k of ks) {
      centres.push(place(k.b, x));
      x += widthOf(k.b) + NODE_SEP;
    }
    let c = centres.length ? (centres[0] + centres[centres.length - 1]) / 2 : left + w / 2;
    c = Math.min(Math.max(c, left + size(b) / 2), left + w - size(b) / 2);
    node.set(b.key, { x: c, y: rank.get(b) * (cM + RANK_SEP) + cM / 2 });
    return c;
  };
  let x = 0;
  for (const r of lay(sortKids(roots))) {
    place(r.b, x);
    x += widthOf(r.b) + NODE_SEP * 3;
  }
  return tree;
}

/** Convenience: model + positions in one go. */
export function layoutTree(fam, full = fam, opts = {}) {
  const model = buildModel(fam, full, opts);
  return positionModel(model, opts);
}

// ---------------------------------------------------------------------------
// drawing

export function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null && v !== false) e.setAttribute(k, String(v));
  if (parent) parent.appendChild(e);
  return e;
}

function text(parent, str, attrs) {
  const t = el("text", attrs, parent);
  t.textContent = str;
  return t;
}

/** Shorten an SVG text node with an ellipsis until it fits `maxW` pixels. */
function fitText(t, maxW) {
  const full = t.textContent;
  let len;
  try {
    len = t.getComputedTextLength();
  } catch {
    return;
  }
  if (!len || len <= maxW) return;
  let n = Math.floor((full.length * maxW) / len);
  t.textContent = full.slice(0, n) + "…";
  while (n > 1 && t.getComputedTextLength() > maxW) t.textContent = full.slice(0, --n) + "…";
}

/** Word-wrap `str` into at most `lines` SVG text lines, ellipsising the last one. */
function wrapText(parent, str, { x, y, maxW, lines, cls }) {
  const words = str.replace(/\s+/g, " ").trim().split(" ");
  let i = 0;
  for (let n = 0; n < lines && i < words.length; n++) {
    const t = text(parent, words[i], { x, y: y + n * 15, class: cls, "text-anchor": "start", direction: "rtl" });
    i++;
    while (i < words.length) {
      const before = t.textContent;
      t.textContent = `${before} ${words[i]}`;
      if (t.getComputedTextLength() > maxW) {
        t.textContent = before;
        break;
      }
      i++;
    }
    if (n === lines - 1 && i < words.length) {
      t.textContent += " …";
      fitText(t, maxW);
    } else fitText(t, maxW);
  }
}

function rings(parent, x, y, cls) {
  const g = el("g", { class: `rings ${cls}`, transform: `translate(${x},${y})` }, parent);
  el("circle", { r: 13, class: "ring-bg" }, g);
  el("circle", { cx: -4.5, r: 6.5, class: "ring" }, g);
  el("circle", { cx: 4.5, r: 6.5, class: "ring" }, g);
  return g;
}

/**
 * Draw a positioned layout into `root` (an SVG <g>).
 * @param {object} L  result of positionModel
 * @param {object} state  {missingOf, defs, focusId, selectedId, kin, highlight, highlightUnions, relationsTo, noteLines, noteRefs, noteIcon, cont}
 * @param {object} on  event handlers {person(id), union(u), hover(p, evt|null)}
 */
export function drawLayout(root, L, state = {}, on = {}) {
  const fam = L.model.fam;
  const { pos, cw, ch } = L;
  root.replaceChildren();
  const rowLayer = el("g", { class: "rows" }, root);
  const linkLayer = el("g", { class: "links" }, root);
  const unionLayer = el("g", { class: "unions" }, root);
  const cardLayer = el("g", { class: "cards" }, root);
  const hl = state.highlight || new Set();
  const hlUnions = state.highlightUnions || new Set();
  const kin = state.kin || new Set();
  const defs = state.defs || "tv";

  for (const r of L.rows) {
    const g = el("g", { class: "gen-label", transform: `translate(${r.x},${r.y})` }, rowLayer);
    el("rect", { x: -62, y: -24, width: 124, height: 48, rx: 10 }, g);
    text(g, `نسل ${toFa(r.gen)}`, { "text-anchor": "middle", y: r.year ? -4 : 5, class: "gen-title" });
    if (r.year) text(g, `(حدود ${toFa(r.year)})`, { "text-anchor": "middle", y: 15, class: "gen-year" });
  }

  for (const l of L.links) {
    const cls = ["child-line", l.long ? "long" : "", hlUnions.has(l.union.key) && hl.has(Math.abs(l.child)) ? "hl" : ""];
    el("path", { d: l.d, class: cls.filter(Boolean).join(" ") }, linkLayer);
  }

  for (const u of L.unions) {
    if (u.kind === "single") continue;
    const status = u.marriage?.status || "implicit";
    el("path", { d: u.spousePath, class: ["spouse-line", status, hlUnions.has(u.key) ? "hl" : ""].filter(Boolean).join(" ") }, linkLayer);
    if (!u.marriage) continue;
    const g = rings(unionLayer, u.x, u.y, status);
    if (on.union) {
      g.setAttribute("tabindex", "0");
      g.addEventListener("click", (e) => {
        e.stopPropagation();
        on.union(u);
      });
    }
    el("title", {}, g).textContent = "ازدواج";
  }

  // "continued on page n" notes (print)
  if (state.cont) {
    for (const [key, label] of state.cont) {
      const bp = L.blockPos.get(key);
      if (!bp) continue;
      const g = el("g", { class: "cont-label", transform: `translate(${bp.after.x},${bp.after.y})` }, unionLayer);
      text(g, label, { "text-anchor": "middle", dy: "0.35em", direction: "rtl" });
    }
  }

  const entries = [...fam.people.values()].filter((p) => pos.has(p.id)).map((p) => ({ p, key: p.id, copy: false }));
  for (const b of L.blocks) if (b.copy) entries.push({ p: fam.get(-b.members[0]), key: b.members[0], copy: true });
  for (const { p, key, copy } of entries) {
    const { x, y } = pos.get(key);
    const rels = state.relationsTo ? state.relationsTo(p.id) : [];
    const primary = rels[0];
    const classes = [
      "card",
      p.gender,
      copy ? "copy" : "",
      state.guests?.has(p.id) ? "guest" : "",
      p.is_deceased ? "deceased" : "",
      state.draftIds?.has(p.id) ? "draft" : "",
      p.id === state.selectedId ? "selected" : "",
      kin.has(p.id) ? "kin" : "",
      p.id === state.focusId ? "focus" : "",
      hl.size && !hl.has(p.id) ? "dim" : "",
      hl.has(p.id) ? "hl" : "",
    ];
    const g = el("g", { class: classes.filter(Boolean).join(" "), transform: `translate(${x - cw / 2},${y - ch / 2})` }, cardLayer);
    if (on.person) {
      g.setAttribute("tabindex", "0");
      g.setAttribute("role", "button");
      g.addEventListener("click", (e) => {
        e.stopPropagation();
        on.person(p.id);
      });
      g.addEventListener("keydown", (e) => e.key === "Enter" && on.person(p.id));
    }
    if (on.hover) {
      g.addEventListener("pointerenter", (e) => e.pointerType === "mouse" && on.hover(p, e, rels));
      g.addEventListener("pointermove", (e) => e.pointerType === "mouse" && on.hover(p, e, rels));
      g.addEventListener("pointerleave", () => on.hover(null));
    }
    el("rect", { width: cw, height: ch, rx: 12, class: "card-bg", filter: state.shadow === false ? null : `url(#${defs}-shadow)` }, g);

    // avatar on the left, text on the right (RTL)
    const ag = el("g", { transform: `translate(32,${Math.min(ch / 2, 31)})` }, g);
    el("circle", { r: 21, class: "avatar-bg" }, ag);
    if (p.photo_url) {
      el("image", { href: p.photo_url, x: -20, y: -20, width: 40, height: 40, "clip-path": `url(#${defs}-clip)`, preserveAspectRatio: "xMidYMid slice" }, ag);
    } else {
      const sil = el("g", { "clip-path": `url(#${defs}-clip)`, class: "silhouette" }, ag);
      el("circle", { cy: -5, r: 8 }, sil);
      el("ellipse", { cy: 17, rx: 15, ry: 11 }, sil);
    }
    if (p.is_deceased) el("path", { d: "M9,-20 L20,-9 L20,-4 L4,-20 Z", class: "ribbon" }, ag);

    const name = displayName(p);
    const maxW = cw - 12 - 62;
    fitText(text(g, name, { x: cw - 12, y: 27, class: "card-name", "text-anchor": "start", direction: "rtl" }), maxW);
    const span = lifeSpan(p);
    if (span) fitText(text(g, `(${span})`, { x: cw - 12, y: 47, class: "card-sub", "text-anchor": "start", direction: "rtl" }), maxW);
    if (p.notes) {
      if (state.noteLines > 0) {
        wrapText(g, p.notes, { x: cw - 12, y: 72, maxW: cw - 24, lines: state.noteLines, cls: "card-note" });
      } else if (state.noteRefs?.has(p.id)) {
        // numbered reference into the page's note list (print)
        text(g, `✎${toFa(state.noteRefs.get(p.id))}`, { x: 10, y: ch - 8, class: "note-ref" });
      } else if (state.noteIcon !== false) {
        text(g, "✎", { x: 10, y: ch - 8, class: "note-icon" });
      }
    }

    if (primary) {
      const extra = rels.length > 1 ? ` +${toFa(rels.length - 1)}` : "";
      const label = primary.kind === "self" ? "★ من" : primary.label + extra;
      const bw = Math.min(label.length * 7 + 20, cw);
      const bg = el("g", { class: `rel-badge kind-${primary.kind}`, transform: `translate(${cw / 2},0)` }, g);
      el("rect", { x: -bw / 2, y: -11, width: bw, height: 21, rx: 10.5 }, bg);
      text(bg, label, { "text-anchor": "middle", dy: "0.35em", direction: "rtl" });
    }
    if (state.guests?.has(p.id)) {
      // from another clan: a tag on the card's left edge
      const tg = el("g", { class: "clan-tag", transform: `translate(6,${ch - 2})` }, g);
      const label = `طایفهٔ ${state.guests.get(p.id)}`;
      const t = text(tg, label, { x: 8, y: 0, dy: "0.32em", "text-anchor": "start", direction: "ltr" });
      fitText(t, cw / 2);
      const w = Math.min(cw / 2, (t.getComputedTextLength?.() || label.length * 6) ) + 16;
      tg.insertBefore(el("rect", { x: 0, y: -8, width: w, height: 16, rx: 8 }), t);
    }
    const miss = state.missingOf && !copy ? state.missingOf(p) : "";
    if (miss) {
      // announced children not yet entered: a small tag on the card's bottom-right
      const label = `${miss} کم`;
      const tg = el("g", { class: "missing-tag", transform: `translate(${cw - 6},${ch - 2})` }, g);
      const t = text(tg, label, { x: -8, y: 0, dy: "0.32em", "text-anchor": "start", direction: "rtl" });
      const w = (t.getComputedTextLength?.() || label.length * 6) + 16;
      tg.insertBefore(el("rect", { x: -w, y: -8, width: w, height: 16, rx: 8 }), t);
      const tip = el("title", {}, tg);
      tip.textContent = `${miss} هنوز ثبت نشده`;
    }
    const marker = L.markers.get(p.id);
    if (marker) {
      // same number on both copies of a person drawn twice (print view)
      const mg = el("g", { class: "dup-marker", transform: "translate(4,4)" }, g);
      el("circle", { r: 11 }, mg);
      text(mg, toFa(marker), { "text-anchor": "middle", dy: "0.36em" });
    }
  }
}

/**
 * Shadow filter and avatar clip for one <svg>. Ids must be unique per document: a reference
 * to an id inside a hidden svg (e.g. the screen tree while printing) renders nothing.
 */
export function svgDefs(svg, prefix) {
  const defs = el("defs", {}, svg);
  const f = el("filter", { id: `${prefix}-shadow`, x: "-20%", y: "-30%", width: "140%", height: "170%" }, defs);
  el("feDropShadow", { dx: 0, dy: 2, stdDeviation: 2.5, "flood-color": "#0f172a", "flood-opacity": 0.12 }, f);
  const clip = el("clipPath", { id: `${prefix}-clip` }, defs);
  el("circle", { cx: 0, cy: 0, r: 20 }, clip);
  return prefix;
}

// ---------------------------------------------------------------------------

export class TreeView {
  /**
   * @param {SVGSVGElement} svg
   * @param {{onSelectPerson:Function, onSelectUnion:Function, onBackground:Function, onHover?:Function, minimap?:SVGSVGElement, insets?:()=>{top:number,right:number,bottom:number,left:number}}} opts
   */
  constructor(svg, opts) {
    this.svg = svg;
    this.opts = opts;
    this.view = { x: 0, y: 0, k: 1 };
    this.layout = null;
    this.defs = svgDefs(svg, "tv");
    this.viewport = el("g", { class: "viewport" }, svg);
    this._initPanZoom();
    if (opts.minimap) this._initMinimap(opts.minimap);
    new ResizeObserver(() => this._apply()).observe(svg);
  }

  /**
   * @param {import('./kinship.js').Family} fam   people to draw
   * @param {import('./kinship.js').Family} full  whole family
   */
  render(fam, full, state, { relayout = true, orientation = "vertical", gens = null, siblingOrder = "auto" } = {}) {
    if (relayout || !this.layout) {
      this.layout = layoutTree(fam, full, { orientation, cardH: cardHeight(state.noteLines), gens, siblingOrder });
    }
    drawLayout(this.viewport, this.layout, { ...state, defs: this.defs }, {
      person: (id) => this.opts.onSelectPerson(id),
      union: (u) => this.opts.onSelectUnion(u),
      hover: this.opts.onHover,
    });
    this._renderMinimap();
    this._apply();
  }

  // --- camera ------------------------------------------------------------------

  _rect() {
    return this.svg.getBoundingClientRect();
  }

  /** Visible drawing area inside the svg (excludes overlays such as the mobile bottom sheet). */
  _area() {
    const r = this._rect();
    const i = this.opts.insets?.() || { top: 0, right: 0, bottom: 0, left: 0 };
    return { x: i.left, y: i.top, w: Math.max(80, r.width - i.left - i.right), h: Math.max(80, r.height - i.top - i.bottom) };
  }

  _apply() {
    const { x, y, k } = this.view;
    this.viewport.setAttribute("transform", `translate(${x},${y}) scale(${k})`);
    this._updateMinimapView();
  }

  animateTo(target, ms = 450) {
    cancelAnimationFrame(this._raf);
    const from = { ...this.view };
    const t0 = performance.now();
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const step = (now) => {
      const t = reduce ? 1 : Math.min(1, (now - t0) / ms);
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      this.view = { x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, k: from.k + (target.k - from.k) * e };
      this._apply();
      if (t < 1) this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
  }

  /** Bring a box (tree coordinates) to the centre of the visible area. */
  fitBox(box, { pad = 48, maxK = 1.15, minK = 0.08, animate = true } = {}) {
    const a = this._area();
    const k = Math.min(maxK, Math.max(minK, Math.min((a.w - pad * 2) / box.w, (a.h - pad * 2) / box.h)));
    const target = { k, x: a.x + a.w / 2 - (box.x + box.w / 2) * k, y: a.y + a.h / 2 - (box.y + box.h / 2) * k };
    if (animate) this.animateTo(target);
    else {
      this.view = target;
      this._apply();
    }
  }

  fit(animate = true) {
    if (this.layout) this.fitBox(this.layout.bounds, { pad: 24, maxK: 1, animate });
  }

  /** Box around the given people (cards plus badges above them). */
  boxOf(ids) {
    const L = this.layout;
    const pts = ids.map((id) => L?.pos.get(id)).filter(Boolean);
    if (!pts.length) return null;
    const x0 = Math.min(...pts.map((p) => p.x)) - L.cw / 2;
    const x1 = Math.max(...pts.map((p) => p.x)) + L.cw / 2;
    const y0 = Math.min(...pts.map((p) => p.y)) - L.ch / 2 - 44;
    const y1 = Math.max(...pts.map((p) => p.y)) + L.ch / 2 + 8;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  focusOn(ids, opts) {
    const box = this.boxOf(ids);
    if (box) this.fitBox(box, { maxK: 0.95, minK: 0.3, ...opts });
  }

  zoomBy(factor, cx, cy) {
    const a = this._area();
    cx ??= a.x + a.w / 2;
    cy ??= a.y + a.h / 2;
    const k = Math.min(3, Math.max(0.06, this.view.k * factor));
    const f = k / this.view.k;
    this.view = { k, x: cx - (cx - this.view.x) * f, y: cy - (cy - this.view.y) * f };
    this._apply();
  }

  _initPanZoom() {
    const svg = this.svg;
    const pointers = new Map();
    let last = null;
    let pinch = null;
    let moved = false;

    svg.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        cancelAnimationFrame(this._raf);
        const r = this._rect();
        this.zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
      },
      { passive: false },
    );
    svg.addEventListener("pointerdown", (e) => {
      cancelAnimationFrame(this._raf);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      moved = false;
      if (pointers.size === 1) last = { x: e.clientX, y: e.clientY };
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) };
      }
    });
    svg.addEventListener("pointermove", (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2 && pinch) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const r = this._rect();
        this.zoomBy(d / pinch.d, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
        pinch.d = d;
        moved = true;
        return;
      }
      if (last) {
        const dx = e.clientX - last.x;
        const dy = e.clientY - last.y;
        if (!moved && Math.hypot(dx, dy) < 5) return;
        if (!moved) {
          svg.setPointerCapture(e.pointerId);
          this.opts.onHover?.(null);
        }
        moved = true;
        svg.classList.add("panning");
        this.view.x += dx;
        this.view.y += dy;
        last = { x: e.clientX, y: e.clientY };
        this._apply();
      }
    });
    const end = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (pointers.size === 1) last = { ...[...pointers.values()][0] };
      if (pointers.size === 0) {
        last = null;
        svg.classList.remove("panning");
      }
    };
    svg.addEventListener("pointerup", end);
    svg.addEventListener("pointercancel", end);
    // a click that ended a drag must not count as a selection
    svg.addEventListener(
      "click",
      (e) => {
        if (moved) {
          e.stopPropagation();
          moved = false;
          return;
        }
        if (e.target === svg) this.opts.onBackground();
      },
      true,
    );
  }

  // --- minimap -------------------------------------------------------------------

  _initMinimap(mini) {
    this.mini = mini;
    this.miniContent = el("g", {}, mini);
    this.miniView = el("rect", { class: "mini-view" }, mini);
    const go = (e) => {
      const r = mini.getBoundingClientRect();
      const vb = mini.viewBox.baseVal;
      if (!vb || !vb.width) return;
      const s = Math.max(vb.width / r.width, vb.height / r.height);
      // preserveAspectRatio xMidYMid meet: content is centred inside the element
      const ox = (r.width - vb.width / s) / 2;
      const oy = (r.height - vb.height / s) / 2;
      const tx = vb.x + (e.clientX - r.left - ox) * s;
      const ty = vb.y + (e.clientY - r.top - oy) * s;
      const a = this._area();
      this.view.x = a.x + a.w / 2 - tx * this.view.k;
      this.view.y = a.y + a.h / 2 - ty * this.view.k;
      this._apply();
    };
    let dragging = false;
    mini.addEventListener("pointerdown", (e) => {
      dragging = true;
      mini.setPointerCapture(e.pointerId);
      cancelAnimationFrame(this._raf);
      go(e);
    });
    mini.addEventListener("pointermove", (e) => dragging && go(e));
    mini.addEventListener("pointerup", () => (dragging = false));
    mini.addEventListener("pointercancel", () => (dragging = false));
  }

  _renderMinimap() {
    const L = this.layout;
    if (!this.mini || !L) return;
    const b = L.bounds;
    this.mini.setAttribute("viewBox", `${b.x} ${b.y} ${b.w} ${b.h}`);
    this.miniContent.replaceChildren();
    for (const l of L.links) el("path", { d: l.d, class: "mini-link" }, this.miniContent);
    for (const [id, q] of L.pos) {
      const p = L.model.fam.get(Math.abs(id));
      el("rect", { x: q.x - L.cw / 2, y: q.y - L.ch / 2, width: L.cw, height: L.ch, rx: 10, class: `mini-card ${p.gender}` }, this.miniContent);
    }
  }

  _updateMinimapView() {
    if (!this.miniView || !this.layout) return;
    const r = this._rect();
    const { x, y, k } = this.view;
    this.miniView.setAttribute("x", -x / k);
    this.miniView.setAttribute("y", -y / k);
    this.miniView.setAttribute("width", r.width / k);
    this.miniView.setAttribute("height", r.height / k);
    this.miniView.setAttribute("stroke-width", Math.max(this.layout.bounds.w, this.layout.bounds.h) / 120);
  }
}
