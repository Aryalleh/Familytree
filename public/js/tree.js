// Family tree layout (dagre over couple blocks) and SVG rendering with pan / zoom / minimap.
import dagre from "../vendor/dagre.esm.js";

export const CARD_W = 172;
export const CARD_H = 62;
const SPOUSE_GAP = 46; // room for the wedding rings between spouses
const RANK_SEP = 78;
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

export function lifeSpan(p) {
  const b = p.birth_date || "";
  const d = p.death_date || "";
  if (!b && !d) return p.is_deceased ? "درگذشته" : "";
  if (!d) return toFa(p.is_deceased ? `${b} – ؟` : b);
  return toFa(`${b || "؟"} – ${d}`);
}

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
 * Married people (and unmarried parent pairs) form one horizontal "block"; dagre ranks the
 * blocks by generation. A cousin marriage just gives a block two parent families — still a DAG.
 * @param {import('./kinship.js').Family} fam  people to draw
 * @param {import('./kinship.js').Family} full the whole family (for consanguinity)
 * @param {{duplicates?: boolean}} opts duplicates: print style — see below
 */
export function layoutTree(fam, full = fam, { duplicates = false } = {}) {
  const has = (id) => id != null && fam.people.has(id);

  // --- unions (couples & single parents) ---------------------------------
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

  // --- blocks: connected components of the marriage graph -----------------
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
    // husbands first by default, so a plain couple reads man | woman before orientation tweaks
    comp.sort((a, b) => (fam.get(a).gender === fam.get(b).gender ? a - b : fam.get(a).gender === "male" ? -1 : 1));
    const block = { key: `b${blocks.length}`, members: orderBlock(comp, adj) };
    block.width = block.members.length * CARD_W + (block.members.length - 1) * SPOUSE_GAP;
    blocks.push(block);
    for (const m of block.members) blockOf.set(m, block);
  }

  // --- duplicates (print): every block keeps at most one parent family -----
  // Someone who married into another branch of the tree (e.g. a cousin) is drawn a second
  // time under their own parents instead of a long crossing line; both copies share a
  // numbered marker. Copies use the negated person id.
  const unions = [...couples.values(), ...singles.values()];
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
      fromOutside.sort((a, c) => (fam.get(a).gender === fam.get(c).gender ? a - c : fam.get(a).gender === "male" ? -1 : 1));
      for (const id of fromOutside.slice(1)) {
        const u = parentUnion.get(id);
        u.children = u.children.map((c) => (c === id ? -id : c));
        const copy = { key: `b${blocks.length}`, members: [-id], width: CARD_W, copy: true };
        blocks.push(copy);
        blockOf.set(-id, copy);
        markers.set(id, markers.size + 1);
      }
    }
  }

  // --- dagre ---------------------------------------------------------------
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: "TB", nodesep: 34, ranksep: RANK_SEP, marginx: 40, marginy: 60 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const b of blocks) g.setNode(b.key, { width: b.width, height: CARD_H });
  for (const u of unions) {
    const src = blockOf.get(u.h ?? u.single);
    for (const c of u.children) {
      const dst = blockOf.get(c);
      if (src !== dst) g.setEdge(src.key, dst.key, { minlen: 1, weight: 1 }, `${u.key}>${c}`);
    }
  }
  dagre.layout(g);

  // --- positions -------------------------------------------------------------
  const pos = new Map();
  const place = (b) => {
    const n = g.node(b.key);
    const left = n.x - b.width / 2;
    b.x = n.x;
    b.y = n.y;
    b.members.forEach((id, i) => pos.set(id, { x: left + i * (CARD_W + SPOUSE_GAP) + CARD_W / 2, y: n.y }));
  };
  const unionOfChild = new Map();
  for (const u of unions) for (const c of u.children) unionOfChild.set(c, u);
  const dropX = (u) => (u.single != null ? pos.get(u.single).x : (pos.get(u.h).x + pos.get(u.w).x) / 2);

  // Top-down, mirror a block when that brings its members closer to their own parents.
  blocks.sort((a, b) => g.node(a.key).y - g.node(b.key).y);
  for (const b of blocks) {
    place(b);
    if (b.members.length < 2) continue;
    const cost = () =>
      b.members.reduce((s, id) => {
        const u = unionOfChild.get(id);
        return u && pos.has(u.h ?? u.single) && blockOf.get(u.h ?? u.single) !== b ? s + Math.abs(pos.get(id).x - dropX(u)) : s;
      }, 0);
    const before = cost();
    b.members.reverse();
    place(b);
    if (cost() >= before) {
      b.members.reverse();
      place(b);
    }
  }

  // --- union drop points ----------------------------------------------------
  for (const u of unions) {
    if (u.single != null) {
      const p = pos.get(u.single);
      Object.assign(u, { x: p.x, y: p.y + CARD_H / 2, kind: "single" });
      continue;
    }
    const b = blockOf.get(u.h);
    const adjacent = Math.abs(b.members.indexOf(u.h) - b.members.indexOf(u.w)) === 1;
    const [h, w] = [pos.get(u.h), pos.get(u.w)];
    u.kind = adjacent ? "ring" : "arc";
    u.x = (h.x + w.x) / 2;
    u.y = adjacent ? h.y : h.y + CARD_H / 2 + 18;
    u.consanguinity = u.marriage ? full.consanguinity(u.marriage) : null;
  }

  // --- connectors to children ---------------------------------------------
  const links = [];
  for (const u of unions) {
    const src = blockOf.get(u.h ?? u.single);
    for (const c of u.children) {
      const p = pos.get(c);
      const top = p.y - CARD_H / 2;
      const rowBottom = src.y + CARD_H / 2;
      const long = top - rowBottom > RANK_SEP + 8;
      let d;
      if (!long) {
        const bus = rowBottom + (top - rowBottom) / 2;
        d = `M${u.x},${u.y} V${bus} H${p.x} V${top}`;
      } else {
        const e = blockOf.get(c) !== src ? g.edge(src.key, blockOf.get(c).key, `${u.key}>${c}`) : null;
        const mids = (e?.points || []).slice(1, -1);
        const pts = [{ x: u.x, y: rowBottom + 16 }, ...mids, { x: p.x, y: top - 16 }];
        d = `M${u.x},${u.y} V${pts[0].y}`;
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1];
          const b2 = pts[i];
          const my = (a.y + b2.y) / 2;
          d += ` C${a.x},${my} ${b2.x},${my} ${b2.x},${b2.y}`;
        }
        d += ` V${top}`;
      }
      links.push({ d, union: u, child: c, long });
    }
  }

  // --- generation rows -------------------------------------------------------
  const rowMap = new Map();
  for (const b of blocks) {
    const y = Math.round(b.y);
    if (!rowMap.has(y)) rowMap.set(y, []);
    rowMap.get(y).push(...b.members);
  }
  const rows = [...rowMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([y, ids], i) => {
      const years = ids.filter((id) => id > 0).map((id) => yearOf(fam.get(id).birth_date)).filter((x) => x);
      const avg = years.length ? Math.round(years.reduce((s, x) => s + x, 0) / years.length / 10) * 10 : null;
      return { y, gen: i + 1, year: avg };
    });

  const gg = g.graph();
  const LABEL_COL = 150;
  return {
    pos,
    blocks,
    unions,
    markers,
    links,
    rows,
    labelX: -LABEL_COL / 2,
    bounds: { x: -LABEL_COL, y: 0, w: (gg.width || 400) + LABEL_COL, h: gg.height || 300 },
  };
}

// ---------------------------------------------------------------------------

function el(tag, attrs = {}, parent) {
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
  const tip = el("title", {}, t);
  tip.textContent = full;
}

function rings(parent, x, y, cls) {
  const g = el("g", { class: `rings ${cls}`, transform: `translate(${x},${y})` }, parent);
  el("circle", { r: 13, class: "ring-bg" }, g);
  el("circle", { cx: -4.5, r: 6.5, class: "ring" }, g);
  el("circle", { cx: 4.5, r: 6.5, class: "ring" }, g);
  return g;
}

export class TreeView {
  /**
   * @param {SVGSVGElement} svg
   * @param {{onSelectPerson:Function, onSelectUnion:Function, onBackground:Function, minimap?:SVGSVGElement, insets?:()=>{top:number,right:number,bottom:number,left:number}}} opts
   */
  constructor(svg, opts) {
    this.svg = svg;
    this.opts = opts;
    this.view = { x: 0, y: 0, k: 1 };
    this.layout = null;
    this._initDefs();
    this.viewport = el("g", { class: "viewport" }, svg);
    this._initPanZoom();
    if (opts.minimap) this._initMinimap(opts.minimap);
    new ResizeObserver(() => this._apply()).observe(svg);
  }

  _initDefs() {
    const defs = el("defs", {}, this.svg);
    const f = el("filter", { id: "card-shadow", x: "-20%", y: "-30%", width: "140%", height: "170%" }, defs);
    el("feDropShadow", { dx: 0, dy: 2, stdDeviation: 2.5, "flood-color": "#0f172a", "flood-opacity": 0.12 }, f);
    const clip = el("clipPath", { id: "avatar-clip" }, defs);
    el("circle", { cx: 0, cy: 0, r: 20 }, clip);
  }

  /**
   * @param {import('./kinship.js').Family} fam   people to draw
   * @param {import('./kinship.js').Family} full  whole family
   */
  render(fam, full, state, { relayout = true, duplicates = false } = {}) {
    if (relayout || !this.layout) this.layout = layoutTree(fam, full, { duplicates });
    const L = this.layout;
    const { pos } = L;
    this.viewport.replaceChildren();
    const rowLayer = el("g", { class: "rows" }, this.viewport);
    const linkLayer = el("g", { class: "links" }, this.viewport);
    const unionLayer = el("g", { class: "unions" }, this.viewport);
    const cardLayer = el("g", { class: "cards" }, this.viewport);
    const hl = state.highlight || new Set();
    const hlUnions = state.highlightUnions || new Set();
    const kin = state.kin || new Set();

    // generation labels
    for (const r of L.rows) {
      const g = el("g", { class: "gen-label", transform: `translate(${L.labelX},${r.y})` }, rowLayer);
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
      const h = pos.get(u.h);
      const w = pos.get(u.w);
      const base = ["spouse-line", status, hlUnions.has(u.key) ? "hl" : ""].filter(Boolean).join(" ");
      if (u.kind === "ring") {
        const [x1, x2] = h.x < w.x ? [h.x + CARD_W / 2, w.x - CARD_W / 2] : [w.x + CARD_W / 2, h.x - CARD_W / 2];
        el("line", { x1, y1: u.y, x2, y2: u.y, class: base }, linkLayer);
      } else {
        const by = h.y + CARD_H / 2;
        el("path", { d: `M${h.x},${by} C${h.x},${u.y + 8} ${w.x},${u.y + 8} ${w.x},${by}`, class: base }, linkLayer);
      }
      if (!u.marriage) continue;
      const g = rings(unionLayer, u.x, u.y, status);
      g.setAttribute("tabindex", "0");
      g.addEventListener("click", (e) => {
        e.stopPropagation();
        this.opts.onSelectUnion(u);
      });
      const title = el("title", {}, g);
      title.textContent = "ازدواج";
    }

    const entries = [...fam.people.values()].map((p) => ({ p, key: p.id, copy: false }));
    for (const b of L.blocks) if (b.copy) entries.push({ p: fam.get(-b.members[0]), key: b.members[0], copy: true });
    for (const { p, key, copy } of entries) {
      const { x, y } = pos.get(key);
      const rels = state.relationsTo ? state.relationsTo(p.id) : [];
      const primary = rels[0];
      const classes = [
        "card",
        p.gender,
        copy ? "copy" : "",
        p.is_deceased ? "deceased" : "",
        p.id === state.selectedId ? "selected" : "",
        kin.has(p.id) ? "kin" : "",
        p.id === state.focusId ? "focus" : "",
        hl.size && !hl.has(p.id) ? "dim" : "",
        hl.has(p.id) ? "hl" : "",
      ];
      const g = el("g", { class: classes.filter(Boolean).join(" "), transform: `translate(${x - CARD_W / 2},${y - CARD_H / 2})`, tabindex: 0, role: "button" }, cardLayer);
      g.addEventListener("click", (e) => {
        e.stopPropagation();
        this.opts.onSelectPerson(p.id);
      });
      g.addEventListener("keydown", (e) => e.key === "Enter" && this.opts.onSelectPerson(p.id));
      el("rect", { width: CARD_W, height: CARD_H, rx: 12, class: "card-bg", filter: "url(#card-shadow)" }, g);

      // avatar on the left, text on the right (RTL)
      const ag = el("g", { transform: `translate(32,${CARD_H / 2})` }, g);
      el("circle", { r: 21, class: "avatar-bg" }, ag);
      if (p.photo_url) {
        el("image", { href: p.photo_url, x: -20, y: -20, width: 40, height: 40, "clip-path": "url(#avatar-clip)", preserveAspectRatio: "xMidYMid slice" }, ag);
      } else {
        const sil = el("g", { "clip-path": "url(#avatar-clip)", class: "silhouette" }, ag);
        el("circle", { cy: -5, r: 8 }, sil);
        el("ellipse", { cy: 17, rx: 15, ry: 11 }, sil);
      }
      if (p.is_deceased) el("path", { d: "M9,-20 L20,-9 L20,-4 L4,-20 Z", class: "ribbon" }, ag);

      const name = `${p.first_name} ${p.last_name || ""}`.trim();
      const maxW = CARD_W - 12 - 62;
      fitText(text(g, name, { x: CARD_W - 12, y: 27, class: "card-name", "text-anchor": "start", direction: "rtl" }), maxW);
      const span = lifeSpan(p);
      if (span) fitText(text(g, `(${span})`, { x: CARD_W - 12, y: 47, class: "card-sub", "text-anchor": "start", direction: "rtl" }), maxW);
      const tip = el("title", {}, g);
      tip.textContent = rels.length ? `${name}\n${rels.map((r) => r.label).join("، ")}` : name;

      if (primary) {
        const extra = rels.length > 1 ? ` +${toFa(rels.length - 1)}` : "";
        const label = primary.kind === "self" ? "★ من" : primary.label + extra;
        const bw = Math.min(label.length * 7 + 20, CARD_W);
        const bg = el("g", { class: `rel-badge kind-${primary.kind}`, transform: `translate(${CARD_W / 2},0)` }, g);
        el("rect", { x: -bw / 2, y: -11, width: bw, height: 21, rx: 10.5 }, bg);
        text(bg, label, { "text-anchor": "middle", dy: "0.35em", direction: "rtl" });
      }
      const marker = L.markers.get(p.id);
      if (marker) {
        // same number on both copies of a person drawn twice (print view)
        const mg = el("g", { class: "dup-marker", transform: "translate(4,4)" }, g);
        el("circle", { r: 11 }, mg);
        text(mg, toFa(marker), { "text-anchor": "middle", dy: "0.36em" });
        const mt = el("title", {}, mg);
        mt.textContent = copy ? "همین شخص در جای دیگر درخت، کنار همسرش، هم آمده است" : "همین شخص زیر خانوادهٔ پدر و مادرش هم آمده است";
      }
    }
    this._renderMinimap(fam);
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

  /** Print: show the whole tree scaled to the page via viewBox instead of the camera. */
  setPrintView(on) {
    this.printing = on;
    if (on && this.layout) {
      const b = this.layout.bounds;
      this.svg.setAttribute("viewBox", `${b.x} ${b.y} ${b.w} ${b.h}`);
      this.svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
      this.viewport.removeAttribute("transform");
    } else {
      this.svg.removeAttribute("viewBox");
      this._apply();
    }
  }

  _apply() {
    if (this.printing) return;
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

  /** Box around the given people (cards plus badges/labels above them). */
  boxOf(ids) {
    const pts = ids.map((id) => this.layout?.pos.get(id)).filter(Boolean);
    if (!pts.length) return null;
    const x0 = Math.min(...pts.map((p) => p.x)) - CARD_W / 2;
    const x1 = Math.max(...pts.map((p) => p.x)) + CARD_W / 2;
    const y0 = Math.min(...pts.map((p) => p.y)) - CARD_H / 2 - 44;
    const y1 = Math.max(...pts.map((p) => p.y)) + CARD_H / 2 + 8;
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
        if (!moved) svg.setPointerCapture(e.pointerId);
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

  _renderMinimap(fam) {
    if (!this.mini || !this.layout) return;
    const b = this.layout.bounds;
    this.mini.setAttribute("viewBox", `${b.x} ${b.y} ${b.w} ${b.h}`);
    this.miniContent.replaceChildren();
    for (const l of this.layout.links) el("path", { d: l.d, class: "mini-link" }, this.miniContent);
    for (const p of fam.people.values()) {
      const q = this.layout.pos.get(p.id);
      el("rect", { x: q.x - CARD_W / 2, y: q.y - CARD_H / 2, width: CARD_W, height: CARD_H, rx: 10, class: `mini-card ${p.gender}` }, this.miniContent);
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
