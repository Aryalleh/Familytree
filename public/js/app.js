import { Family, KIND_LABELS } from "./kinship.js";
import { TreeView, lifeSpan, toFa } from "./tree.js";

// ---------------------------------------------------------------------------
// utilities

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

async function api(method, path, data) {
  const res = await fetch(path, {
    method,
    headers: data !== undefined ? { "Content-Type": "application/json" } : {},
    body: data !== undefined ? JSON.stringify(data) : undefined,
    credentials: "same-origin",
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    // non-JSON response
  }
  if (!res.ok) {
    if (res.status === 401 && S.user) {
      S.user = null;
      boot();
    }
    throw new Error(payload?.error || `خطا (${res.status})`);
  }
  return payload;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "show" + (isError ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ""), 3200);
}

const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      // storage unavailable
    }
  },
};

const normalize = (s) => String(s || "").replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/‌/g, " ").toLowerCase();

// ---------------------------------------------------------------------------
// state

const S = {
  status: null,
  user: null,
  people: [],
  marriages: [],
  fam: new Family([], []),
  focusId: null,
  selectedId: null,
  selectedUnion: null,
  highlight: new Set(),
  highlightUnions: new Set(),
  relCache: new Map(),
  tree: null,
  mode: store.get("ft_mode") === "family" ? "family" : "all",
  panelTab: "family",
  compareId: null,
};

const canEdit = () => S.user && (S.user.role === "admin" || S.user.role === "editor");
const isAdmin = () => S.user?.role === "admin";
const ROLE_FA = { admin: "مدیر", editor: "ویرایشگر", viewer: "بیننده" };
const STATUS_FA = { married: "متأهل", divorced: "جداشده", widowed: "فوت همسر" };

function person(id) {
  return S.fam.get(id);
}
function fullName(p) {
  if (!p) return "؟";
  return `${p.first_name} ${p.last_name || ""}`.trim();
}
function relationsTo(id) {
  if (S.focusId == null) return [];
  if (!S.relCache.has(id)) S.relCache.set(id, S.fam.relations(S.focusId, id));
  return S.relCache.get(id);
}
function setFocus(id) {
  S.focusId = id;
  S.relCache.clear();
  store.set(`ft_focus_${S.user.id}`, id == null ? null : String(id));
}

// ---------------------------------------------------------------------------
// boot & auth screens

async function boot() {
  try {
    S.status = await api("GET", "/api/status");
  } catch (e) {
    $("#app").innerHTML = `<div class="boot">${esc(e.message)}</div>`;
    return;
  }
  S.user = S.status.user;
  if (S.status.setupRequired) renderAuth("setup");
  else if (!S.user) renderAuth("login");
  else renderMain();
}

function renderAuth(mode) {
  const titles = {
    setup: ["ساخت حساب مدیر", "هنوز هیچ حسابی وجود ندارد. نخستین کسی که ثبت‌نام کند، مدیر شجره‌نامه می‌شود."],
    login: ["ورود به شجره‌نامه", "برای دیدن و ویرایش شجره‌نامه وارد شوید."],
    register: ["ثبت‌نام", "حساب تازه با دسترسی «بیننده» ساخته می‌شود؛ مدیر می‌تواند سطح دسترسی را تغییر دهد."],
  };
  const [title, desc] = titles[mode];
  $("#app").innerHTML = `
    <div class="auth">
      <form class="auth-card" novalidate>
        <div class="logo">🌳</div>
        <h1>${title}</h1>
        <p class="muted">${desc}</p>
        ${mode !== "login" ? `<label class="field"><span>نام نمایشی</span><input class="input" name="display_name" autocomplete="name"></label>` : ""}
        <label class="field"><span>نام کاربری</span><input class="input" name="username" required autocomplete="username" dir="ltr"></label>
        <label class="field"><span>رمز عبور</span><input class="input" type="password" name="password" required autocomplete="${mode === "login" ? "current-password" : "new-password"}" dir="ltr"></label>
        ${mode !== "login" ? `<label class="field"><span>تکرار رمز عبور</span><input class="input" type="password" name="password2" required autocomplete="new-password" dir="ltr"></label>` : ""}
        <div class="error"></div>
        <button class="btn primary" type="submit">${mode === "setup" ? "ساخت حساب مدیر" : mode === "login" ? "ورود" : "ثبت‌نام"}</button>
        ${
          mode === "login" && S.status.allowRegistration
            ? `<div class="auth-switch">حساب ندارید؟ <a href="#" data-go="register">ثبت‌نام</a></div>`
            : mode === "register"
              ? `<div class="auth-switch"><a href="#" data-go="login">بازگشت به ورود</a></div>`
              : ""
        }
      </form>
    </div>`;
  const form = $(".auth-card");
  $$("[data-go]", form).forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      renderAuth(a.dataset.go);
    }),
  );
  form.username.focus();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $(".error", form);
    const data = Object.fromEntries(new FormData(form));
    if (mode !== "login" && data.password !== data.password2) {
      err.textContent = "رمزهای عبور یکسان نیستند";
      return;
    }
    delete data.password2;
    const btn = $("button[type=submit]", form);
    btn.disabled = true;
    try {
      const res = await api("POST", `/api/${mode}`, data);
      S.user = res.user;
      if (mode === "setup") toast("حساب مدیر ساخته شد. خوش آمدید!");
      renderMain();
    } catch (ex) {
      err.textContent = ex.message;
      if (mode === "setup" && /قبلاً/.test(ex.message)) setTimeout(boot, 1200);
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------------
// main screen

function renderMain() {
  const u = S.user;
  $("#app").innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand"><span class="brand-logo">🌳</span><span class="brand-name">شجره‌نامه خاندان</span></div>
        <nav class="nav">
          <button class="nav-btn active" data-act="map"><span class="ico">🗺️</span><span class="lbl">نقشه</span></button>
          <button class="nav-btn" data-act="list"><span class="ico">👥</span><span class="lbl">فهرست افراد</span></button>
          <button class="nav-btn" data-act="finder"><span class="ico">🔗</span><span class="lbl">خویشاوندی</span></button>
          ${canEdit() ? `<button class="nav-btn" data-act="add"><span class="ico">＋</span><span class="lbl">افزودن شخص</span></button>` : ""}
          ${isAdmin() ? `<button class="nav-btn" data-act="users"><span class="ico">⚙️</span><span class="lbl">مدیریت</span></button>` : ""}
        </nav>
        <div class="spacer"></div>
        <button class="btn print-btn" data-act="print"><span>🖨️</span><span class="lbl">چاپ / PDF</span></button>
        <div class="search">
          <input class="input" type="search" placeholder="جست‌وجوی نام…" aria-label="جست‌وجو">
          <div class="search-results" hidden></div>
        </div>
        <div class="user-menu">
          <button class="user-btn" data-act="account" title="حساب کاربری">
            <span class="user-avatar">${esc((u.display_name || u.username).charAt(0))}</span>
            <span class="user-name">${esc(u.display_name || u.username)}<small>${ROLE_FA[u.role]}</small></span>
          </button>
          <button class="btn ghost small" data-act="logout" title="خروج">⎋<span class="lbl"> خروج</span></button>
        </div>
      </header>
      <div class="main no-panel">
        <div class="canvas-wrap">
          <svg class="tree" aria-label="نمودار شجره‌نامه"></svg>
          <div class="empty" hidden></div>
          <div class="toolbar">
            <button data-zoom="in" title="بزرگ‌نمایی"><span class="ico">＋</span><span class="lbl">بزرگ‌نمایی</span></button>
            <button data-zoom="out" title="کوچک‌نمایی"><span class="ico">－</span><span class="lbl">کوچک‌نمایی</span></button>
            <button data-zoom="center" title="مرکز نقشه"><span class="ico">◎</span><span class="lbl">مرکز نقشه</span></button>
            <button data-zoom="fit" title="نمایش کل درخت"><span class="ico">⤢</span><span class="lbl">کل درخت</span></button>
            <button data-zoom="mode" title="حالت نمایش"><span class="ico">👁</span><span class="lbl mode-lbl"></span></button>
            <button data-zoom="me" title="رفتن به «من»"><span class="ico">★</span><span class="lbl">من</span></button>
            <button data-zoom="legend" title="راهنما"><span class="ico">?</span><span class="lbl">راهنما</span></button>
          </div>
          <div class="minimap-wrap"><svg class="minimap" preserveAspectRatio="xMidYMid meet" aria-label="نقشهٔ کوچک"></svg></div>
          <div class="legend"></div>
        </div>
        <aside class="panel" hidden></aside>
      </div>
    </div>`;

  S.tree = new TreeView($("svg.tree"), {
    onSelectPerson: (id) => selectPerson(id),
    onSelectUnion: (u) => selectUnion(u),
    onBackground: () => clearSelection(),
    minimap: $("svg.minimap"),
    insets: viewInsets,
  });

  $("[data-act=map]").addEventListener("click", () => S.tree.fit());
  $("[data-act=add]")?.addEventListener("click", () => openPersonForm({}));
  $("[data-act=list]").addEventListener("click", () => openPeopleList());
  $("[data-act=finder]").addEventListener("click", () => openFinder());
  $("[data-act=users]")?.addEventListener("click", () => openAdmin());
  $("[data-act=account]").addEventListener("click", () => openAccount());
  $("[data-act=print]").addEventListener("click", () => {
    enterPrint();
    window.print();
  });
  window.addEventListener("beforeprint", enterPrint);
  window.addEventListener("afterprint", exitPrint);
  $("[data-act=logout]").addEventListener("click", async () => {
    await api("POST", "/api/logout", {}).catch(() => {});
    S.user = null;
    boot();
  });
  $$("[data-zoom]").forEach((b) => b.addEventListener("click", () => toolbarAction(b.dataset.zoom)));
  updateModeLabel();
  initSearch();
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#modal-root").children.length) clearSelection();
  });
  loadTree({ fit: true });
}

/** Parts of the canvas covered by floating UI, so "centre" means the visible centre. */
function viewInsets() {
  const svg = $("svg.tree");
  if (!svg) return { top: 0, right: 0, bottom: 0, left: 0 };
  const r = svg.getBoundingClientRect();
  const ins = { top: 0, right: 0, bottom: 0, left: 0 };
  const tb = $(".toolbar")?.getBoundingClientRect();
  if (tb && tb.height > tb.width) ins.left = Math.max(0, tb.right - r.left + 8);
  else if (tb) ins.bottom = Math.max(ins.bottom, r.bottom - tb.top + 8);
  const lg = $(".legend");
  if (lg && lg.offsetParent) ins.bottom = Math.max(ins.bottom, r.bottom - lg.getBoundingClientRect().top + 8);
  const panel = $(".panel");
  if (panel && !panel.hidden && getComputedStyle(panel).position === "absolute") {
    ins.bottom = Math.max(ins.bottom, r.bottom - panel.getBoundingClientRect().top + 8);
  }
  return ins;
}

function toolbarAction(z) {
  const t = S.tree;
  if (z === "in") t.zoomBy(1.25);
  else if (z === "out") t.zoomBy(0.8);
  else if (z === "fit") t.fit();
  else if (z === "center") {
    if (S.selectedId != null && person(S.selectedId)) focusFamily(S.selectedId);
    else t.fit();
  } else if (z === "mode") {
    S.mode = S.mode === "family" ? "all" : "family";
    store.set("ft_mode", S.mode);
    updateModeLabel();
    if (S.mode === "family" && familyRoot() == null) toast("یک نفر را انتخاب کنید تا فقط خانوادهٔ نزدیکش نمایش داده شود");
    redraw(true);
    const root = familyRoot();
    if (root != null) focusFamily(root);
    else t.fit();
  } else if (z === "me") {
    if (S.focusId && person(S.focusId)) selectPerson(S.focusId);
    else toast("ابتدا یک نفر را به‌عنوان «من» انتخاب کنید");
  } else if (z === "legend") {
    store.set("ft_legend", store.get("ft_legend") === "0" ? "1" : "0");
    renderLegend();
  }
}

function updateModeLabel() {
  const l = $(".mode-lbl");
  if (l) l.textContent = S.mode === "family" ? "خانوادهٔ نزدیک" : "کل خاندان";
  $("[data-zoom=mode]")?.classList.toggle("on", S.mode === "family");
}

async function loadTree({ fit = false } = {}) {
  try {
    const [data] = await Promise.all([api("GET", "/api/tree"), document.fonts?.ready]);
    S.people = data.people;
    S.marriages = data.marriages;
    S.fam = new Family(S.people, S.marriages);
    S.relCache.clear();
    if (S.focusId == null) {
      const saved = Number(store.get(`ft_focus_${S.user.id}`));
      if (saved && person(saved)) S.focusId = saved;
    }
    if (S.focusId != null && !person(S.focusId)) setFocus(null);
    if (S.selectedId != null && !person(S.selectedId)) S.selectedId = null;
    if (S.selectedUnion) {
      S.selectedUnion = null;
      S.highlight.clear();
      S.highlightUnions.clear();
    }
    redraw(true);
    renderPanel();
    if (fit) {
      S.tree.fit(false);
      if (S.focusId != null) S.tree.focusOn(familyIds(S.focusId), { animate: false });
    } else if (S.selectedId != null) focusFamily(S.selectedId);
  } catch (e) {
    toast(e.message, true);
  }
}

function familyRoot() {
  if (S.selectedId != null && person(S.selectedId)) return S.selectedId;
  if (S.focusId != null && person(S.focusId)) return S.focusId;
  return null;
}

/** The person, their spouses and children — what comes to the centre on selection. */
function familyIds(id) {
  return [id, ...S.fam.spousesOf(id).map((s) => s.id), ...S.fam.childrenOf(id)];
}

/** Close family of `id` for the "خانوادهٔ نزدیک" view. */
function closeFamily(id) {
  const f = S.fam;
  const set = new Set([id]);
  const add = (ids) => ids.forEach((x) => set.add(x));
  const parents = f.parentsOf(id);
  add(parents);
  parents.forEach((p) => add(f.parentsOf(p)));
  add(f.siblingsOf(id));
  const spouses = f.spousesOf(id).map((s) => s.id);
  add(spouses);
  spouses.forEach((s) => add(f.parentsOf(s)));
  const children = f.childrenOf(id);
  add(children);
  children.forEach((c) => {
    add(f.spousesOf(c).map((s) => s.id));
    add(f.childrenOf(c));
  });
  return new Family(
    S.people.filter((p) => set.has(p.id)),
    S.marriages.filter((m) => set.has(m.husband_id) && set.has(m.wife_id)),
  );
}

function shownFamily() {
  const root = S.mode === "family" ? familyRoot() : null;
  return root != null ? closeFamily(root) : S.fam;
}

function redraw(relayout = false) {
  const empty = $(".empty");
  if (!S.people.length) {
    empty.hidden = false;
    empty.innerHTML = `<div class="box">
      <div class="big">🌱</div>
      <h2>شجره‌نامه هنوز خالی است</h2>
      <p class="muted">${canEdit() ? "با افزودن نخستین نفر (مثلاً خودتان یا بزرگ خاندان) شروع کنید. سپس از پنل کناری پدر، مادر، همسر و فرزندان را اضافه کنید." : "هنوز کسی به شجره‌نامه اضافه نشده است."}</p>
      ${canEdit() ? `<button class="btn primary" id="first-person">افزودن نخستین نفر</button>` : ""}
    </div>`;
    $("#first-person")?.addEventListener("click", () => openPersonForm({}));
  } else empty.hidden = true;

  const kin = new Set(S.selectedId != null && person(S.selectedId) ? familyIds(S.selectedId).slice(1) : []);
  const state = S.printing
    ? { focusId: S.focusId, relationsTo }
    : { focusId: S.focusId, selectedId: S.selectedId, kin, highlight: S.highlight, highlightUnions: S.highlightUnions, relationsTo };
  S.tree.render(shownFamily(), S.fam, state, { relayout: relayout || S.printing, duplicates: S.printing });
  if (S.printing) S.tree.setPrintView(true);
  renderLegend();
}

/**
 * Print version: people who married into another branch are drawn a second time under
 * their own parents (with a matching numbered marker) instead of long crossing lines.
 */
function enterPrint() {
  if (S.printing || !S.tree) return;
  S.printing = true;
  redraw(true);
}

function exitPrint() {
  if (!S.printing) return;
  S.printing = false;
  S.tree.setPrintView(false);
  redraw(true);
}

function renderLegend() {
  const lg = $(".legend");
  const collapsed = store.get("ft_legend") === "0";
  const focus = person(S.focusId);
  const kinds = ["self", "spouse", "parent", "child", "sibling", "blood", "inlaw", "step"];
  lg.hidden = collapsed && !S.printing;
  lg.innerHTML = `
    <div class="legend-row">
      <b>راهنمای نمادها:</b>
      <span><i class="sw male"></i>مرد</span>
      <span><i class="sw female"></i>زن</span>
      <span><i class="sw rings-sw">⚭</i>ازدواج</span>
      <span><i class="sw line"></i>فرزند</span>
      <span class="no-print"><i class="sw selected"></i>فرد منتخب</span>
      <span><i class="sw long"></i>شاخه‌های دیگر</span>
      <span><i class="sw ribbon"></i>درگذشته</span>
      ${S.printing && S.tree?.layout?.markers.size ? `<span><i class="sw marker">۱</i>شمارهٔ یکسان = یک نفر که دو جا آمده (زیر پدر و مادرش و کنار همسرش)</span>` : ""}
    </div>
    ${
      focus
        ? `<div class="legend-row kinds"><b>نسبت با ${esc(fullName(focus))}:</b>${kinds.map((k) => `<span><i class="sw dot" style="background:var(--k-${k})"></i>${KIND_LABELS[k]}</span>`).join("")}</div>`
        : `<div class="legend-row muted no-print">برای دیدن نسبت هر نفر روی کارتش، یک نفر را «★ من» قرار دهید.</div>`
    }`;
}

function selectPerson(id, { focus = true } = {}) {
  S.selectedId = id;
  S.selectedUnion = null;
  S.highlight.clear();
  S.highlightUnions.clear();
  redraw(S.mode === "family");
  renderPanel();
  if (focus) requestAnimationFrame(() => focusFamily(id));
}

function focusFamily(id) {
  S.tree.focusOn(familyIds(id));
}

function selectUnion(u) {
  S.selectedUnion = u;
  S.selectedId = null;
  S.highlight.clear();
  S.highlightUnions.clear();
  if (u.consanguinity) highlightLink(u.consanguinity);
  S.highlight.add(u.h).add(u.w);
  S.highlightUnions.add(u.key);
  redraw();
  renderPanel();
  const ids = u.consanguinity ? [...u.consanguinity.upPath, ...u.consanguinity.downPath] : [u.h, u.w, ...u.children];
  requestAnimationFrame(() => S.tree.focusOn(ids));
}

function clearSelection() {
  if (S.selectedId == null && !S.selectedUnion && !S.highlight.size) return;
  S.selectedId = null;
  S.selectedUnion = null;
  S.highlight.clear();
  S.highlightUnions.clear();
  redraw(S.mode === "family");
  renderPanel();
}

/** Highlight the blood line between two people through their common ancestor. */
function highlightLink(link) {
  const path = [...link.upPath, ...link.downPath.slice(1)];
  for (const id of path) S.highlight.add(id);
  const unions = S.tree.layout?.unions || [];
  for (let i = 0; i + 1 < path.length; i++) {
    const [a, b] = [path[i], path[i + 1]];
    for (const u of unions) {
      const parents = [u.h, u.w, u.single];
      if ((u.children.includes(a) && parents.includes(b)) || (u.children.includes(b) && parents.includes(a))) S.highlightUnions.add(u.key);
    }
  }
}

// ---------------------------------------------------------------------------
// side panel

function chip(id) {
  const p = person(id);
  if (!p) return "";
  return `<button class="chip ${p.gender}" data-goto="${p.id}">${esc(fullName(p))}</button>`;
}

function pills(rels) {
  return rels.map((r) => `<span class="pill kind-${r.kind}">${esc(r.label)}</span>`).join("");
}

function avatar(p, cls = "") {
  return `<span class="mini-avatar ${p.gender} ${cls}">${p.photo_url ? `<img src="${esc(p.photo_url)}" alt="">` : ""}</span>`;
}

/** One clickable person row: avatar, name, years, optional role on the left. */
function prow(id, role = "", extra = "") {
  const p = person(id);
  if (!p) return "";
  const span = lifeSpan(p);
  return `<button class="prow" data-goto="${p.id}">
    ${avatar(p)}
    <span class="prow-name">${esc(fullName(p))}${span ? ` <span class="muted">(${esc(span)})</span>` : ""}${extra}</span>
    ${role ? `<span class="prow-role ${p.gender}">${role}</span>` : ""}
  </button>`;
}

function renderPanel() {
  const panel = $(".panel");
  const main = $(".main");
  if (!panel) return;
  if (S.selectedUnion) return renderUnionPanel(panel, main);
  const p = person(S.selectedId);
  if (!p) {
    panel.hidden = true;
    main.classList.add("no-panel");
    return;
  }
  panel.hidden = false;
  main.classList.remove("no-panel");

  const focus = person(S.focusId);
  const rels = focus && focus.id !== p.id ? relationsTo(p.id) : [];
  const groups = S.fam.relativeGroups(p.id).filter((g) => !["پدر", "مادر", "همسر", "شوهر", "پسران", "دختران"].includes(g.title));
  const spouses = S.fam.spousesOf(p.id);
  const children = S.fam.childrenOf(p.id);
  const editor = canEdit();
  const tab = S.panelTab;
  const span = lifeSpan(p);

  const familyTab = `
    <div class="psec"><h4>والدین</h4>
      ${p.father_id && person(p.father_id) ? prow(p.father_id, "پدر") : editor ? `<button class="add-row" data-add="father">＋ افزودن پدر</button>` : `<div class="muted">پدر ثبت نشده</div>`}
      ${p.mother_id && person(p.mother_id) ? prow(p.mother_id, "مادر") : editor ? `<button class="add-row" data-add="mother">＋ افزودن مادر</button>` : `<div class="muted">مادر ثبت نشده</div>`}
    </div>
    <div class="psec"><h4>${p.gender === "male" ? "همسرها" : "همسر"}</h4>
      ${spouses
        .map(({ id, marriage: m }) => {
          const cons = S.fam.consanguinity(m);
          const consLabel = cons ? (p.id === m.husband_id ? cons.wifeToHusband : cons.husbandToWife) : "";
          const extra = `<span class="prow-meta">${STATUS_FA[m.status]}${m.marriage_date ? ` · تاریخ ازدواج: ${esc(toFa(m.marriage_date))}` : ""}</span>
            ${cons ? `<span class="pill kind-blood">${esc(consLabel)}</span>` : ""}`;
          return `<div class="marriage-wrap">${prow(id, "", extra)}<button class="btn ghost small" data-marriage="${m.id}">جزئیات ازدواج</button></div>`;
        })
        .join("")}
      ${editor ? `<button class="add-row" data-add="spouse">＋ افزودن ${p.gender === "male" ? "همسر" : "شوهر"}</button>` : !spouses.length ? `<div class="muted">ثبت نشده</div>` : ""}
    </div>
    <div class="psec"><h4>فرزندان ${children.length ? `<span class="muted">(${toFa(children.length)} نفر)</span>` : ""}</h4>
      ${children.map((c) => prow(c, person(c).gender === "male" ? "♂ پسر" : "♀ دختر")).join("")}
      ${editor ? `<div class="add-pair"><button class="add-row" data-add="son">＋ پسر</button><button class="add-row" data-add="daughter">＋ دختر</button></div>` : !children.length ? `<div class="muted">ثبت نشده</div>` : ""}
    </div>
    ${editor && (p.father_id || p.mother_id) ? `<div class="add-pair"><button class="add-row" data-add="brother">＋ برادر</button><button class="add-row" data-add="sister">＋ خواهر</button></div>` : ""}
    ${groups.map((g) => `<div class="psec"><h4>${g.title}</h4><div class="chips">${g.ids.map(chip).join("")}</div></div>`).join("")}`;

  const infoTab = `
    <dl class="facts">
      <dt>نام</dt><dd>${esc(p.first_name)}</dd>
      ${p.last_name ? `<dt>نام خانوادگی</dt><dd>${esc(p.last_name)}</dd>` : ""}
      ${p.nickname ? `<dt>لقب</dt><dd>${esc(p.nickname)}</dd>` : ""}
      <dt>جنسیت</dt><dd>${p.gender === "male" ? "مرد" : "زن"}</dd>
      ${p.birth_date ? `<dt>تولد</dt><dd>${esc(toFa(p.birth_date))}</dd>` : ""}
      ${p.birth_place ? `<dt>محل تولد</dt><dd>${esc(p.birth_place)}</dd>` : ""}
      ${p.is_deceased ? `<dt>وفات</dt><dd>${esc(toFa(p.death_date) || "درگذشته")}</dd>` : ""}
      <dt>شناسه</dt><dd>P-${toFa(String(p.id).padStart(4, "0"))}</dd>
    </dl>
    ${editor ? `<div class="actions"><button class="btn small" data-act="edit">✎ ویرایش</button><button class="btn small danger" data-act="delete">حذف</button></div>` : ""}`;

  const notesTab = p.notes ? `<div class="notes">${esc(p.notes)}</div>` : `<p class="muted">یادداشتی ثبت نشده است.</p>${editor ? `<button class="btn small" data-act="edit">✎ افزودن یادداشت</button>` : ""}`;

  const others = S.people.filter((x) => x.id !== p.id);
  const otherId = S.compareId && S.compareId !== p.id && person(S.compareId) ? S.compareId : focus && focus.id !== p.id ? focus.id : null;

  panel.innerHTML = `
    <div class="pcard">
      <div class="pcard-head"><h3>اطلاعات فرد</h3><button class="btn ghost icon-sm" data-close aria-label="بستن">✕</button></div>
      <div class="phero">
        <div class="phero-photo ${p.gender}">${p.photo_url ? `<img src="${esc(p.photo_url)}" alt="">` : `<span class="sil"></span>`}${p.is_deceased ? `<i class="ribbon-c"></i>` : ""}</div>
        <div>
          <h2>${esc(fullName(p))}</h2>
          ${span ? `<div class="phero-span">(${esc(span)})</div>` : ""}
          <div class="muted small">P-${toFa(String(p.id).padStart(4, "0"))}</div>
          <span class="gpill ${p.gender}">${p.gender === "male" ? "مرد" : "زن"}</span>
        </div>
      </div>
      ${
        focus && focus.id !== p.id
          ? `<div class="hint">نسبت با ${esc(fullName(focus))}:</div><div class="rel-pills">${rels.length ? pills(rels) : `<span class="muted">نسبت مشخصی پیدا نشد</span>`}</div>`
          : focus?.id === p.id
            ? `<div class="rel-pills"><span class="pill kind-self">★ مبنای نسبت‌ها («من»)</span></div>`
            : ""
      }
      <div class="actions">
        ${focus?.id === p.id ? `<button class="btn small" data-act="unfocus">برداشتن «من»</button>` : `<button class="btn small" data-act="focus">★ این شخص «من» است</button>`}
      </div>
      <div class="ptabs" role="tablist">
        <button data-tab="info" class="${tab === "info" ? "active" : ""}">مشخصات</button>
        <button data-tab="family" class="${tab === "family" ? "active" : ""}">خانواده</button>
        <button data-tab="notes" class="${tab === "notes" ? "active" : ""}">یادداشت‌ها</button>
      </div>
      <div class="ptab-body">${tab === "info" ? infoTab : tab === "notes" ? notesTab : familyTab}</div>
    </div>

    ${
      others.length
        ? `<div class="pcard">
      <div class="pcard-head"><h3>خویشاوندی با فرد دیگر</h3></div>
      <label class="field"><span>فرد اول</span><input class="input" value="${esc(fullName(p))}" disabled></label>
      <label class="field"><span>فرد دوم</span><select class="input" data-compare>${personOptions((x) => x.id !== p.id, otherId, { none: "— انتخاب فرد دوم —" })}</select></label>
      <button class="btn primary block" data-act="path" ${otherId ? "" : "disabled"}>نمایش مسیر خویشاوندی</button>
      <div class="result-box"><span class="muted">نتیجه:</span> ${
        otherId
          ? (() => {
              const r = S.fam.relations(p.id, otherId);
              return `<b>${esc(fullName(person(otherId)))}</b> برای ${esc(fullName(p))}: <div class="rel-pills">${r.length ? pills(r) : `<span class="muted">نسبتی یافت نشد</span>`}</div>`;
            })()
          : "--"
      }</div>
    </div>`
        : ""
    }`;

  $("[data-close]", panel).addEventListener("click", clearSelection);
  $$("[data-tab]", panel).forEach((b) =>
    b.addEventListener("click", () => {
      S.panelTab = b.dataset.tab;
      renderPanel();
    }),
  );
  $$("[data-goto]", panel).forEach((b) => b.addEventListener("click", () => selectPerson(Number(b.dataset.goto))));
  $$("[data-marriage]", panel).forEach((b) =>
    b.addEventListener("click", () => {
      const m = S.marriages.find((x) => x.id === Number(b.dataset.marriage));
      const u = S.tree.layout.unions.find((x) => x.marriage?.id === m?.id);
      if (u) selectUnion(u);
    }),
  );
  $("[data-act=focus]", panel)?.addEventListener("click", () => {
    setFocus(p.id);
    redraw();
    renderPanel();
    toast(`نسبت همه با ${fullName(p)} نمایش داده می‌شود`);
  });
  $("[data-act=unfocus]", panel)?.addEventListener("click", () => {
    setFocus(null);
    redraw();
    renderPanel();
  });
  $("[data-compare]", panel)?.addEventListener("change", (e) => {
    S.compareId = Number(e.target.value) || null;
    renderPanel();
  });
  $("[data-act=path]", panel)?.addEventListener("click", () => otherId && showPathBetween(p.id, otherId));
  $$("[data-act=edit]", panel).forEach((b) => b.addEventListener("click", () => openPersonForm({ person: p })));
  $("[data-act=delete]", panel)?.addEventListener("click", () => deletePerson(p));
  $$("[data-add]", panel).forEach((b) => b.addEventListener("click", () => addRelative(p, b.dataset.add)));
}

function renderUnionPanel(panel, main) {
  const u = S.selectedUnion;
  const m = S.marriages.find((x) => x.id === u.marriage?.id);
  if (!m) {
    S.selectedUnion = null;
    return renderPanel();
  }
  panel.hidden = false;
  main.classList.remove("no-panel");
  const h = person(m.husband_id);
  const w = person(m.wife_id);
  const cons = S.fam.consanguinity(m);
  const children = S.fam.childrenOf(m.husband_id).filter((c) => person(c).mother_id === m.wife_id);
  panel.innerHTML = `
    <div class="pcard">
      <div class="pcard-head"><h3>⚭ ازدواج</h3><button class="btn ghost icon-sm" data-close aria-label="بستن">✕</button></div>
      <div class="psec">
        ${prow(h.id, "شوهر")}
        ${prow(w.id, "همسر")}
      </div>
      <dl class="facts">
        <dt>وضعیت</dt><dd>${STATUS_FA[m.status]}</dd>
        ${m.marriage_date ? `<dt>تاریخ ازدواج</dt><dd>${esc(toFa(m.marriage_date))}</dd>` : ""}
        ${m.end_date ? `<dt>تاریخ پایان</dt><dd>${esc(toFa(m.end_date))}</dd>` : ""}
      </dl>
      ${
        cons
          ? `<div class="result-box">
          <div>${esc(fullName(w))} <b>${esc(cons.wifeToHusband)}</b>ِ ${esc(fullName(h))} است و ${esc(fullName(h))} <b>${esc(cons.husbandToWife)}</b>ِ ${esc(fullName(w))}.</div>
          <div class="hint" style="margin-top:6px">جدّ مشترک: ${chip(cons.ancestor)} — ${toFa(cons.up)} نسل بالاتر از شوهر و ${toFa(cons.down)} نسل بالاتر از زن. مسیر خونی روی درخت قرمز شده است.</div>
        </div>`
          : ""
      }
      ${children.length ? `<div class="psec"><h4>فرزندان <span class="muted">(${toFa(children.length)} نفر)</span></h4>${children.map((c) => prow(c, person(c).gender === "male" ? "♂ پسر" : "♀ دختر")).join("")}</div>` : ""}
      ${m.notes ? `<div class="psec"><h4>یادداشت</h4><div class="notes">${esc(m.notes)}</div></div>` : ""}
      ${
        canEdit()
          ? `<div class="actions">
          <button class="btn small" data-act="child">＋ فرزند این زوج</button>
          <button class="btn small" data-act="edit">✎ ویرایش</button>
          <button class="btn small danger" data-act="delete">حذف ازدواج</button>
        </div>`
          : ""
      }
    </div>`;
  $("[data-close]", panel).addEventListener("click", clearSelection);
  $$("[data-goto]", panel).forEach((b) => b.addEventListener("click", () => selectPerson(Number(b.dataset.goto))));
  $("[data-act=child]", panel)?.addEventListener("click", () => openPersonForm({ preset: { father_id: m.husband_id, mother_id: m.wife_id, last_name: h.last_name } }));
  $("[data-act=edit]", panel)?.addEventListener("click", () => openMarriageForm(m));
  $("[data-act=delete]", panel)?.addEventListener("click", async () => {
    if (!confirm("این ازدواج حذف شود؟ (اشخاص و فرزندان حذف نمی‌شوند)")) return;
    try {
      await api("DELETE", `/api/marriages/${m.id}`);
      toast("ازدواج حذف شد");
      S.selectedUnion = null;
      await loadTree();
    } catch (e) {
      toast(e.message, true);
    }
  });
}

function showPathBetween(a, b) {
  if (S.mode === "family") {
    // the path may leave the close-family view
    S.mode = "all";
    store.set("ft_mode", "all");
    updateModeLabel();
    redraw(true);
  }
  const link = S.fam.bloodLink(a, b);
  S.highlight.clear();
  S.highlightUnions.clear();
  if (link) highlightLink(link);
  else {
    // in-law: highlight both people and their spouses
    S.highlight.add(a).add(b);
    for (const s of [...S.fam.spousesOf(a), ...S.fam.spousesOf(b)]) S.highlight.add(s.id);
  }
  redraw();
  S.tree.focusOn([...S.highlight], { minK: 0.12 });
  toast(link ? `جدّ مشترک: ${fullName(person(link.ancestor))}` : "نسبت خونی ندارند؛ نسبت سببی (از راه ازدواج) است");
}

function openPeopleList() {
  const { el, close } = modal({
    title: `فهرست افراد <span class="muted">(${toFa(S.people.length)} نفر)</span>`,
    wide: true,
    body: `<input class="input" type="search" placeholder="جست‌وجو در فهرست…" data-q style="margin-bottom:12px">
      <div class="table-wrap"><table class="users people-table">
        <thead><tr><th>نام</th><th>جنسیت</th><th>تولد</th><th>پدر</th><th>مادر</th><th>همسر</th></tr></thead>
        <tbody></tbody>
      </table></div>`,
  });
  const tbody = $("tbody", el);
  const rows = [...S.people].sort((a, b) => fullName(a).localeCompare(fullName(b), "fa"));
  const draw = () => {
    const q = normalize($("[data-q]", el).value.trim());
    tbody.innerHTML = rows
      .filter((p) => !q || normalize(`${fullName(p)} ${p.nickname}`).includes(q))
      .map(
        (p) => `<tr data-id="${p.id}" tabindex="0">
          <td>${avatar(p)} ${esc(fullName(p))}</td>
          <td>${p.gender === "male" ? "مرد" : "زن"}</td>
          <td>${esc(lifeSpan(p))}</td>
          <td>${esc(person(p.father_id) ? fullName(person(p.father_id)) : "")}</td>
          <td>${esc(person(p.mother_id) ? fullName(person(p.mother_id)) : "")}</td>
          <td>${esc(S.fam.spousesOf(p.id).map((s) => fullName(person(s.id))).join("، "))}</td>
        </tr>`,
      )
      .join("");
    $$("tr[data-id]", tbody).forEach((tr) => {
      const go = () => {
        close();
        selectPerson(Number(tr.dataset.id));
      };
      tr.addEventListener("click", go);
      tr.addEventListener("keydown", (e) => e.key === "Enter" && go());
    });
  };
  $("[data-q]", el).addEventListener("input", draw);
  draw();
}

// ---------------------------------------------------------------------------
// modals

function modal({ title, body, wide = false, foot = "" }) {
  const root = $("#modal-root");
  const wrap = document.createElement("div");
  wrap.className = "modal-backdrop";
  wrap.innerHTML = `<div class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true">
      <div class="modal-head"><h3>${title}</h3><button class="btn ghost small" data-x aria-label="بستن">✕</button></div>
      <div class="modal-body">${body}</div>
      ${foot ? `<div class="modal-foot">${foot}</div>` : ""}
    </div>`;
  root.appendChild(wrap);
  const close = () => {
    wrap.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => e.key === "Escape" && close();
  document.addEventListener("keydown", onKey);
  $("[data-x]", wrap).addEventListener("click", close);
  wrap.addEventListener("mousedown", (e) => e.target === wrap && close());
  return { el: wrap, close };
}

function personOptions(filter, selected, { none = "— هیچ —" } = {}) {
  const list = S.people.filter(filter).sort((a, b) => fullName(a).localeCompare(fullName(b), "fa"));
  return (
    (none ? `<option value="">${none}</option>` : "") +
    list
      .map((p) => {
        const span = lifeSpan(p);
        return `<option value="${p.id}" ${p.id === selected ? "selected" : ""}>${esc(fullName(p))}${span ? ` (${esc(span)})` : ""}</option>`;
      })
      .join("")
  );
}

/**
 * Create / edit a person.
 * @param {{person?:any, preset?:any, lockGender?:boolean, title?:string, after?:(p:any)=>Promise<void>}} opts
 */
function openPersonForm({ person: existing, preset = {}, lockGender = false, title, after } = {}) {
  const p = { gender: "male", ...preset, ...(existing || {}) };
  const isEdit = !!existing;
  const excludeSelf = (x) => !existing || x.id !== existing.id;
  const { el, close } = modal({
    title: title || (isEdit ? `ویرایش ${esc(fullName(existing))}` : "افزودن شخص"),
    body: `<form id="pf" novalidate>
      <div class="row">
        <label class="field"><span>نام *</span><input class="input" name="first_name" required value="${esc(p.first_name)}"></label>
        <label class="field"><span>نام خانوادگی</span><input class="input" name="last_name" value="${esc(p.last_name)}"></label>
      </div>
      <div class="row">
        <div class="field"><span>جنسیت</span>
          <div class="seg">
            <label><input type="radio" name="gender" value="male" ${p.gender === "male" ? "checked" : ""} ${lockGender ? "disabled" : ""}>مرد</label>
            <label><input type="radio" name="gender" value="female" ${p.gender === "female" ? "checked" : ""} ${lockGender ? "disabled" : ""}>زن</label>
          </div>
        </div>
        <label class="field"><span>نام مستعار / لقب</span><input class="input" name="nickname" value="${esc(p.nickname)}"></label>
      </div>
      <div class="row">
        <label class="field"><span>تاریخ تولد</span><input class="input" name="birth_date" placeholder="مثلاً ۱۳۴۵ یا 1966-03-21" value="${esc(p.birth_date)}"></label>
        <label class="field"><span>محل تولد</span><input class="input" name="birth_place" value="${esc(p.birth_place)}"></label>
      </div>
      <label class="check"><input type="checkbox" name="is_deceased" ${p.is_deceased ? "checked" : ""}> درگذشته است</label>
      <label class="field death" ${p.is_deceased ? "" : "hidden"}><span>تاریخ وفات</span><input class="input" name="death_date" value="${esc(p.death_date)}"></label>
      <div class="row">
        <label class="field"><span>پدر</span><select class="input" name="father_id">${personOptions((x) => x.gender === "male" && excludeSelf(x), p.father_id)}</select></label>
        <label class="field"><span>مادر</span><select class="input" name="mother_id">${personOptions((x) => x.gender === "female" && excludeSelf(x), p.mother_id)}</select></label>
      </div>
      <label class="field"><span>نشانی عکس (اختیاری)</span><input class="input" name="photo_url" dir="ltr" placeholder="https://…" value="${esc(p.photo_url)}"></label>
      <label class="field"><span>یادداشت</span><textarea class="input" name="notes">${esc(p.notes)}</textarea></label>
      <div class="error"></div>
    </form>`,
    foot: `<button class="btn" data-cancel>انصراف</button><button class="btn primary" data-save>${isEdit ? "ذخیره" : "افزودن"}</button>`,
  });
  const form = $("#pf", el);
  form.first_name.focus();
  form.is_deceased.addEventListener("change", () => ($(".death", form).hidden = !form.is_deceased.checked));
  $("[data-cancel]", el).addEventListener("click", close);
  const save = async () => {
    const fd = new FormData(form);
    const data = {
      first_name: fd.get("first_name"),
      last_name: fd.get("last_name"),
      nickname: fd.get("nickname"),
      gender: lockGender ? p.gender : fd.get("gender"),
      birth_date: fd.get("birth_date"),
      birth_place: fd.get("birth_place"),
      is_deceased: form.is_deceased.checked,
      death_date: form.is_deceased.checked ? fd.get("death_date") : "",
      father_id: fd.get("father_id") || null,
      mother_id: fd.get("mother_id") || null,
      photo_url: fd.get("photo_url"),
      notes: fd.get("notes"),
    };
    if (preset.spouse_of && !isEdit) data.spouse_of = preset.spouse_of;
    const btn = $("[data-save]", el);
    btn.disabled = true;
    try {
      const res = isEdit ? await api("PUT", `/api/people/${existing.id}`, data) : await api("POST", "/api/people", data);
      if (after) await after(res.person);
      close();
      toast(isEdit ? "تغییرات ذخیره شد" : `${fullName(res.person)} افزوده شد`);
      S.selectedId = after ? S.selectedId : res.person.id;
      await loadTree();
      if (!isEdit && S.people.length === 1) {
        setFocus(res.person.id);
        redraw();
        renderPanel();
      }
    } catch (e) {
      $(".error", form).textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  };
  $("[data-save]", el).addEventListener("click", save);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    save();
  });
}

function addRelative(p, kind) {
  const name = fullName(p);
  switch (kind) {
    case "father":
    case "mother": {
      const male = kind === "father";
      return openPersonForm({
        title: `افزودن ${male ? "پدر" : "مادر"} برای ${esc(name)}`,
        preset: { gender: male ? "male" : "female", last_name: male ? p.last_name : "" },
        lockGender: true,
        after: async (np) => {
          await api("PUT", `/api/people/${p.id}`, { [male ? "father_id" : "mother_id"]: np.id });
          // link the two parents as a couple if both are now known
          const other = male ? p.mother_id : p.father_id;
          if (other) {
            const [h, w] = male ? [np.id, other] : [other, np.id];
            await api("POST", "/api/marriages", { husband_id: h, wife_id: w }).catch(() => {});
          }
        },
      });
    }
    case "son":
    case "daughter": {
      const spouses = S.fam.spousesOf(p.id);
      const other = spouses.find((s) => s.marriage.status !== "divorced")?.id ?? spouses[0]?.id ?? null;
      const preset = { gender: kind === "son" ? "male" : "female" };
      if (p.gender === "male") Object.assign(preset, { father_id: p.id, mother_id: other, last_name: p.last_name });
      else Object.assign(preset, { mother_id: p.id, father_id: other, last_name: other ? person(other).last_name : "" });
      return openPersonForm({ title: `افزودن ${kind === "son" ? "پسر" : "دختر"} برای ${esc(name)}`, preset });
    }
    case "brother":
    case "sister":
      return openPersonForm({
        title: `افزودن ${kind === "brother" ? "برادر" : "خواهر"} برای ${esc(name)}`,
        preset: { gender: kind === "brother" ? "male" : "female", father_id: p.father_id, mother_id: p.mother_id, last_name: p.last_name },
      });
    case "spouse":
      return openSpouseForm(p);
  }
}

function openSpouseForm(p) {
  const spouseGender = p.gender === "male" ? "female" : "male";
  const existingIds = new Set(S.fam.spousesOf(p.id).map((s) => s.id));
  const word = p.gender === "male" ? "همسر" : "شوهر";
  const { el, close } = modal({
    title: `افزودن ${word} برای ${esc(fullName(p))}`,
    body: `<div class="tabs"><button class="active" data-tab="existing">از افراد موجود</button><button data-tab="new">شخص تازه</button></div>
      <div data-pane="existing">
        <label class="field"><span>${word}</span><select class="input" name="spouse">${personOptions((x) => x.gender === spouseGender && !existingIds.has(x.id), null, { none: "— انتخاب کنید —" })}</select></label>
        <p class="hint">اگر ${word} از خویشاوندان باشد (مثلاً دخترعمو یا پسرخاله)، ازدواج فامیلی به‌طور خودکار تشخیص داده و روی درخت نشان داده می‌شود.</p>
      </div>
      <div data-pane="new" hidden><p class="hint">پس از زدن «ادامه»، فرم شخص تازه باز می‌شود.</p></div>
      <div class="row">
        <label class="field"><span>وضعیت</span><select class="input" name="status">${Object.entries(STATUS_FA).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label>
        <label class="field"><span>تاریخ ازدواج</span><input class="input" name="marriage_date"></label>
      </div>
      <div class="error"></div>`,
    foot: `<button class="btn" data-cancel>انصراف</button><button class="btn primary" data-save>ادامه</button>`,
  });
  let tab = "existing";
  $$("[data-tab]", el).forEach((b) =>
    b.addEventListener("click", () => {
      tab = b.dataset.tab;
      $$("[data-tab]", el).forEach((x) => x.classList.toggle("active", x === b));
      $$("[data-pane]", el).forEach((x) => (x.hidden = x.dataset.pane !== tab));
    }),
  );
  $("[data-cancel]", el).addEventListener("click", close);
  $("[data-save]", el).addEventListener("click", async () => {
    const status = $("[name=status]", el).value;
    const marriage_date = $("[name=marriage_date]", el).value;
    const link = async (otherId) => {
      const [h, w] = p.gender === "male" ? [p.id, otherId] : [otherId, p.id];
      await api("POST", "/api/marriages", { husband_id: h, wife_id: w, status, marriage_date });
    };
    if (tab === "new") {
      close();
      return openPersonForm({ title: `${word} تازه برای ${esc(fullName(p))}`, preset: { gender: spouseGender }, lockGender: true, after: (np) => link(np.id) });
    }
    const sid = Number($("[name=spouse]", el).value);
    if (!sid) return ($(".error", el).textContent = "یک نفر را انتخاب کنید");
    try {
      await link(sid);
      close();
      await loadTree();
      const m = S.marriages.find((x) => x.husband_id === (p.gender === "male" ? p.id : sid) && x.wife_id === (p.gender === "male" ? sid : p.id));
      const cons = m && S.fam.consanguinity(m);
      toast(cons ? `ازدواج ثبت شد (${cons.husbandToWife} و ${cons.wifeToHusband})` : "ازدواج ثبت شد");
    } catch (e) {
      $(".error", el).textContent = e.message;
    }
  });
}

function openMarriageForm(m) {
  const { el, close } = modal({
    title: "ویرایش ازدواج",
    body: `<form id="mf">
      <div class="row">
        <label class="field"><span>شوهر</span><select class="input" name="husband_id">${personOptions((x) => x.gender === "male", m.husband_id, { none: "" })}</select></label>
        <label class="field"><span>همسر</span><select class="input" name="wife_id">${personOptions((x) => x.gender === "female", m.wife_id, { none: "" })}</select></label>
      </div>
      <div class="row">
        <label class="field"><span>وضعیت</span><select class="input" name="status">${Object.entries(STATUS_FA).map(([k, v]) => `<option value="${k}" ${m.status === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
        <label class="field"><span>تاریخ ازدواج</span><input class="input" name="marriage_date" value="${esc(m.marriage_date)}"></label>
      </div>
      <label class="field"><span>تاریخ پایان (جدایی / فوت)</span><input class="input" name="end_date" value="${esc(m.end_date)}"></label>
      <label class="field"><span>یادداشت</span><textarea class="input" name="notes">${esc(m.notes)}</textarea></label>
      <div class="error"></div>
    </form>`,
    foot: `<button class="btn" data-cancel>انصراف</button><button class="btn primary" data-save>ذخیره</button>`,
  });
  $("[data-cancel]", el).addEventListener("click", close);
  $("[data-save]", el).addEventListener("click", async () => {
    const data = Object.fromEntries(new FormData($("#mf", el)));
    try {
      await api("PUT", `/api/marriages/${m.id}`, data);
      close();
      toast("ذخیره شد");
      await loadTree();
    } catch (e) {
      $(".error", el).textContent = e.message;
    }
  });
}

async function deletePerson(p) {
  if (!confirm(`«${fullName(p)}» از شجره‌نامه حذف شود؟ ارتباط فرزندان و ازدواج‌های او نیز حذف می‌شود.`)) return;
  try {
    await api("DELETE", `/api/people/${p.id}`);
    S.selectedId = null;
    toast("حذف شد");
    await loadTree();
  } catch (e) {
    toast(e.message, true);
  }
}

function openFinder() {
  if (S.people.length < 2) return toast("دست‌کم دو نفر لازم است");
  const a0 = S.focusId ?? S.people[0].id;
  const b0 = S.selectedId && S.selectedId !== a0 ? S.selectedId : S.people.find((x) => x.id !== a0).id;
  const { el, close } = modal({
    title: "یافتن نسبت میان دو نفر",
    body: `<div class="row">
        <label class="field"><span>شخص اول</span><select class="input" name="a">${personOptions(() => true, a0, { none: "" })}</select></label>
        <label class="field"><span>شخص دوم</span><select class="input" name="b">${personOptions(() => true, b0, { none: "" })}</select></label>
      </div>
      <div class="out"></div>`,
    foot: `<button class="btn" data-cancel>بستن</button><button class="btn primary" data-show>نمایش روی درخت</button>`,
  });
  const out = $(".out", el);
  const update = () => {
    const a = Number($("[name=a]", el).value);
    const b = Number($("[name=b]", el).value);
    const A = person(a);
    const B = person(b);
    const ab = S.fam.relations(a, b);
    const ba = S.fam.relations(b, a);
    const link = a !== b ? S.fam.bloodLink(a, b) : null;
    out.innerHTML = `
      <div class="result-box"><b>${esc(fullName(B))}</b> برای ${esc(fullName(A))}:
        <div class="rel-pills">${ab.length ? pills(ab) : `<span class="muted">نسبتی یافت نشد</span>`}</div></div>
      <div class="result-box"><b>${esc(fullName(A))}</b> برای ${esc(fullName(B))}:
        <div class="rel-pills">${ba.length ? pills(ba) : `<span class="muted">نسبتی یافت نشد</span>`}</div></div>
      ${link && link.up && link.down ? `<p class="hint">جدّ مشترک: <b>${esc(fullName(person(link.ancestor)))}</b> — ${link.up} نسل بالاتر از ${esc(fullName(A))} و ${link.down} نسل بالاتر از ${esc(fullName(B))}.</p>` : ""}`;
  };
  $$("select", el).forEach((s) => s.addEventListener("change", update));
  update();
  $("[data-cancel]", el).addEventListener("click", close);
  $("[data-show]", el).addEventListener("click", () => {
    const a = Number($("[name=a]", el).value);
    const b = Number($("[name=b]", el).value);
    close();
    S.selectedId = null;
    S.selectedUnion = null;
    renderPanel();
    showPathBetween(a, b);
  });
}

function openAccount() {
  const { el, close } = modal({
    title: "حساب کاربری",
    body: `<p>${esc(S.user.display_name)} — <span dir="ltr">${esc(S.user.username)}</span> <span class="role">${ROLE_FA[S.user.role]}</span></p>
      <form id="pw">
        <label class="field"><span>رمز عبور فعلی</span><input class="input" type="password" name="current_password" autocomplete="current-password" dir="ltr"></label>
        <label class="field"><span>رمز عبور تازه</span><input class="input" type="password" name="new_password" autocomplete="new-password" dir="ltr"></label>
        <div class="error"></div>
      </form>`,
    foot: `<button class="btn" data-cancel>بستن</button><button class="btn primary" data-save>تغییر رمز</button>`,
  });
  $("[data-cancel]", el).addEventListener("click", close);
  $("[data-save]", el).addEventListener("click", async () => {
    try {
      await api("PUT", "/api/me/password", Object.fromEntries(new FormData($("#pw", el))));
      close();
      toast("رمز عبور تغییر کرد");
    } catch (e) {
      $(".error", el).textContent = e.message;
    }
  });
}

async function openAdmin() {
  let data;
  try {
    data = await api("GET", "/api/users");
  } catch (e) {
    return toast(e.message, true);
  }
  const { el, close } = modal({
    title: "مدیریت",
    wide: true,
    body: `
      <div class="tabs"><button class="active" data-tab="users">کاربران</button><button data-tab="backup">پشتیبان‌گیری</button></div>
      <div data-pane="users">
        <label class="check"><input type="checkbox" name="allow_registration" ${data.allowRegistration ? "checked" : ""}> ثبت‌نام عمومی آزاد باشد (کاربران تازه «بیننده» می‌شوند)</label>
        <table class="users">
          <thead><tr><th>نام</th><th>نام کاربری</th><th>نقش</th><th></th></tr></thead>
          <tbody>${data.users
            .map(
              (u) => `<tr data-uid="${u.id}">
              <td>${esc(u.display_name)}</td><td dir="ltr">${esc(u.username)}</td>
              <td><select class="input" data-role ${u.id === S.user.id ? "disabled" : ""}>${Object.entries(ROLE_FA).map(([k, v]) => `<option value="${k}" ${u.role === k ? "selected" : ""}>${v}</option>`).join("")}</select></td>
              <td><button class="btn small" data-reset>رمز تازه</button> ${u.id !== S.user.id ? `<button class="btn small danger" data-del>حذف</button>` : ""}</td>
            </tr>`,
            )
            .join("")}</tbody>
        </table>
        <div class="section-title">کاربر تازه</div>
        <form id="nu" class="row" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">
          <label class="field"><span>نام نمایشی</span><input class="input" name="display_name"></label>
          <label class="field"><span>نام کاربری</span><input class="input" name="username" dir="ltr"></label>
          <label class="field"><span>رمز عبور</span><input class="input" name="password" type="password" dir="ltr" autocomplete="new-password"></label>
          <label class="field"><span>نقش</span><select class="input" name="role">${Object.entries(ROLE_FA).map(([k, v]) => `<option value="${k}" ${k === "viewer" ? "selected" : ""}>${v}</option>`).join("")}</select></label>
        </form>
        <div class="error"></div>
        <button class="btn primary" data-create>ساخت کاربر</button>
        <p class="hint">مدیر: همه‌چیز · ویرایشگر: افزودن و ویرایش اشخاص · بیننده: فقط دیدن</p>
      </div>
      <div data-pane="backup" hidden>
        <p>از کل شجره‌نامه (اشخاص و ازدواج‌ها) فایل JSON بگیرید یا آن را بازیابی کنید.</p>
        <div class="actions">
          <a class="btn" href="/api/export" download>⬇ دریافت فایل پشتیبان</a>
          <label class="btn">⬆ بازیابی از فایل<input type="file" accept="application/json,.json" hidden data-import></label>
        </div>
        <p class="hint">هشدار: بازیابی، همهٔ داده‌های فعلی شجره‌نامه را جایگزین می‌کند.</p>
      </div>`,
  });
  $$("[data-tab]", el).forEach((b) =>
    b.addEventListener("click", () => {
      $$("[data-tab]", el).forEach((x) => x.classList.toggle("active", x === b));
      $$("[data-pane]", el).forEach((x) => (x.hidden = x.dataset.pane !== b.dataset.tab));
    }),
  );
  const fail = (e) => toast(e.message, true);
  $("[name=allow_registration]", el).addEventListener("change", (e) =>
    api("PUT", "/api/settings", { allow_registration: e.target.checked }).then(() => toast("ذخیره شد"), fail),
  );
  $$("tr[data-uid]", el).forEach((tr) => {
    const id = tr.dataset.uid;
    $("[data-role]", tr).addEventListener("change", (e) => api("PUT", `/api/users/${id}`, { role: e.target.value }).then(() => toast("نقش تغییر کرد"), fail));
    $("[data-reset]", tr).addEventListener("click", () => {
      const pw = prompt("رمز عبور تازه (دست‌کم ۸ نویسه):");
      if (pw) api("PUT", `/api/users/${id}`, { password: pw }).then(() => toast("رمز تغییر کرد"), fail);
    });
    $("[data-del]", tr)?.addEventListener("click", () => {
      if (confirm("این کاربر حذف شود؟")) api("DELETE", `/api/users/${id}`).then(() => (close(), openAdmin()), fail);
    });
  });
  $("[data-create]", el).addEventListener("click", async () => {
    try {
      await api("POST", "/api/users", Object.fromEntries(new FormData($("#nu", el))));
      close();
      toast("کاربر ساخته شد");
      openAdmin();
    } catch (e) {
      $("[data-pane=users] > .error", el).textContent = e.message;
    }
  });
  $("[data-import]", el).addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file || !confirm("همهٔ داده‌های فعلی جایگزین شود؟")) return;
    try {
      const res = await api("POST", "/api/import", JSON.parse(await file.text()));
      close();
      toast(`${res.people} نفر و ${res.marriages} ازدواج بازیابی شد`);
      S.selectedId = null;
      await loadTree({ fit: true });
    } catch (ex) {
      toast(ex.message, true);
    }
  });
}

// ---------------------------------------------------------------------------
// search

function initSearch() {
  const input = $(".search input");
  const box = $(".search-results");
  const show = () => {
    const q = normalize(input.value.trim());
    if (!q) return (box.hidden = true);
    const hits = S.people.filter((p) => normalize(`${fullName(p)} ${p.nickname}`).includes(q)).slice(0, 20);
    box.innerHTML = hits.length
      ? hits.map((p) => `<button data-id="${p.id}">${esc(fullName(p))} <span class="muted">${esc(lifeSpan(p))}</span></button>`).join("")
      : `<div class="muted" style="padding:8px 12px">یافت نشد</div>`;
    box.hidden = false;
    $$("button", box).forEach((b) =>
      b.addEventListener("click", () => {
        box.hidden = true;
        input.value = "";
        selectPerson(Number(b.dataset.id));
      }),
    );
  };
  input.addEventListener("input", show);
  input.addEventListener("focus", show);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("button", box)?.click();
    if (e.key === "Escape") box.hidden = true;
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search")) box.hidden = true;
  });
}

boot();
