import { Family, KIND_LABELS } from "./kinship.js";
import { DEMO } from "./config.js";
import { TreeView, lifeSpan, toFa, sortSiblings } from "./tree.js";
import { prepare, planPages, renderPages, PAPERS } from "./print.js";
import { generations, clanView } from "./generations.js";
import { OfflineError, isTemp, local, applyOps, editType, queueEdit, replay, describeOp, CHANGES_FORMAT } from "./offline.js";

// ---------------------------------------------------------------------------
// utilities

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/**
 * Call the API. Family-tree edits made while offline (or when the network drops mid-call)
 * are queued locally instead — see offline.js.
 */
async function api(method, path, data) {
  const edit = method !== "GET" && editType(method, path);
  // while offline edits wait to be sent, new ones join the queue so they stay in order
  if (edit && (S.offline || local.ops(S.user?.id).length)) return editOffline(method, path, data);
  try {
    return await apiFetch(method, path, data);
  } catch (e) {
    if (edit && e instanceof OfflineError) {
      goOffline();
      return editOffline(method, path, data);
    }
    throw e;
  }
}

async function apiFetch(method, path, data) {
  let res;
  try {
    // every non-GET call is JSON (the server refuses anything else, as a CSRF guard)
    const json = method !== "GET";
    res = await fetch(path, {
      method,
      headers: json ? { "Content-Type": "application/json" } : {},
      body: json ? JSON.stringify(data ?? {}) : undefined,
      credentials: "same-origin",
    });
  } catch {
    throw new OfflineError("اتصال به سرور برقرار نیست");
  }
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
    // status and body travel with the error (conflict details, "gone", …)
    throw Object.assign(new Error(payload?.error || `خطا (${res.status})`), { status: res.status, data: payload });
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
  gens: new Map(),
  audit: new Map(),
  access: null,
  perm: null,
  clans: [],
  clanId: undefined, // chosen once the user and their clans are known
  guests: new Map(),
  viewFam: new Family([], []),
  genRange: (() => {
    try {
      return JSON.parse(localStorage.getItem("ft_genrange") || "null");
    } catch {
      return null;
    }
  })(),
  compareId: null,
};

/** May this user add or edit anything at all? */
const canEdit = () => !!S.user && (permAll() || !!S.perm?.editable?.size || !!S.perm?.addClans?.size);
const isAdmin = () => S.user?.role === "admin";
// What this user may do, as computed by the server (generations.js → permissions). People
// created offline (temporary ids) count as editable until the server decides on replay.
const permAll = () => isAdmin() || !!S.perm?.all;
const canEditPerson = (id) => permAll() || !!S.perm?.editable?.has(id) || isTemp(id);
const canDeletePerson = (id) => permAll() || !!S.perm?.deletable?.has(id) || isTemp(id);
const canAddInClan = (clanId) => permAll() || !!S.perm?.addClans?.has(null) || !!S.perm?.addClans?.has(clanId);
const ROLE_FA = { admin: "مدیر", editor: "ویرایشگر", viewer: "بیننده" };
const STATUS_FA = { married: "متأهل", divorced: "جداشده", widowed: "فوت همسر" };

function person(id) {
  return S.fam.get(id);
}
function fullName(p) {
  if (!p) return "؟";
  return `${p.first_name} ${p.last_name || ""}`.trim();
}
const DEFAULT_PREFS = { nameGens: 2, orientation: "vertical", hoverTip: true, notesOnTree: false, siblingOrder: "auto" };

const ORDINAL_FA = ["", "اول", "دوم", "سوم", "چهارم", "پنجم", "ششم", "هفتم", "هشتم", "نهم", "دهم"];

/** Children of a parent, in birth order. */
function childRows(children) {
  return children.map((c) => prow(c, person(c).gender === "male" ? "♂ پسر" : "♀ دختر")).join("");
}

/** «فرزند چندم» for a parent's next child: after the ones already there. */
function nextChildOrder(parentId) {
  const kids = S.fam.childrenOf(parentId).map(person);
  return Math.max(kids.length, ...kids.map((c) => c.birth_order || 0)) + 1;
}

/** "فرزند دوم از ۴ فرزند" among the children of the same parents. */
function childRank(p) {
  const parent = p.father_id ?? p.mother_id;
  if (!person(parent)) return "";
  const sibs = S.fam.childrenOf(parent).filter((c) => {
    const x = person(c);
    return (!p.father_id || x.father_id === p.father_id) && (!p.mother_id || x.mother_id === p.mother_id);
  });
  if (sibs.length < 2) return "";
  const n = sortSiblings(S.fam, sibs).indexOf(p.id) + 1;
  return `<dt>فرزند</dt><dd>${ORDINAL_FA[n] || `${toFa(n)}م`} از ${toFa(sibs.length)} فرزند</dd>`;
}

function prefs() {
  let saved = {};
  try {
    saved = JSON.parse(S.user?.prefs || "{}");
  } catch {
    // ignore malformed prefs
  }
  return { ...DEFAULT_PREFS, ...saved };
}

async function savePrefs(next) {
  const merged = { ...prefs(), ...next };
  S.user.prefs = JSON.stringify(merged);
  local.setLastUser(S.user);
  try {
    await api("PUT", "/api/me/prefs", { prefs: merged });
  } catch (e) {
    if (!(e instanceof OfflineError)) throw e;
  }
}

/** "علی رحیمی فرزند حسن فرزند محمد" — names repeat a lot in a family, so pickers show lineage. */
function lineageName(p, gens = prefs().nameGens) {
  if (!p) return "؟";
  const parts = [fullName(p)];
  let cur = p;
  for (let i = 0; i < gens; i++) {
    const par = person(cur.father_id) || person(cur.mother_id);
    if (!par) break;
    parts.push(par.first_name);
    cur = par;
  }
  return parts.join(" فرزند ");
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
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  try {
    S.status = await api("GET", "/api/status");
    S.offline = false;
  } catch (e) {
    const last = e instanceof OfflineError && local.lastUser();
    if (last && local.snapshot(last.id)) {
      // no connection: open the last copy of the tree saved on this device
      S.user = last;
      S.offline = true;
      renderMain();
      return;
    }
    $("#app").innerHTML = `<div class="boot"><div style="text-align:center">${esc(e.message)}${e instanceof OfflineError ? "<br><span class='muted'>برای استفادهٔ آفلاین، یک بار آنلاین وارد شوید.</span>" : ""}</div></div>`;
    return;
  }
  S.user = S.status.user;
  if (S.user) local.setLastUser(S.user);
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
      ${
        DEMO
          ? `<div class="demo-banner">نسخهٔ نمایشی: داده‌ها ساختگی‌اند و تغییرات فقط در همین مرورگر می‌ماند.
              <button class="btn small" data-act="demo-reset">شروع دوباره</button>
              <a href="https://github.com/Aryalleh/Familytree" target="_blank" rel="noopener">کد در گیت‌هاب</a></div>`
          : "<div></div>"
      }
      <header class="topbar">
        <div class="brand"><span class="brand-logo">🌳</span><span class="brand-name">شجره‌نامه خاندان</span></div>
        <select class="input clan-select" aria-label="طایفه" title="طایفه" hidden></select>
        <nav class="nav">
          <button class="nav-btn active" data-act="map" title="نقشه"><span class="ico">🗺️</span><span class="lbl">نقشه</span></button>
          <button class="nav-btn" data-act="list" title="فهرست افراد"><span class="ico">👥</span><span class="lbl">فهرست افراد</span></button>
          <button class="nav-btn" data-act="finder" title="خویشاوندی"><span class="ico">🔗</span><span class="lbl">خویشاوندی</span></button>
          <button class="nav-btn" data-act="add" title="افزودن شخص" hidden><span class="ico">＋</span><span class="lbl">افزودن شخص</span></button>
          <button class="nav-btn" data-act="changes" title="آخرین تغییرات" ${isAdmin() ? "" : "hidden"}><span class="ico">🕘</span><span class="lbl">تغییرات</span></button>
          <button class="nav-btn" data-act="sync" title="آفلاین و همگام‌سازی"><span class="ico">☁️</span><span class="lbl">آفلاین</span><span class="net-chip" hidden></span></button>
          <button class="nav-btn" data-act="settings" title="تنظیمات"><span class="ico">🛠️</span><span class="lbl">تنظیمات</span></button>
          ${isAdmin() ? `<button class="nav-btn" data-act="users" title="مدیریت"><span class="ico">⚙️</span><span class="lbl">مدیریت</span></button>` : ""}
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
          <button class="btn ghost small" data-act="logout" title="خروج" ${DEMO ? "hidden" : ""}>⎋<span class="lbl"> خروج</span></button>
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
            <button data-zoom="gens" title="نمایش نسل‌ها"><span class="ico">☰</span><span class="lbl gens-lbl"></span></button>
            <button data-zoom="orient" title="چیدمان"><span class="ico">⇅</span><span class="lbl orient-lbl"></span></button>
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
    onHover: (p, e, rels) => (p ? showTip(p, e, rels) : ($("#tip").hidden = true)),
    minimap: $("svg.minimap"),
    insets: viewInsets,
  });

  $("[data-act=map]").addEventListener("click", () => S.tree.fit());
  $("[data-act=add]")?.addEventListener("click", () => openPersonForm({}));
  $("[data-act=list]").addEventListener("click", () => openPeopleList());
  $("[data-act=finder]").addEventListener("click", () => openFinder());
  $("[data-act=users]")?.addEventListener("click", () => openAdmin());
  $("[data-act=account]").addEventListener("click", () => openAccount());
  $("[data-act=settings]").addEventListener("click", () => openSettings());
  $(".clan-select").addEventListener("change", (e) => setClan(e.target.value === "all" ? null : Number(e.target.value)));
  $("[data-act=print]").addEventListener("click", () => openPrintDialog());
  window.addEventListener("beforeprint", () => {
    // Ctrl+P without the print dialog: print the whole tree on one page
    if (!$("#print-root").children.length) buildPrint({ from: 1, to: 999, paper: "a4l", mode: "one", notes: "list" });
  });
  window.addEventListener("afterprint", () => $("#print-root").replaceChildren());
  $("[data-act=logout]").addEventListener("click", async () => {
    const pending = local.ops(S.user.id).length;
    if (pending && !confirm(`${toFa(pending)} تغییرِ ارسال‌نشده دارید که با خروج از این دستگاه پاک می‌شود. ادامه می‌دهید؟`)) return;
    await api("POST", "/api/logout", {}).catch(() => {});
    local.clear(S.user.id);
    S.user = null;
    boot();
  });
  $("[data-act=sync]").addEventListener("click", () => openSync());
  $("[data-act=demo-reset]")?.addEventListener("click", async () => {
    if (!confirm("همهٔ تغییرات شما در نسخهٔ نمایشی پاک شود و داده‌های نمونه برگردد؟")) return;
    await S.demo.reset();
    location.reload();
  });
  $("[data-act=changes]").addEventListener("click", () => openRecentChanges());
  window.addEventListener("online", () => checkOnline());
  window.addEventListener("offline", () => goOffline());
  updateNetChip();
  $$("[data-zoom]").forEach((b) => b.addEventListener("click", () => toolbarAction(b.dataset.zoom)));
  updateModeLabel();
  initSearch();
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#modal-root").children.length) clearSelection();
  });
  // offline edits still waiting from an earlier session go out as soon as the tree is loaded
  loadTree({ fit: true }).then(() => autoSync());
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
  } else if (z === "gens") {
    openGenRange();
  } else if (z === "orient") {
    const orientation = prefs().orientation === "horizontal" ? "vertical" : "horizontal";
    savePrefs({ orientation }).catch((e) => toast(e.message, true));
    S.user.prefs = JSON.stringify({ ...prefs(), orientation });
    updateModeLabel();
    redraw(true);
    if (S.selectedId != null) focusFamily(S.selectedId);
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
  const gl = $(".gens-lbl");
  if (gl) gl.textContent = S.genRange ? `نسل ${toFa(S.genRange.from)}–${toFa(S.genRange.to)}` : "همهٔ نسل‌ها";
  $("[data-zoom=gens]")?.classList.toggle("on", !!S.genRange);
  const o = $(".orient-lbl");
  if (o) o.textContent = prefs().orientation === "horizontal" ? "افقی" : "عمودی";
}

async function loadTree({ fit = false } = {}) {
  try {
    let data;
    if (!S.offline) {
      try {
        [data] = await Promise.all([apiFetch("GET", "/api/tree"), document.fonts?.ready]);
        local.setSnapshot(S.user.id, { ...data, saved_at: new Date().toISOString() });
      } catch (e) {
        if (!(e instanceof OfflineError)) throw e;
        goOffline();
      }
    }
    if (!data) {
      data = local.snapshot(S.user.id);
      if (!data) throw new Error("نسخهٔ آفلاینی از شجره‌نامه روی این دستگاه نیست");
    }
    // edits not yet sent to the server are shown on top of the last known data
    const merged = applyOps(data.people, data.marriages, local.ops(S.user.id));
    S.people = merged.people;
    S.marriages = merged.marriages;
    S.access = data.access || null;
    S.audit = new Map((data.audit || []).map((a) => [a.id, a]));
    const a = data.access || { all: isAdmin() };
    S.perm = a.all
      ? { all: true }
      : { all: false, editable: new Set(a.editable || []), deletable: new Set(a.deletable || []), addClans: new Set(a.addClans || []) };
    S.clans = data.clans || S.clans || [];
    if (S.clanId === undefined) {
      const saved = store.get(`ft_clan_${S.user.id}`);
      S.clanId = saved === "all" ? null : saved ? Number(saved) : defaultClan();
    }
    if (S.clanId != null && !S.clans.some((c) => c.id === S.clanId)) S.clanId = defaultClan();


    S.fam = new Family(S.people, S.marriages);
    S.relCache.clear();
    computeView();
    updateClanSelect();
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
  const f = S.viewFam;
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

/**
 * The selected clan's tree — its members plus guests (spouses and children from other clans) —
 * or everyone when "همهٔ طایفه‌ها" is selected. Generations are counted inside that tree.
 */
function computeView() {
  let fam = S.fam;
  S.guests = new Map();
  if (S.clanId != null && S.clans.length) {
    const v = clanView(S.clanId, S.people, S.marriages);
    const ids = new Set([...v.members, ...v.guests]);
    for (const id of v.guests) S.guests.set(id, clanName(person(id).clan_id));
    fam = new Family(
      S.people.filter((p) => ids.has(p.id)),
      S.marriages.filter((m) => ids.has(m.husband_id) && ids.has(m.wife_id)),
    );
  }
  S.viewFam = fam;
  S.gens = generations([...fam.people.values()], fam.marriages);
}

/** First clan the user may add to, else the one with the most people they can see. */
function defaultClan() {
  if (S.clans.length < 2) return null;
  const addable = S.clans.find((c) => !permAll() && canAddInClan(c.id));
  if (addable) return addable.id;
  const counts = new Map();
  for (const p of S.people) counts.set(p.clan_id, (counts.get(p.clan_id) || 0) + 1);
  return [...S.clans].sort((a, b) => (counts.get(b.id) || 0) - (counts.get(a.id) || 0))[0].id;
}

function setClan(id) {
  S.clanId = id;
  store.set(`ft_clan_${S.user.id}`, id == null ? "all" : String(id));
  computeView();
  if (S.selectedId != null && !S.viewFam.people.has(S.selectedId)) S.selectedId = null;
  if (S.genRange && S.genRange.from > maxGen()) S.genRange = null;
  updateClanSelect();
  updateModeLabel();
  redraw(true);
  renderPanel();
  if (S.selectedId != null) focusFamily(S.selectedId);
  else S.tree.fit();
}

function updateClanSelect() {
  const sel = $(".clan-select");
  if (sel) {
    sel.hidden = S.clans.length < 2;
    sel.innerHTML = `<option value="all">همهٔ طایفه‌ها</option>${S.clans.map((c) => `<option value="${c.id}" ${c.id === S.clanId ? "selected" : ""}>طایفهٔ ${esc(c.name)}</option>`).join("")}`;
    if (S.clanId == null) sel.value = "all";
  }
  const add = $("[data-act=add]");
  if (add) add.hidden = !(permAll() || S.perm?.addClans?.size);
}

function shownFamily() {
  const root = S.mode === "family" ? familyRoot() : null;
  const fam = root != null ? closeFamily(root) : S.viewFam;
  const r = S.genRange;
  if (!r) return fam;
  const inRange = (id) => {
    const g = S.gens.get(id) ?? 1;
    return g >= r.from && g <= r.to;
  };
  const people = [...fam.people.values()].filter((p) => inRange(p.id));
  const ids = new Set(people.map((p) => p.id));
  return new Family(people, fam.marriages.filter((m) => ids.has(m.husband_id) && ids.has(m.wife_id)));
}

const maxGen = () => Math.max(1, ...S.gens.values());

function openGenRange() {
  const n = maxGen();
  const r = S.genRange || { from: 1, to: n };
  const opts = (sel) => Array.from({ length: n }, (_, i) => `<option value="${i + 1}" ${i + 1 === sel ? "selected" : ""}>نسل ${toFa(i + 1)}</option>`).join("");
  const { el, close } = modal({
    title: "نمایش نسل‌ها",
    body: `<div class="row">
        <label class="field"><span>از نسل</span><select class="input" name="from">${opts(r.from)}</select></label>
        <label class="field"><span>تا نسل</span><select class="input" name="to">${opts(Math.min(r.to, n))}</select></label>
      </div>
      <p class="hint">نسل ۱ قدیمی‌ترین نسل است. همسرانی که از بیرون به خانواده آمده‌اند هم‌نسلِ همسرشان حساب می‌شوند.</p>`,
    foot: `<button class="btn" data-all>همهٔ نسل‌ها</button><button class="btn primary" data-ok>نمایش</button>`,
  });
  const apply = (range) => {
    S.genRange = range;
    store.set("ft_genrange", range ? JSON.stringify(range) : null);
    close();
    updateModeLabel();
    redraw(true);
    S.tree.fit();
  };
  $("[data-all]", el).addEventListener("click", () => apply(null));
  $("[data-ok]", el).addEventListener("click", () => {
    const a = Number($("[name=from]", el).value);
    const b = Number($("[name=to]", el).value);
    const range = { from: Math.min(a, b), to: Math.max(a, b) };
    apply(range.from === 1 && range.to >= n ? null : range);
  });
}

function redraw(relayout = false) {
  const empty = $(".empty");
  const restricted = S.access && !S.access.all && !canEdit();
  if (!S.people.length && restricted) {
    empty.hidden = false;
    empty.innerHTML = `<div class="box"><div class="big">🔒</div><h2>هنوز دسترسی ندارید</h2>
      <p class="muted">مدیر شجره‌نامه هنوز مشخص نکرده که کدام بخش از شجره‌نامه را ببینید. از او بخواهید دسترسی شما را تعیین کند.</p></div>`;
  } else if (!S.people.length) {
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
  const pr = prefs();
  const state = { focusId: S.focusId, selectedId: S.selectedId, kin, highlight: S.highlight, highlightUnions: S.highlightUnions, relationsTo, noteLines: pr.notesOnTree ? 1 : 0, guests: S.guests };
  S.tree.render(shownFamily(), S.fam, state, { relayout, orientation: pr.orientation, gens: S.gens, siblingOrder: pr.siblingOrder });
  renderLegend();
}

// ---------------------------------------------------------------------------
// hover card

function showTip(p, e, rels) {
  const tip = $("#tip");
  if (!p || !prefs().hoverTip) {
    tip.hidden = true;
    return;
  }
  if (tip.dataset.id !== String(p.id)) {
    tip.dataset.id = p.id;
    const span = lifeSpan(p);
    tip.innerHTML = `<b>${esc(lineageName(p, Math.max(1, prefs().nameGens)))}</b>
      ${span ? `<div class="muted">${esc(span)}${p.birth_place ? ` · ${esc(p.birth_place)}` : ""}</div>` : ""}
      ${rels?.length ? `<div class="rel-pills">${pills(rels)}</div>` : ""}
      ${p.notes ? `<div class="tip-notes">${esc(p.notes)}</div>` : ""}`;
  }
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let x = e.clientX + 16;
  let y = e.clientY + 16;
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 16;
  if (y + r.height > innerHeight - 8) y = e.clientY - r.height - 16;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}

function renderLegend() {
  const lg = $(".legend");
  const collapsed = store.get("ft_legend") === "0";
  const focus = person(S.focusId);
  const kinds = ["self", "spouse", "parent", "child", "sibling", "blood", "inlaw", "step"];
  lg.hidden = collapsed;
  lg.innerHTML = `
    <div class="legend-row">
      <b>راهنمای نمادها:</b>
      <span><i class="sw male"></i>مرد</span>
      <span><i class="sw female"></i>زن</span>
      <span><i class="sw rings-sw">⚭</i>ازدواج</span>
      <span><i class="sw line"></i>فرزند</span>
      <span><i class="sw selected"></i>فرد منتخب</span>
      <span><i class="sw long"></i>شاخه‌های دیگر</span>
      <span><i class="sw ribbon"></i>درگذشته</span>
    </div>
    ${
      focus
        ? `<div class="legend-row kinds"><b>نسبت با ${esc(fullName(focus))}:</b>${kinds.map((k) => `<span><i class="sw dot" style="background:var(--k-${k})"></i>${KIND_LABELS[k]}</span>`).join("")}</div>`
        : `<div class="legend-row muted">برای دیدن نسبت هر نفر روی کارتش، یک نفر را «★ من» قرار دهید.</div>`
    }`;
}

function selectPerson(id, { focus = true } = {}) {
  // someone from another clan (a guest, a search hit): open their own clan's tree
  if (S.clanId != null && !S.viewFam.people.has(id) && person(id)) {
    S.selectedId = id;
    return setClan(person(id).clan_id);
  }
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
  const children = sortSiblings(S.fam, S.fam.childrenOf(p.id));
  const editor = canEditPerson(p.id);
  // parents are added as new people of this clan (or chosen from existing ones)
  const upward = editor;
  const tab = S.panelTab;
  const span = lifeSpan(p);

  const familyTab = `
    <div class="psec"><h4>والدین</h4>
      ${p.father_id && person(p.father_id) ? prow(p.father_id, "پدر") : upward ? `<button class="add-row" data-add="father">＋ افزودن پدر</button>` : `<div class="muted">پدر ثبت نشده</div>`}
      ${p.mother_id && person(p.mother_id) ? prow(p.mother_id, "مادر") : upward ? `<button class="add-row" data-add="mother">＋ افزودن مادر</button>` : `<div class="muted">مادر ثبت نشده</div>`}
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
      ${childRows(children)}
      ${editor ? `<div class="add-pair"><button class="add-row" data-add="son">＋ پسر</button><button class="add-row" data-add="daughter">＋ دختر</button></div>` : !children.length ? `<div class="muted">ثبت نشده</div>` : ""}
    </div>
    ${upward && (p.father_id || p.mother_id) ? `<div class="add-pair"><button class="add-row" data-add="brother">＋ برادر</button><button class="add-row" data-add="sister">＋ خواهر</button></div>` : ""}
    ${groups.map((g) => `<div class="psec"><h4>${g.title}</h4><div class="chips">${g.ids.map(chip).join("")}</div></div>`).join("")}`;

  const infoTab = `
    <dl class="facts">
      <dt>نام</dt><dd>${esc(p.first_name)}</dd>
      ${p.last_name ? `<dt>نام خانوادگی</dt><dd>${esc(p.last_name)}</dd>` : ""}
      ${p.nickname ? `<dt>لقب</dt><dd>${esc(p.nickname)}</dd>` : ""}
      <dt>جنسیت</dt><dd>${p.gender === "male" ? "مرد" : "زن"}</dd>
      ${childRank(p)}
      ${p.birth_date ? `<dt>تولد</dt><dd>${esc(toFa(p.birth_date))}</dd>` : ""}
      ${p.birth_place ? `<dt>محل تولد</dt><dd>${esc(p.birth_place)}</dd>` : ""}
      ${p.phone ? `<dt>شمارهٔ تماس</dt><dd><a href="tel:${esc(p.phone.replace(/[^\d+]/g, ""))}" dir="ltr">${esc(p.phone)}</a></dd>` : ""}
      ${p.is_deceased ? `<dt>وفات</dt><dd>${esc(toFa(p.death_date) || "درگذشته")}</dd>` : ""}
      <dt>شناسه</dt><dd>P-${toFa(String(p.id).padStart(4, "0"))}</dd>
      ${auditLines(p.id)}
    </dl>
    ${
      editor
        ? `<div class="actions"><button class="btn small" data-act="edit">✎ ویرایش</button>
          ${S.clans.length > 1 ? `<button class="btn small" data-act="move">انتقال به طایفهٔ دیگر</button>` : ""}
          ${canDeletePerson(p.id) ? `<button class="btn small danger" data-act="delete">حذف</button>` : ""}</div>`
        : ""
    }`;

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
          ${S.clans.length > 1 ? `<span class="gpill clan">طایفهٔ ${esc(clanName(p.clan_id))}</span>` : ""}
          ${S.clanId != null && p.clan_id !== S.clanId ? `<div><button class="btn small" data-act="open-clan">↗ نمایش شجره‌نامهٔ طایفهٔ ${esc(clanName(p.clan_id))}</button></div>` : ""}
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
        ${isTemp(p.id) || !isAdmin() ? "" : `<button data-tab="history" class="${tab === "history" ? "active" : ""}">تاریخچه</button>`}
      </div>
      <div class="ptab-body">${tab === "info" ? infoTab : tab === "notes" ? notesTab : tab === "history" && !isTemp(p.id) && isAdmin() ? `<div data-history class="muted">در حال بارگذاری…</div>` : familyTab}</div>
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
  const hist = $("[data-history]", panel);
  if (hist) loadPersonHistory(p, hist);
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
  $("[data-act=open-clan]", panel)?.addEventListener("click", () => setClan(p.clan_id));
  $("[data-act=move]", panel)?.addEventListener("click", () => openMoveClan(p));
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
  const children = sortSiblings(S.fam, S.fam.childrenOf(m.husband_id).filter((c) => person(c).mother_id === m.wife_id));
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
      ${children.length ? `<div class="psec"><h4>فرزندان <span class="muted">(${toFa(children.length)} نفر)</span></h4>${childRows(children)}</div>` : ""}
      ${m.notes ? `<div class="psec"><h4>یادداشت</h4><div class="notes">${esc(m.notes)}</div></div>` : ""}
      ${
        canEditPerson(m.husband_id) || canEditPerson(m.wife_id)
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
  $("[data-act=child]", panel)?.addEventListener("click", () =>
    openPersonForm({ preset: { father_id: m.husband_id, mother_id: m.wife_id, last_name: h.last_name, clan_id: h.clan_id, birth_order: nextChildOrder(m.husband_id) } }),
  );
  $("[data-act=edit]", panel)?.addEventListener("click", () => openMarriageForm(m));
  $("[data-act=delete]", panel)?.addEventListener("click", async () => {
    if (!confirm("این ازدواج حذف شود؟ (اشخاص و فرزندان حذف نمی‌شوند)")) return;
    try {
      if (!(await saveWithConflicts("DELETE", `/api/marriages/${m.id}?base_version=${m.version ?? ""}`))) return;
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
        <thead><tr><th>نام</th><th>جنسیت</th><th>تولد</th><th>پدر</th><th>مادر</th><th>همسر</th><th>تماس</th></tr></thead>
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
          <td>${avatar(p)} ${esc(lineageName(p))}</td>
          <td>${p.gender === "male" ? "مرد" : "زن"}</td>
          <td>${esc(lifeSpan(p))}</td>
          <td>${esc(person(p.father_id) ? fullName(person(p.father_id)) : "")}</td>
          <td>${esc(person(p.mother_id) ? fullName(person(p.mother_id)) : "")}</td>
          <td>${esc(S.fam.spousesOf(p.id).map((s) => fullName(person(s.id))).join("، "))}</td>
          <td dir="ltr">${esc(p.phone || "")}</td>
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

function modal({ title, body, wide = false, foot = "", onClose = null }) {
  const root = $("#modal-root");
  const wrap = document.createElement("div");
  wrap.className = "modal-backdrop";
  wrap.innerHTML = `<div class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true">
      <div class="modal-head"><h3>${title}</h3><button class="btn ghost small" data-x aria-label="بستن">✕</button></div>
      <div class="modal-body">${body}</div>
      ${foot ? `<div class="modal-foot">${foot}</div>` : ""}
    </div>`;
  root.appendChild(wrap);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    wrap.remove();
    document.removeEventListener("keydown", onKey);
    onClose?.();
  };
  const onKey = (e) => e.key === "Escape" && close();
  document.addEventListener("keydown", onKey);
  $("[data-x]", wrap).addEventListener("click", close);
  wrap.addEventListener("mousedown", (e) => e.target === wrap && close());
  return { el: wrap, close };
}

function personOptions(filter, selected, { none = "— هیچ —" } = {}) {
  const list = S.people.filter(filter).sort((a, b) => lineageName(a).localeCompare(lineageName(b), "fa"));
  return (
    (none ? `<option value="">${none}</option>` : "") +
    list
      .map((p) => {
        const span = lifeSpan(p);
        return `<option value="${p.id}" ${p.id === selected ? "selected" : ""}>${esc(lineageName(p))}${span ? ` (${esc(span)})` : ""}</option>`;
      })
      .join("")
  );
}

/** Clan picker for the person form: clans the user may add to, plus the current one. */
function clanField(p, existing) {
  if (S.clans.length < 2) return "";
  const current = existing?.clan_id ?? p.clan_id ?? S.clanId ?? S.clans.find((c) => canAddInClan(c.id))?.id ?? S.clans[0].id;
  const allowed = S.clans.filter((c) => c.id === current || canAddInClan(c.id));
  return `<label class="field"><span>طایفه</span><select class="input" name="clan_id">${allowed.map((c) => `<option value="${c.id}" ${c.id === current ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
    <span class="hint">عروس یا دامادی که از خانوادهٔ دیگری آمده می‌تواند عضو طایفهٔ خودش باشد؛ در این طایفه «مهمان» دیده می‌شود.</span></label>`;
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
      <label class="field"><span>شمارهٔ تماس</span><input class="input" type="tel" name="phone" dir="ltr" placeholder="0912…" value="${esc(p.phone)}"></label>
      <label class="field"><span>فرزند چندم (ترتیب خواهر و برادرها: اول سال تولد مقایسه می‌شود؛ اگر سال تولد نباشد یا یکی باشد، این عدد ملاک است)</span>
        <input class="input" type="number" min="1" max="99" name="birth_order" style="max-width:120px" value="${esc(p.birth_order ?? "")}"></label>
      <label class="check"><input type="checkbox" name="is_deceased" ${p.is_deceased ? "checked" : ""}> درگذشته است</label>
      <label class="field death" ${p.is_deceased ? "" : "hidden"}><span>تاریخ وفات</span><input class="input" name="death_date" value="${esc(p.death_date)}"></label>
      <div class="row">
        <label class="field"><span>پدر</span><select class="input" name="father_id">${personOptions((x) => x.gender === "male" && excludeSelf(x), p.father_id)}</select></label>
        <label class="field"><span>مادر</span><select class="input" name="mother_id">${personOptions((x) => x.gender === "female" && excludeSelf(x), p.mother_id)}</select></label>
      </div>
      ${clanField(p, existing)}
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
      birth_order: fd.get("birth_order") || null,
      phone: fd.get("phone"),
      birth_place: fd.get("birth_place"),
      is_deceased: form.is_deceased.checked,
      death_date: form.is_deceased.checked ? fd.get("death_date") : "",
      father_id: fd.get("father_id") || null,
      mother_id: fd.get("mother_id") || null,
      photo_url: fd.get("photo_url"),
      ...(fd.get("clan_id") ? { clan_id: Number(fd.get("clan_id")) } : {}),
      notes: fd.get("notes"),
    };
    if (preset.spouse_of && !isEdit) data.spouse_of = preset.spouse_of;
    let send = data;
    if (isEdit) {
      // send only what changed, plus the version it was based on, so the server can merge
      send = Object.fromEntries(Object.entries(data).filter(([k, v]) => !sameValue(v, existing[k])));
      if (!Object.keys(send).length) return close();
      send.base_version = existing.version;
    }
    const btn = $("[data-save]", el);
    btn.disabled = true;
    try {
      const res = isEdit ? await saveWithConflicts("PUT", `/api/people/${existing.id}`, send) : await api("POST", "/api/people", send);
      if (!res) return;
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
    case "mother":
      return openParentForm(p, kind === "father");
    case "son":
    case "daughter": {
      const spouses = S.fam.spousesOf(p.id);
      const other = spouses.find((s) => s.marriage.status !== "divorced")?.id ?? spouses[0]?.id ?? null;
      // a new child goes to the end of the list of this parent's children
      const preset = { gender: kind === "son" ? "male" : "female", birth_order: nextChildOrder(p.id) };
      // children take the father's clan
      if (p.gender === "male") Object.assign(preset, { father_id: p.id, mother_id: other, last_name: p.last_name, clan_id: p.clan_id });
      else Object.assign(preset, { mother_id: p.id, father_id: other, last_name: other ? person(other).last_name : "", clan_id: other ? person(other).clan_id : p.clan_id });
      return openPersonForm({ title: `افزودن ${kind === "son" ? "پسر" : "دختر"} برای ${esc(name)}`, preset });
    }
    case "brother":
    case "sister":
      return openPersonForm({
        title: `افزودن ${kind === "brother" ? "برادر" : "خواهر"} برای ${esc(name)}`,
        preset: { gender: kind === "brother" ? "male" : "female", father_id: p.father_id, mother_id: p.mother_id, last_name: p.last_name, clan_id: p.clan_id },
      });
    case "spouse":
      return openSpouseForm(p);
  }
}

/** Add a father or mother: pick someone already in the tree, or create a new person. */
function openParentForm(p, male) {
  const word = male ? "پدر" : "مادر";
  const key = male ? "father_id" : "mother_id";
  const otherParent = male ? p.mother_id : p.father_id;
  // a parent can't be the person themself or one of their descendants
  const allowed = (x) => x.gender === (male ? "male" : "female") && x.id !== p.id && !S.fam.ancestors(x.id).has(p.id);
  // suggest the known parent's spouse (e.g. the father's wife when adding a mother)
  const suggested = otherParent ? S.fam.spousesOf(otherParent).map((s) => s.id).find((id) => allowed(person(id))) ?? null : null;
  const link = async (parentId) => {
    await saveWithConflicts("PUT", `/api/people/${p.id}`, { [key]: parentId, base_version: p.version });
    // link the two parents as a couple if both are now known
    if (otherParent) {
      const [h, w] = male ? [parentId, otherParent] : [otherParent, parentId];
      await api("POST", "/api/marriages", { husband_id: h, wife_id: w }).catch(() => {});
    }
  };
  const candidates = S.people.filter(allowed);
  // a brand-new parent needs the right to add people to this clan
  const canCreate = canAddInClan(p.clan_id);
  if (!candidates.length) return canCreate ? openNewParent() : toast("اجازهٔ افزودن شخص تازه به این طایفه را ندارید", true);

  const { el, close } = modal({
    title: `افزودن ${word} برای ${esc(fullName(p))}`,
    body: `<div class="tabs"><button class="active" data-tab="existing">از افراد موجود</button>${canCreate ? `<button data-tab="new">شخص تازه</button>` : ""}</div>
      <div data-pane="existing">
        <label class="field"><span>${word}</span><select class="input" name="parent">${personOptions(allowed, suggested, { none: "— انتخاب کنید —" })}</select></label>
        ${suggested ? `<p class="hint">پیشنهاد: همسرِ ${esc(fullName(person(otherParent)))}</p>` : ""}
      </div>
      <div data-pane="new" hidden><p class="hint">پس از زدن «ادامه»، فرم شخص تازه باز می‌شود.</p></div>
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
    if (tab === "new") {
      close();
      return openNewParent();
    }
    const id = Number($("[name=parent]", el).value);
    if (!id) return ($(".error", el).textContent = "یک نفر را انتخاب کنید");
    try {
      await link(id);
      close();
      toast(`${fullName(person(id))} به‌عنوان ${word} ثبت شد`);
      await loadTree();
    } catch (e) {
      $(".error", el).textContent = e.message;
    }
  });

  function openNewParent() {
    openPersonForm({
      title: `افزودن ${word} برای ${esc(fullName(p))}`,
      preset: { gender: male ? "male" : "female", last_name: male ? p.last_name : "", clan_id: p.clan_id },
      lockGender: true,
      after: (np) => link(np.id),
    });
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
      return openPersonForm({ title: `${word} تازه برای ${esc(fullName(p))}`, preset: { gender: spouseGender, clan_id: S.clanId ?? p.clan_id }, lockGender: true, after: (np) => link(np.id) });
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
    const send = Object.fromEntries(Object.entries(data).filter(([k, v]) => !sameValue(v, m[k])));
    if (!Object.keys(send).length) return close();
    try {
      if (!(await saveWithConflicts("PUT", `/api/marriages/${m.id}`, { ...send, base_version: m.version }))) return;
      close();
      toast("ذخیره شد");
      await loadTree();
    } catch (e) {
      $(".error", el).textContent = e.message;
    }
  });
}

function openMoveClan(p) {
  const targets = S.clans.filter((c) => c.id !== p.clan_id && canAddInClan(c.id));
  if (!targets.length) return toast("طایفهٔ دیگری که اجازهٔ افزودن به آن را داشته باشید نیست", true);
  const { el, close } = modal({
    title: `انتقال ${esc(fullName(p))} به طایفهٔ دیگر`,
    body: `<label class="field"><span>طایفهٔ مقصد</span><select class="input" name="clan">${targets.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select></label>
      <div class="field"><span>همراه با</span>
        <label class="check"><input type="radio" name="with" value="self" checked> فقط خود این شخص</label>
        <label class="check"><input type="radio" name="with" value="ancestors"> این شخص و نیاکانش (مثلاً عروسی که خانواده‌اش اشتباهی در این طایفه ثبت شده)</label>
        <label class="check"><input type="radio" name="with" value="descendants"> این شخص و نوادگانش</label>
      </div>
      <p class="hint">فقط کسانی منتقل می‌شوند که در طایفهٔ فعلیِ این شخص هستند و اجازهٔ ویرایششان را دارید.</p>`,
    foot: `<button class="btn" data-cancel>انصراف</button><button class="btn primary" data-go>انتقال</button>`,
  });
  $("[data-cancel]", el).addEventListener("click", close);
  $("[data-go]", el).addEventListener("click", async () => {
    try {
      const res = await api("POST", `/api/people/${p.id}/move`, { clan_id: Number($("[name=clan]", el).value), with: $("[name=with]:checked", el).value });
      close();
      toast(`${toFa(res.moved)} نفر منتقل شد`);
      await loadTree();
    } catch (e) {
      toast(e.message, true);
    }
  });
}

async function deletePerson(p) {
  if (!confirm(`«${fullName(p)}» از شجره‌نامه حذف شود؟ ارتباط فرزندان و ازدواج‌های او نیز حذف می‌شود.`)) return;
  try {
    if (!(await saveWithConflicts("DELETE", `/api/people/${p.id}?base_version=${p.version ?? ""}`))) return;
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
      <p class="hint">دسترسی شما: ${
        permAll()
          ? "کامل"
          : `دیدن ${toFa(S.people.length)} نفر، ویرایش ${toFa(S.perm?.editable?.size || 0)} نفر${S.perm?.addClans?.size ? `، افزودن در ${S.perm.addClans.has(null) ? "همهٔ طایفه‌ها" : [...S.perm.addClans].map(clanName).join("، ")}` : ""}`
      }</p>
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

// ---------------------------------------------------------------------------
// administration: users, access groups, clans, backup

const LEVEL_FA = { view: "دیدن", edit: "دیدن، افزودن و ویرایش", delete: "دیدن، افزودن، ویرایش و حذف" };
const ACCESS_HINT =
  "هر دسترسی یعنی: در کدام طایفه، کل طایفه یا شاخهٔ کدام شخص (او، نوادگانش و همسرانشان)، با چه سطحی، تا کدام نسل. نیاکانِ شخص مبنای شاخه همیشه دیده می‌شوند. دسترسی نهایی هر کاربر مجموع دسترسی‌های خودش و گروه‌هایش است.";

function clanName(id) {
  return S.clans.find((c) => c.id === id)?.name || "؟";
}

function grantText(g) {
  const where = g.root_id != null ? `شاخهٔ ${person(g.root_id) ? lineageName(person(g.root_id), 1) : "؟"}` : g.clan_id != null ? `کل طایفهٔ ${clanName(g.clan_id)}` : "همهٔ طایفه‌ها";
  return `${where} · ${LEVEL_FA[g.level]}${g.max_gen ? ` · تا نسل ${toFa(g.max_gen)}` : ""}`;
}

/** Editable list of grants: clan · whole clan or a branch · level · down to generation. */
function grantsEditor(container, grants) {
  const n = maxGen();
  const row = (g = { clan_id: S.clanId ?? null, root_id: null, level: "view", max_gen: null }) => {
    const div = document.createElement("div");
    div.className = "grant-row";
    div.innerHTML = `
      <select class="input" data-f="clan"><option value="">همهٔ طایفه‌ها</option>${S.clans.map((c) => `<option value="${c.id}" ${g.clan_id === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
      <select class="input" data-f="root"></select>
      <select class="input" data-f="level">${Object.entries(LEVEL_FA).map(([k, v]) => `<option value="${k}" ${g.level === k ? "selected" : ""}>${v}</option>`).join("")}</select>
      <select class="input" data-f="gen"><option value="">همهٔ نسل‌ها</option>${Array.from({ length: n }, (_, i) => `<option value="${i + 1}" ${g.max_gen === i + 1 ? "selected" : ""}>تا نسل ${toFa(i + 1)}</option>`).join("")}</select>
      <button class="btn small danger" type="button" data-f="del" title="حذف">✕</button>`;
    const clanSel = $("[data-f=clan]", div);
    const rootSel = $("[data-f=root]", div);
    const fillRoots = (selected) => {
      const clan = clanSel.value ? Number(clanSel.value) : null;
      rootSel.innerHTML = personOptions((p) => clan == null || p.clan_id === clan, selected, { none: clan == null ? "— کل شجره‌نامه —" : "— کل طایفه —" });
      for (const o of rootSel.options) if (o.value) o.textContent = `شاخهٔ ${o.textContent}`;
    };
    fillRoots(g.root_id);
    clanSel.addEventListener("change", () => fillRoots(null));
    $("[data-f=del]", div).addEventListener("click", () => div.remove());
    return div;
  };
  container.innerHTML = `<div class="grant-list"></div><button class="btn small" type="button" data-add-grant>＋ افزودن دسترسی</button>`;
  const list = $(".grant-list", container);
  for (const g of grants) list.appendChild(row(g));
  $("[data-add-grant]", container).addEventListener("click", () => list.appendChild(row()));
  return () =>
    $$(".grant-row", list).map((r) => ({
      clan_id: $("[data-f=clan]", r).value ? Number($("[data-f=clan]", r).value) : null,
      root_id: $("[data-f=root]", r).value ? Number($("[data-f=root]", r).value) : null,
      level: $("[data-f=level]", r).value,
      max_gen: $("[data-f=gen]", r).value ? Number($("[data-f=gen]", r).value) : null,
    }));
}

function openUserAccess(u, groups, done) {
  const { el, close } = modal({
    title: `دسترسی ${esc(u.display_name || u.username)}`,
    wide: true,
    body: `
      <div class="section-title" style="border:0;margin-top:0;padding-top:0">گروه‌های دسترسی</div>
      ${groups.length ? `<div class="chips">${groups.map((g) => `<label class="check chip-check"><input type="checkbox" value="${g.id}" ${u.groups.includes(g.id) ? "checked" : ""}> ${esc(g.name)}</label>`).join("")}</div>` : `<p class="muted">هنوز گروهی ساخته نشده است.</p>`}
      <div class="section-title">دسترسی‌های اختصاصی این کاربر</div>
      <div data-grants></div>
      <p class="hint">${ACCESS_HINT}</p>
      <div class="error"></div>`,
    foot: `<button class="btn" data-cancel>انصراف</button><button class="btn primary" data-save>ذخیره</button>`,
  });
  const read = grantsEditor($("[data-grants]", el), u.grants);
  $("[data-cancel]", el).addEventListener("click", close);
  $("[data-save]", el).addEventListener("click", async () => {
    try {
      const groupIds = $$(".chip-check input:checked", el).map((i) => Number(i.value));
      await api("PUT", `/api/users/${u.id}/access`, { groups: groupIds, grants: read() });
      close();
      toast("دسترسی ذخیره شد");
      done?.();
    } catch (e) {
      $(".error", el).textContent = e.message;
    }
  });
}

function openGroupForm(g, users, done) {
  const isNew = !g;
  g ||= { name: "", description: "", members: [], grants: [] };
  const { el, close } = modal({
    title: isNew ? "گروه دسترسی تازه" : `گروه «${esc(g.name)}»`,
    wide: true,
    body: `
      <div class="row">
        <label class="field"><span>نام گروه</span><input class="input" name="name" value="${esc(g.name)}" placeholder="مثلاً ویرایشگران طایفهٔ رحیمی"></label>
        <label class="field"><span>توضیح</span><input class="input" name="description" value="${esc(g.description)}"></label>
      </div>
      <div class="section-title">دسترسی‌های گروه</div>
      <div data-grants></div>
      <div class="section-title">اعضا</div>
      <div class="chips">${users.filter((u) => u.role !== "admin").map((u) => `<label class="check chip-check"><input type="checkbox" value="${u.id}" ${g.members.includes(u.id) ? "checked" : ""}> ${esc(u.display_name || u.username)}</label>`).join("") || `<span class="muted">کاربری نیست</span>`}</div>
      <p class="hint">${ACCESS_HINT}</p>
      <div class="error"></div>`,
    foot: `${isNew ? "" : `<button class="btn danger" data-del>حذف گروه</button>`}<span class="spacer"></span><button class="btn" data-cancel>انصراف</button><button class="btn primary" data-save>ذخیره</button>`,
  });
  const read = grantsEditor($("[data-grants]", el), g.grants);
  $("[data-cancel]", el).addEventListener("click", close);
  $("[data-del]", el)?.addEventListener("click", async () => {
    if (!confirm("این گروه حذف شود؟ اعضا دسترسی‌های این گروه را از دست می‌دهند.")) return;
    await api("DELETE", `/api/groups/${g.id}`).then(() => (close(), done?.()), (e) => toast(e.message, true));
  });
  $("[data-save]", el).addEventListener("click", async () => {
    const data = {
      name: $("[name=name]", el).value,
      description: $("[name=description]", el).value,
      grants: read(),
      members: $$(".chip-check input:checked", el).map((i) => Number(i.value)),
    };
    try {
      await (isNew ? api("POST", "/api/groups", data) : api("PUT", `/api/groups/${g.id}`, data));
      close();
      toast("گروه ذخیره شد");
      done?.();
    } catch (e) {
      $(".error", el).textContent = e.message;
    }
  });
}

async function openAdmin(tab = "users") {
  let data;
  let acc;
  try {
    [data, acc] = await Promise.all([api("GET", "/api/users"), api("GET", "/api/access")]);
  } catch (e) {
    return toast(e.message, true);
  }
  const reopen = (t) => () => openAdmin(t);
  const counts = new Map();
  for (const p of S.people) counts.set(p.clan_id, (counts.get(p.clan_id) || 0) + 1);
  const { el, close } = modal({
    title: "مدیریت",
    wide: true,
    body: `
      <div class="tabs">
        <button data-tab="users">کاربران</button><button data-tab="groups">گروه‌های دسترسی</button>
        <button data-tab="clans">طایفه‌ها</button><button data-tab="backup">پشتیبان‌گیری</button>
      </div>
      <div data-pane="users">
        <label class="check"><input type="checkbox" name="allow_registration" ${data.allowRegistration ? "checked" : ""}> ثبت‌نام عمومی آزاد باشد (کاربر تازه تا وقتی دسترسی نگیرد چیزی نمی‌بیند)</label>
        <div class="table-wrap"><table class="users">
          <thead><tr><th>نام</th><th>نام کاربری</th><th>نقش</th><th>دسترسی</th><th></th></tr></thead>
          <tbody>${acc.users
            .map((u) => {
              const summary =
                u.role === "admin"
                  ? "همه‌چیز"
                  : [...u.groups.map((gid) => `گروه ${acc.groups.find((g) => g.id === gid)?.name || "؟"}`), ...u.grants.map(grantText)].join("؛ ") || "بدون دسترسی";
              return `<tr data-uid="${u.id}">
              <td>${esc(u.display_name)}</td><td dir="ltr">${esc(u.username)}</td>
              <td><select class="input" data-role ${u.id === S.user.id ? "disabled" : ""}>
                <option value="admin" ${u.role === "admin" ? "selected" : ""}>مدیر</option>
                <option value="viewer" ${u.role !== "admin" ? "selected" : ""}>کاربر</option></select></td>
              <td class="access-cell">${esc(summary)} ${u.role !== "admin" ? `<button class="btn small" data-access>تعیین</button>` : ""}</td>
              <td><button class="btn small" data-reset>رمز تازه</button> ${u.id !== S.user.id ? `<button class="btn small danger" data-del>حذف</button>` : ""}</td>
            </tr>`;
            })
            .join("")}</tbody>
        </table></div>
        <div class="section-title">کاربر تازه</div>
        <form id="nu" class="row" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">
          <label class="field"><span>نام نمایشی</span><input class="input" name="display_name"></label>
          <label class="field"><span>نام کاربری</span><input class="input" name="username" dir="ltr"></label>
          <label class="field"><span>رمز عبور</span><input class="input" name="password" type="password" dir="ltr" autocomplete="new-password"></label>
          <label class="field"><span>نقش</span><select class="input" name="role"><option value="viewer">کاربر</option><option value="admin">مدیر</option></select></label>
        </form>
        <div class="error"></div>
        <button class="btn primary" data-create>ساخت کاربر و تعیین دسترسی</button>
        <p class="hint">مدیر همه‌چیز را می‌بیند و ویرایش می‌کند. هر کاربر دیگر فقط به اندازهٔ دسترسی‌هایش (و گروه‌هایش) می‌بیند و ویرایش می‌کند.</p>
      </div>
      <div data-pane="groups" hidden>
        <p class="hint">دسترسی‌ها را دسته‌بندی کنید: مثلاً «ویرایشگران طایفهٔ رحیمی» یا «خانوادهٔ حسن — فقط دیدن»، و کاربران را عضو گروه‌ها کنید.</p>
        ${
          acc.groups.length
            ? `<div class="table-wrap"><table class="users"><thead><tr><th>گروه</th><th>دسترسی‌ها</th><th>اعضا</th><th></th></tr></thead><tbody>${acc.groups
                .map(
                  (g) => `<tr data-gid="${g.id}"><td><b>${esc(g.name)}</b>${g.description ? `<div class="muted small">${esc(g.description)}</div>` : ""}</td>
                  <td class="access-cell">${esc(g.grants.map(grantText).join("؛ ") || "—")}</td>
                  <td>${toFa(g.members.length)}</td><td><button class="btn small" data-edit-group>ویرایش</button></td></tr>`,
                )
                .join("")}</tbody></table></div>`
            : `<p class="muted">هنوز گروهی ساخته نشده است.</p>`
        }
        <button class="btn primary" data-new-group>＋ گروه تازه</button>
      </div>
      <div data-pane="clans" hidden>
        <p class="hint">هر طایفه درخت جداگانه‌ای است. عروس‌ها و دامادها می‌توانند عضو طایفهٔ خودشان باشند و شجره‌نامهٔ خانوادهٔ خودشان را داشته باشند؛ در درخت طایفهٔ همسرشان به‌صورت «مهمان» دیده می‌شوند.</p>
        <div class="table-wrap"><table class="users"><thead><tr><th>طایفه</th><th>اعضا</th><th></th></tr></thead><tbody>
          ${S.clans.map((c) => `<tr data-cid="${c.id}"><td><input class="input" data-cname value="${esc(c.name)}"></td><td>${toFa(counts.get(c.id) || 0)}</td>
            <td><button class="btn small" data-csave>ذخیره</button> <button class="btn small danger" data-cdel ${counts.get(c.id) ? "disabled" : ""}>حذف</button></td></tr>`).join("")}
        </tbody></table></div>
        <div class="actions"><input class="input" data-new-clan placeholder="نام طایفهٔ تازه" style="max-width:260px"><button class="btn primary" data-add-clan>＋ افزودن طایفه</button></div>
      </div>
      <div data-pane="backup" hidden>
        <p>از کل شجره‌نامه (طایفه‌ها، اشخاص و ازدواج‌ها) فایل JSON بگیرید یا آن را بازیابی کنید.</p>
        <div class="actions">
          <a class="btn" href="/api/export" download>⬇ دریافت فایل پشتیبان</a>
          <label class="btn">⬆ بازیابی از فایل<input type="file" accept="application/json,.json" hidden data-import></label>
        </div>
        <p class="hint">هشدار: بازیابی، همهٔ داده‌های فعلی شجره‌نامه را جایگزین می‌کند.</p>
      </div>`,
  });
  const showTab = (t) => {
    $$("[data-tab]", el).forEach((x) => x.classList.toggle("active", x.dataset.tab === t));
    $$("[data-pane]", el).forEach((x) => (x.hidden = x.dataset.pane !== t));
  };
  showTab(tab);
  $$("[data-tab]", el).forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  const fail = (e) => toast(e.message, true);
  $("[name=allow_registration]", el).addEventListener("change", (e) =>
    api("PUT", "/api/settings", { allow_registration: e.target.checked }).then(() => toast("ذخیره شد"), fail),
  );
  $$("tr[data-uid]", el).forEach((tr) => {
    const id = tr.dataset.uid;
    const u = acc.users.find((x) => String(x.id) === id);
    $("[data-role]", tr).addEventListener("change", (e) => api("PUT", `/api/users/${id}`, { role: e.target.value }).then(() => (close(), openAdmin("users")), fail));
    $("[data-access]", tr)?.addEventListener("click", () => openUserAccess(u, acc.groups, () => (close(), openAdmin("users"))));
    $("[data-reset]", tr).addEventListener("click", () => {
      const pw = prompt("رمز عبور تازه (دست‌کم ۸ نویسه):");
      if (pw) api("PUT", `/api/users/${id}`, { password: pw }).then(() => toast("رمز تغییر کرد"), fail);
    });
    $("[data-del]", tr)?.addEventListener("click", () => {
      if (confirm("این کاربر حذف شود؟")) api("DELETE", `/api/users/${id}`).then(() => (close(), openAdmin("users")), fail);
    });
  });
  $("[data-create]", el).addEventListener("click", async () => {
    try {
      const form = Object.fromEntries(new FormData($("#nu", el)));
      const res = await api("POST", "/api/users", form);
      close();
      toast("کاربر ساخته شد؛ حالا دسترسی‌اش را تعیین کنید");
      if (form.role !== "admin") {
        openUserAccess({ id: res.id, username: form.username, display_name: form.display_name, groups: [], grants: [] }, acc.groups, reopen("users"));
      } else openAdmin("users");
    } catch (e) {
      $("[data-pane=users] > .error", el).textContent = e.message;
    }
  });
  $("[data-new-group]", el).addEventListener("click", () => openGroupForm(null, acc.users, () => (close(), openAdmin("groups"))));
  $$("tr[data-gid]", el).forEach((tr) =>
    $("[data-edit-group]", tr).addEventListener("click", () =>
      openGroupForm(acc.groups.find((g) => String(g.id) === tr.dataset.gid), acc.users, () => (close(), openAdmin("groups"))),
    ),
  );
  $$("tr[data-cid]", el).forEach((tr) => {
    const id = tr.dataset.cid;
    $("[data-csave]", tr).addEventListener("click", () =>
      api("PUT", `/api/clans/${id}`, { name: $("[data-cname]", tr).value }).then(async () => (toast("ذخیره شد"), await loadTree()), fail),
    );
    $("[data-cdel]", tr).addEventListener("click", () => {
      if (confirm("این طایفه حذف شود؟")) api("DELETE", `/api/clans/${id}`).then(async () => (close(), await loadTree(), openAdmin("clans")), fail);
    });
  });
  $("[data-add-clan]", el).addEventListener("click", async () => {
    const name = $("[data-new-clan]", el).value.trim();
    if (!name) return;
    try {
      await api("POST", "/api/clans", { name });
      close();
      await loadTree();
      openAdmin("clans");
    } catch (e) {
      fail(e);
    }
  });
  if (DEMO) {
    // no server to download from: build the backup in the page
    $('a[href="/api/export"]', el).addEventListener("click", (e) => {
      e.preventDefault();
      download(`familytree-demo-${stamp()}.json`, S.demo.exportData());
    });
  }
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
// history (version control)

const ACTION_FA = { create: "ایجاد", update: "ویرایش", delete: "حذف", restore: "بازیابی" };
const PERSON_FIELDS = ["first_name", "last_name", "nickname", "gender", "birth_date", "death_date", "is_deceased", "birth_place", "photo_url", "notes", "father_id", "mother_id", "clan_id", "birth_order", "phone"];

const when = (at) => toFa(new Date(`${String(at).replace(" ", "T")}Z`).toLocaleString("fa-IR", { dateStyle: "medium", timeStyle: "short" }));

/** Admins see who added a person and who changed them last (from the change log). */
function auditLines(id) {
  const a = isAdmin() && S.audit?.get(id);
  if (!a) return "";
  const who = (name) => (name ? esc(name) : `<span class="muted">پیش از ثبت تاریخچه</span>`);
  return `<dt>افزوده توسط</dt><dd>${who(a.created_by)} <span class="muted">${when(a.created_at)}</span></dd>
    ${a.edits ? `<dt>آخرین تغییر</dt><dd>${who(a.updated_by)} <span class="muted">${when(a.updated_at)} · ${toFa(a.edits)} ویرایش</span></dd>` : ""}`;
}

/** A person's versions, newest first, with what changed and a way back to any of them. */
async function loadPersonHistory(p, box) {
  let rows;
  try {
    ({ history: rows } = await api("GET", `/api/people/${p.id}/history`));
  } catch (e) {
    box.textContent = e instanceof OfflineError ? "تاریخچه فقط به‌صورت آنلاین در دسترس است." : e.message;
    return;
  }
  if (!box.isConnected) return;
  const editor = canEditPerson(p.id) && !S.offline;
  box.className = "history";
  box.innerHTML = rows
    .map((h, i) => {
      const prev = rows[i + 1]?.data;
      const fields = h.action === "update" ? h.changed : [];
      return `<div class="hrow" data-i="${i}">
        <div class="hhead"><b>نسخهٔ ${toFa(h.version)}</b> · ${ACTION_FA[h.action] || h.action}${h.user_name ? ` · ${esc(h.user_name)}` : ""} <span class="muted">${when(h.at)}</span></div>
        ${
          fields.length
            ? `<ul class="hchanges">${fields
                .map((f) => `<li>${FIELD_FA[f] || f}: <span class="muted">${esc(showValue(f, prev?.[f]))}</span> ← <b>${esc(showValue(f, h.data[f]))}</b></li>`)
                .join("")}</ul>`
            : ""
        }
        ${editor && i > 0 && h.action !== "delete" ? `<button class="btn small" data-revert="${i}">بازگرداندن به این نسخه</button>` : ""}
      </div>`;
    })
    .join("") || `<p class="muted">سابقه‌ای ثبت نشده است.</p>`;
  $$("[data-revert]", box).forEach((b) =>
    b.addEventListener("click", async () => {
      const h = rows[Number(b.dataset.revert)];
      if (!confirm(`«${fullName(p)}» به نسخهٔ ${toFa(h.version)} بازگردانده شود؟ (یک نسخهٔ تازه ساخته می‌شود و تاریخچه حفظ می‌شود)`)) return;
      const data = Object.fromEntries(PERSON_FIELDS.filter((f) => !sameValue(h.data[f], p[f])).map((f) => [f, h.data[f]]));
      try {
        if (!(await saveWithConflicts("PUT", `/api/people/${p.id}`, { ...data, base_version: p.version }))) return;
        toast(`به نسخهٔ ${toFa(h.version)} بازگردانده شد`);
        await loadTree();
      } catch (e) {
        toast(e.message, true);
      }
    }),
  );
}

/** Recent changes across the tree (what this user may see); admins can restore deleted people. */
async function openRecentChanges() {
  let data;
  try {
    data = await api("GET", "/api/history");
  } catch (e) {
    return toast(e instanceof OfflineError ? "فهرست تغییرات فقط به‌صورت آنلاین در دسترس است." : e.message, true);
  }
  const name = (h) => {
    if (h.entity === "person") return `${h.data.first_name} ${h.data.last_name || ""}`.trim();
    return `ازدواج ${showValue("husband_id", h.data.husband_id)} و ${showValue("wife_id", h.data.wife_id)}`;
  };
  const { el, close } = modal({
    title: "آخرین تغییرات",
    wide: true,
    body: `<div class="table-wrap"><table class="users changes">
      <thead><tr><th>زمان</th><th>چه کسی</th><th>تغییر</th><th>مورد</th><th></th></tr></thead>
      <tbody>${data.history
        .map(
          (h) => `<tr>
          <td class="muted">${when(h.at)}</td><td>${esc(h.user_name || "—")}</td>
          <td>${ACTION_FA[h.action] || h.action}${h.changed?.length ? ` <span class="muted">(${h.changed.map((f) => FIELD_FA[f] || f).join("، ")})</span>` : ""}</td>
          <td>${h.entity === "person" && person(h.entity_id) ? `<button class="chip ${h.data.gender}" data-goto="${h.entity_id}">${esc(name(h))}</button>` : esc(name(h))}</td>
          <td>${h.deleted && h.action === "delete" && isAdmin() && !S.offline ? `<button class="btn small" data-restore="${h.entity_id}">بازیابی</button>` : ""}</td>
        </tr>`,
        )
        .join("")}</tbody></table></div>
      ${data.history.length ? "" : `<p class="muted">تغییری ثبت نشده است.</p>`}`,
  });
  $$("[data-goto]", el).forEach((b) =>
    b.addEventListener("click", () => {
      close();
      selectPerson(Number(b.dataset.goto));
    }),
  );
  $$("[data-restore]", el).forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        const res = await api("POST", `/api/people/${b.dataset.restore}/restore`, {});
        close();
        toast(`بازیابی شد${res.marriages ? ` (همراه با ${toFa(res.marriages)} ازدواج)` : ""}`);
        await loadTree();
        selectPerson(Number(b.dataset.restore));
      } catch (e) {
        toast(e.message, true);
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// offline

function editOffline(method, path, data) {
  if (!canEdit()) throw new Error("دسترسی ویرایش ندارید");
  const base = local.snapshot(S.user.id);
  if (!base) throw new OfflineError("نسخهٔ آفلاینی از شجره‌نامه روی این دستگاه نیست");
  const { ops, response } = queueEdit(local.ops(S.user.id), base, method, path, data);
  if (!local.setOps(S.user.id, ops)) throw new Error("حافظهٔ مرورگر پر است؛ تغییرات را در فایل ذخیره کنید");
  updateNetChip();
  // online but earlier edits are still queued (e.g. waiting on a conflict): try to send now
  if (!S.offline) setTimeout(() => autoSync(), 0);
  return response;
}

// ---------------------------------------------------------------------------
// version control: automatic sync and conflict resolution

const FIELD_FA = {
  first_name: "نام",
  last_name: "نام خانوادگی",
  nickname: "لقب",
  gender: "جنسیت",
  birth_date: "تاریخ تولد",
  death_date: "تاریخ وفات",
  is_deceased: "درگذشته",
  birth_place: "محل تولد",
  photo_url: "عکس",
  notes: "یادداشت",
  father_id: "پدر",
  mother_id: "مادر",
  clan_id: "طایفه",
  birth_order: "فرزند چندم",
  phone: "شمارهٔ تماس",
  husband_id: "شوهر",
  wife_id: "همسر",
  status: "وضعیت",
  marriage_date: "تاریخ ازدواج",
  end_date: "تاریخ پایان",
};

/** Field values equal for editing purposes ("" / null, booleans as 0/1, numbers as text). */
function sameValue(a, b) {
  const n = (v) => (v === true ? "1" : v === false ? "0" : v == null ? "" : String(v));
  return n(a) === n(b);
}

function showValue(field, v) {
  if (v == null || v === "") return "—";
  if (["father_id", "mother_id", "husband_id", "wife_id"].includes(field)) return person(Number(v)) ? fullName(person(Number(v))) : `#${toFa(v)}`;
  if (field === "clan_id") return clanName(Number(v));
  if (field === "gender") return v === "male" ? "مرد" : "زن";
  if (field === "is_deceased") return Number(v) ? "بله" : "خیر";
  if (field === "status") return STATUS_FA[v] || v;
  return toFa(String(v));
}

function opTarget(op, conflict) {
  const cur = conflict?.current;
  if (op.type.endsWith("Person")) return fullName(person(op.id) || cur || op.data) || "؟";
  const m = cur || S.marriages.find((x) => x.id === op.id) || op.data || {};
  return `${fullName(person(Number(m.husband_id)))} و ${fullName(person(Number(m.wife_id)))}`;
}

/**
 * Show what needs the user's decision and resolve to their choices, or null if they close it.
 * entries: {status:'conflict'|'failed'|'waiting', op, conflict?, error?, gone?}
 */
function conflictDialog(entries, { title = "تعارض در همگام‌سازی", offline = true } = {}) {
  return new Promise((resolve) => {
    const body = entries
      .map((e, i) => {
        const what = e.op.type.endsWith("Person")
          ? `${({ createPerson: "افزودن", updatePerson: "ویرایش", deletePerson: "حذف" })[e.op.type]} ${opTarget(e.op, e.conflict)}`
          : `${describeOp(e.op, () => "")} — ${opTarget(e.op, e.conflict)}`;
        if (e.status === "conflict" && e.conflict.delete) {
          return `<div class="conflict" data-i="${i}"><h4>⚠ ${esc(what)}</h4>
            <p>این مورد پس از آخرین بارگذاری شما روی سرور تغییر کرده است.</p>
            <label class="check"><input type="radio" name="c${i}" value="apply" checked> با این حال حذف شود</label>
            <label class="check"><input type="radio" name="c${i}" value="drop"> حذف نشود</label></div>`;
        }
        if (e.status === "conflict") {
          return `<div class="conflict" data-i="${i}"><h4>⚠ ${esc(what)}</h4>
            <p class="hint">این فیلدها را کس دیگری هم پس از آخرین بارگذاری شما تغییر داده است. برای هر کدام یکی را انتخاب کنید:</p>
            <table class="users diff"><thead><tr><th>فیلد</th><th>قبلاً</th><th>روی سرور</th><th>نسخهٔ شما</th></tr></thead><tbody>
            ${e.conflict.fields
              .map(
                (f) => `<tr><td>${FIELD_FA[f.field] || f.field}</td><td class="muted">${esc(showValue(f.field, f.base))}</td>
                  <td><label class="check"><input type="radio" name="c${i}-${f.field}" value="server"> ${esc(showValue(f.field, f.server))}</label></td>
                  <td><label class="check"><input type="radio" name="c${i}-${f.field}" value="mine" checked> ${esc(showValue(f.field, f.mine))}</label></td></tr>`,
              )
              .join("")}
            </tbody></table></div>`;
        }
        if (e.status === "waiting") return `<div class="conflict waiting" data-i="${i}"><h4>⏳ ${esc(what)}</h4><p class="muted">${esc(e.error)}</p></div>`;
        return `<div class="conflict failed" data-i="${i}"><h4>✖ ${esc(what)}</h4><p class="error">${esc(e.error)}</p>
          ${
            e.gone
              ? `<p class="muted">این مورد روی سرور حذف شده است؛ این تغییر کنار گذاشته می‌شود.</p>`
              : `<label class="check"><input type="radio" name="c${i}" value="drop" checked> کنار گذاشتن این تغییر</label>
                 ${offline ? `<label class="check"><input type="radio" name="c${i}" value="keep"> نگه داشتن در صف (برای بعد)</label>` : ""}`
          }</div>`;
      })
      .join("");
    const { el, close } = modal({
      title,
      wide: true,
      body: `<p>برخی تغییرات به‌خاطر تعارض یا خطا ثبت نشدند و باید بررسی شوند. بقیهٔ تغییرات ثبت شده‌اند.</p>${body}`,
      foot: `${offline ? `<button class="btn" data-file>💾 ذخیرهٔ تغییرات در فایل</button>` : ""}<span class="spacer"></span><button class="btn" data-later>${offline ? "بعداً" : "انصراف"}</button><button class="btn primary" data-apply>اعمال و ثبت</button>`,
      onClose: () => finish(null), // Esc / ✕ / backdrop count as "later"
    });
    let answered = false;
    const finish = (v) => {
      if (answered) return;
      answered = true;
      close();
      resolve(v);
    };
    $("[data-later]", el).addEventListener("click", () => finish(null));
    $("[data-file]", el)?.addEventListener("click", () => saveOpsFile());
    $("[data-apply]", el).addEventListener("click", () =>
      finish(
        entries.map((e, i) => {
          if (e.status === "waiting") return { action: "keep" };
          if (e.status === "conflict" && !e.conflict.delete) {
            const fields = Object.fromEntries(e.conflict.fields.map((f) => [f.field, $(`[name="c${i}-${f.field}"]:checked`, el)?.value || "mine"]));
            return { action: "apply", fields };
          }
          if (e.gone) return { action: "drop" };
          return { action: $(`[name="c${i}"]:checked`, el)?.value || "drop" };
        }),
      ),
    );
  });
}

/** Turn a decision into the op to send again (null = drop it). */
function resolvedOp(entry, decision) {
  const op = { ...entry.op, data: entry.op.data ? { ...entry.op.data } : undefined };
  if (decision.action === "drop") return null;
  if (decision.action === "keep") return op;
  if (entry.status === "conflict") {
    // based on the server's version now; fields where the server's value was chosen are left out
    op.base_version = entry.conflict.version;
    for (const [f, pick] of Object.entries(decision.fields || {})) if (pick === "server" && op.data) delete op.data[f];
  }
  return op;
}

let syncing = false;

/**
 * Replay edits, asking the user about conflicts and errors and replaying their decisions,
 * until everything went through or the user postpones. `queue`: keep the device's offline
 * queue in step (for edits made on this device).
 */
async function syncLoop(ops, { queue = false } = {}) {
  const store = (list) => queue && (local.setOps(S.user.id, list), updateNetChip());
  let done = 0;
  for (let round = 0; round < 20 && ops.length; round++) {
    const res = await replay(ops, apiFetch);
    done += res.done;
    ops = res.remaining;
    store(ops);
    if (!res.pending.length || res.pending.every((p) => p.status === "waiting")) break;
    await loadTree();
    const decisions = await conflictDialog(res.pending, { offline: queue });
    if (!decisions) return { done, remaining: ops, postponed: true };
    ops = res.pending.map((p, i) => resolvedOp(p, decisions[i])).filter(Boolean);
    store(ops);
  }
  return { done, remaining: ops };
}

/** Send queued offline edits; merges silently, asks the user only about real conflicts. */
async function autoSync() {
  if (syncing || S.offline || !S.user || !local.ops(S.user.id).length) return;
  syncing = true;
  try {
    const res = await syncLoop(local.ops(S.user.id), { queue: true });
    await loadTree();
    if (res.postponed) toast("تغییرات حل‌نشده در صف ماندند؛ از «☁️ آفلاین» دوباره بررسی کنید", true);
    else if (res.done) toast(`${toFa(res.done)} تغییر آفلاین خودکار روی سرور ثبت شد`);
  } catch (e) {
    if (e instanceof OfflineError) goOffline();
    else toast(e.message, true);
  } finally {
    syncing = false;
  }
}

function saveOpsFile(ops = local.ops(S.user.id)) {
  download(`familytree-changes-${stamp()}.json`, {
    format: CHANGES_FORMAT,
    created_at: new Date().toISOString(),
    user: S.user.username,
    base_saved_at: local.snapshot(S.user.id)?.saved_at,
    ops,
  });
}

/**
 * Save an edit online; if it conflicts with a newer version on the server, let the user pick
 * per field and save again. Returns the server's response, or null if the user gave up.
 */
async function saveWithConflicts(method, path, data) {
  try {
    return await api(method, path, data);
  } catch (e) {
    if (e.status !== 409 || !e.data?.conflict) throw e;
    const id = Number(path.match(/\/(\d+)/)[1]);
    const type = `${method === "DELETE" ? "delete" : "update"}${path.includes("/people/") ? "Person" : "Marriage"}`;
    const entry = { status: "conflict", op: { type, id, data: data && { ...data } }, conflict: e.data.conflict };
    if (entry.op.data) delete entry.op.data.base_version;
    const [decision] = (await conflictDialog([entry], { title: "تعارض در ذخیره", offline: false })) || [];
    if (!decision) return null;
    const op = resolvedOp(entry, decision);
    if (!op) return null;
    const base = `${path.split("?")[0]}`;
    if (method === "DELETE") return saveWithConflicts("DELETE", `${base}?base_version=${op.base_version}`);
    return saveWithConflicts(method, base, { ...(op.data || {}), base_version: op.base_version });
  }
}

function goOffline() {
  if (S.offline) return;
  S.offline = true;
  updateNetChip();
  toast("اتصال قطع است؛ تغییرات روی همین دستگاه ذخیره می‌شوند");
}

async function checkOnline() {
  try {
    const st = await apiFetch("GET", "/api/status");
    if (!st.user) return; // session expired: the next real call shows the login screen
    S.offline = false;
    updateNetChip();
    const n = local.ops(S.user.id).length;
    if (n) await autoSync();
    else {
      toast("اتصال برقرار شد");
      loadTree();
    }
  } catch {
    // still offline
  }
}

function updateNetChip() {
  const chip = $(".net-chip");
  if (!chip || !S.user) return;
  const n = local.ops(S.user.id).length;
  chip.hidden = !S.offline && !n;
  chip.textContent = S.offline ? (n ? `آفلاین · ${toFa(n)}` : "آفلاین") : `${toFa(n)} تغییر`;
  chip.classList.toggle("off", !!S.offline);
  document.body.classList.toggle("is-offline", !!S.offline);
}

function download(name, data) {
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => (URL.revokeObjectURL(a.href), a.remove()), 1000);
}

function stamp() {
  return new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
}

function showReplayResult(res, el) {
  $("[data-result]", el).innerHTML = `<div class="result-box"><b>${toFa(res.done)} تغییر روی سرور ثبت شد.</b>${
    res.remaining.length ? `<div class="error">${toFa(res.remaining.length)} تغییر حل‌نشده ماند و در فایل جداگانه ذخیره شد.</div>` : ""
  }</div>`;
}

function openSync() {
  const ops = local.ops(S.user.id);
  const snap = local.snapshot(S.user.id);
  const nameOf = (id) => (person(id) ? fullName(person(id)) : "");
  const { el, close } = modal({
    title: "آفلاین و همگام‌سازی",
    wide: true,
    body: `
      <p>${S.offline ? `<span class="pill kind-step">آفلاین</span> اتصال به سرور برقرار نیست.` : `<span class="pill kind-child">آنلاین</span> به سرور وصل هستید.`}
        ${snap?.saved_at ? `<span class="muted">آخرین نسخهٔ ذخیره‌شده روی این دستگاه: ${esc(toFa(new Date(snap.saved_at).toLocaleString("fa-IR")))}</span>` : ""}</p>
      <p class="hint">این برنامه روی دستگاه نصب‌شدنی است (منوی مرورگر ← «نصب» یا «افزودن به صفحهٔ اصلی») و بدون اینترنت هم شجره‌نامه را نشان می‌دهد. تغییراتی که آفلاین بدهید روی همین دستگاه می‌ماند تا آن‌ها را به سرور بفرستید یا در فایل ذخیره کنید.</p>
      <div class="section-title">تغییرات ارسال‌نشده (${toFa(ops.length)})</div>
      ${ops.length ? `<ol class="ops">${ops.map((o) => `<li>${esc(describeOp(o, nameOf))}</li>`).join("")}</ol>` : `<p class="muted">تغییری در صف نیست.</p>`}
      <div class="actions">
        <button class="btn primary" data-send ${ops.length && !S.offline ? "" : "disabled"}>⬆ ارسال تغییرات به سرور</button>
        <button class="btn" data-save-ops ${ops.length ? "" : "disabled"}>💾 ذخیرهٔ تغییرات در فایل JSON</button>
        <button class="btn danger" data-drop ${ops.length ? "" : "disabled"}>دور ریختن تغییرات</button>
      </div>
      <div class="section-title">فایل‌ها</div>
      <div class="actions">
        <label class="btn ${S.offline ? "disabled" : ""}">⬆ بارگذاری فایل تغییرات روی سرور<input type="file" accept="application/json,.json" hidden data-upload ${S.offline || !canEdit() ? "disabled" : ""}></label>
        <button class="btn" data-full>⬇ دریافت نسخهٔ کامل (JSON)</button>
      </div>
      <p class="hint">«فایل تغییرات» فقط کارهایی را دارد که آفلاین انجام داده‌اید؛ بعداً روی سرور اصلی بارگذاری می‌شود و تغییرات به ترتیب ثبت می‌شوند. اگر کسی در این فاصله همان شخص را ویرایش کرده باشد، تغییرهای فیلدهای متفاوت خودکار ادغام می‌شوند و برای فیلدهای مشترک از شما پرسیده می‌شود.</p>
      <div data-result></div>`,
  });
  $("[data-save-ops]", el).addEventListener("click", () => saveOpsFile());
  $("[data-full]", el).addEventListener("click", () =>
    download(`familytree-${stamp()}.json`, { format: "familytree/v1", exported_at: new Date().toISOString(), people: S.people, marriages: S.marriages }),
  );
  $("[data-drop]", el).addEventListener("click", async () => {
    if (!confirm("همهٔ تغییرات ارسال‌نشده پاک شود؟")) return;
    local.setOps(S.user.id, []);
    close();
    updateNetChip();
    await loadTree();
  });
  $("[data-send]", el).addEventListener("click", async () => {
    close();
    await autoSync();
  });
  $("[data-upload]", el).addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.format !== CHANGES_FORMAT || !Array.isArray(data.ops)) throw new Error("این فایل، فایل تغییرات شجره‌نامه نیست");
      if (!confirm(`${toFa(data.ops.length)} تغییر${data.user ? ` از «${data.user}»` : ""} روی سرور ثبت شود؟`)) return;
      const res = await syncLoop(data.ops);
      showReplayResult(res, el);
      if (res.remaining.length) download(`familytree-changes-remaining-${stamp()}.json`, { ...data, ops: res.remaining });
      await loadTree();
    } catch (ex) {
      toast(ex.message, true);
    } finally {
      e.target.value = "";
    }
  });
}

// ---------------------------------------------------------------------------
// settings

function openSettings() {
  const pr = prefs();
  const sample = S.people.find((p) => person(p.father_id) && person(person(p.father_id).father_id)) || S.people[0];
  const { el, close } = modal({
    title: "تنظیمات نمایش",
    body: `<form id="sf">
      <label class="field"><span>تعداد نسلِ نام پدران کنار نام هر نفر (در فهرست‌ها و انتخاب افراد)</span>
        <select class="input" name="nameGens">${[0, 1, 2, 3, 4, 5, 6].map((n) => `<option value="${n}" ${pr.nameGens === n ? "selected" : ""}>${n ? `${toFa(n)} نسل` : "فقط نام"}</option>`).join("")}</select>
      </label>
      ${sample ? `<p class="hint">نمونه: <b data-sample></b></p>` : ""}
      <div class="field"><span>چیدمان شجره‌نامه</span>
        <label class="check"><input type="radio" name="orientation" value="vertical" ${pr.orientation !== "horizontal" ? "checked" : ""}> عمودی: نسل‌ها از بالا به پایین، فرزندان کنار هم</label>
        <label class="check"><input type="radio" name="orientation" value="horizontal" ${pr.orientation === "horizontal" ? "checked" : ""}> افقی: نسل‌ها از راست به چپ، فرزندان زیر هم (برای خانواده‌های پرجمعیت، کم‌عرض‌تر)</label>
      </div>
      <label class="check"><input type="checkbox" name="hoverTip" ${pr.hoverTip ? "checked" : ""}> نمایش اطلاعات و یادداشت با نگه داشتن موس روی هر نفر</label>
      <div class="field"><span>چیدمان خواهر و برادرها</span>
        <label class="check"><input type="radio" name="siblingOrder" value="auto" ${pr.siblingOrder !== "birth" ? "checked" : ""}> خودکار (کمترین خط‌های متقاطع)</label>
        <label class="check"><input type="radio" name="siblingOrder" value="birth" ${pr.siblingOrder === "birth" ? "checked" : ""}> به ترتیب تولد (بزرگ‌تر سمت راست، یا بالا در چیدمان افقی)</label>
      </div>
      <label class="check"><input type="checkbox" name="notesOnTree" ${pr.notesOnTree ? "checked" : ""}> نمایش یادداشت روی کارت‌های شجره‌نامه (برای چاپ، شیوهٔ نمایش یادداشت در پنجرهٔ چاپ انتخاب می‌شود)</label>
      <p class="hint">این تنظیمات برای حساب شما ذخیره می‌شود و روی همهٔ دستگاه‌هایتان اعمال می‌شود.</p>
      <div class="error"></div>
    </form>`,
    foot: `<button class="btn" data-cancel>انصراف</button><button class="btn primary" data-save>ذخیره</button>`,
  });
  const form = $("#sf", el);
  const showSample = () => {
    const t = $("[data-sample]", el);
    if (t) t.textContent = lineageName(sample, Number(form.nameGens.value));
  };
  form.nameGens.addEventListener("change", showSample);
  showSample();
  $("[data-cancel]", el).addEventListener("click", close);
  $("[data-save]", el).addEventListener("click", async () => {
    try {
      await savePrefs({
        nameGens: Number(form.nameGens.value),
        orientation: form.orientation.value,
        hoverTip: form.hoverTip.checked,
        notesOnTree: form.notesOnTree.checked,
        siblingOrder: form.siblingOrder.value,
      });
      close();
      updateModeLabel();
      redraw(true);
      renderPanel();
      if (S.selectedId != null) focusFamily(S.selectedId);
      else S.tree.fit();
      toast("تنظیمات ذخیره شد");
    } catch (e) {
      $(".error", el).textContent = e.message;
    }
  });
}

// ---------------------------------------------------------------------------
// print

const PRINT_LEGEND = `<span><i class="sw male"></i>مرد</span><span><i class="sw female"></i>زن</span>
  <span><i class="sw rings-sw">⚭</i>ازدواج</span><span><i class="sw ribbon"></i>درگذشته</span>
  <span><i class="sw marker">۱</i>شمارهٔ یکسان: یک نفر که دو جا آمده (زیر پدر و مادرش و کنار همسرش)</span>
  <span>▼ ادامهٔ شاخه در صفحهٔ دیگر</span><span>✎۱ شمارهٔ یادداشت در فهرست همین صفحه</span>`;

let printPrep = null;

function buildPrint(opts) {
  const orientation = opts.orientation || prefs().orientation;
  const notes = opts.notes || "list";
  const siblingOrder = prefs().siblingOrder;
  if (!printPrep || printPrep.fam !== S.viewFam || printPrep.orientation !== orientation || printPrep.notesMode !== notes || printPrep.siblingOrder !== siblingOrder) {
    printPrep = { ...prepare(S.viewFam, { orientation, notes, gens: S.gens, siblingOrder }), fam: S.viewFam, notesMode: notes };
  }
  const plan = planPages(printPrep, { ...opts, to: Math.min(opts.to, printPrep.generations) });
  renderPages($("#print-root"), plan, printPrep, { title: "شجره‌نامه خاندان", legendHtml: PRINT_LEGEND });
  return plan;
}

function openPrintDialog() {
  if (!S.people.length) return toast("شجره‌نامه خالی است");
  const pr = prefs();
  const gens = maxGen();
  const anyNotes = S.people.some((p) => p.notes);
  const genOpts = (sel) => Array.from({ length: gens }, (_, i) => `<option value="${i + 1}" ${i + 1 === sel ? "selected" : ""}>نسل ${toFa(i + 1)}</option>`).join("");
  const { el, close } = modal({
    title: "چاپ شجره‌نامه",
    body: `<form id="prf">
      <div class="row">
        <label class="field"><span>از نسل</span><select class="input" name="from">${genOpts(S.genRange?.from ?? 1)}</select></label>
        <label class="field"><span>تا نسل</span><select class="input" name="to">${genOpts(S.genRange?.to ?? gens)}</select></label>
      </div>
      <div class="row">
        <label class="field"><span>کاغذ</span><select class="input" name="paper">${Object.entries(PAPERS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("")}</select></label>
        <label class="field"><span>چیدمان</span><select class="input" name="orientation">
          <option value="vertical" ${pr.orientation !== "horizontal" ? "selected" : ""}>عمودی (نسل‌ها بالا به پایین)</option>
          <option value="horizontal" ${pr.orientation === "horizontal" ? "selected" : ""}>افقی (فرزندان زیر هم)</option>
        </select></label>
      </div>
      <div class="field"><span>یادداشت‌ها${anyNotes ? "" : " (هنوز کسی یادداشت ندارد)"}</span>
        <label class="check"><input type="radio" name="notes" value="list" checked> فهرست یادداشت‌ها در گوشهٔ هر صفحه (کنار هر نام شمارهٔ یادداشت می‌آید)</label>
        <label class="check"><input type="radio" name="notes" value="card"> یادداشت هر شخص روی کارت، کنار نامش</label>
        <label class="check"><input type="radio" name="notes" value="none"> بدون یادداشت</label>
      </div>
      <div class="field"><span>تقسیم صفحه‌ها</span>
        <label class="check"><input type="radio" name="mode" value="auto" checked> خودکار: هر شاخه و زیرشاخه در یک صفحه، با اندازهٔ خوانا
          <select class="input inline" name="size"><option value="small">ریز</option><option value="medium" selected>متوسط</option><option value="large">درشت</option></select></label>
        <label class="check"><input type="radio" name="mode" value="count"> تعداد صفحه‌ها: <input class="input inline" type="number" name="pages" min="1" max="200" value="3"></label>
        <label class="check"><input type="radio" name="mode" value="one"> همه در یک صفحه</label>
      </div>
      <div class="result-box" data-summary>…</div>
      <p class="hint">کسی که هم فرزند یک خانواده است و هم همسر کسی در شاخهٔ دیگر، در چاپ دو جا می‌آید و هر دو کارتش شمارهٔ یکسان دارند.</p>
    </form>`,
    foot: `<button class="btn" data-cancel>انصراف</button><button class="btn primary" data-go>چاپ</button>`,
  });
  const form = $("#prf", el);
  const read = () => ({
    from: Math.min(Number(form.from.value), Number(form.to.value)),
    to: Math.max(Number(form.from.value), Number(form.to.value)),
    paper: form.paper.value,
    orientation: form.orientation.value,
    notes: form.notes.value,
    mode: form.mode.value,
    size: form.size.value,
    pages: Number(form.pages.value) || 1,
  });
  let timer;
  const update = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const plan = buildPrint(read());
      const minScale = Math.min(...plan.pages.map((p) => p.scale));
      $("[data-summary]", el).innerHTML = plan.pages.length
        ? `<b>${toFa(plan.pages.length)} صفحه</b> · کوچک‌ترین اندازهٔ کارت‌ها: ${toFa(Math.round(minScale * 100))}٪${minScale < 0.4 ? ` <span class="error">(ریز است؛ صفحهٔ بیشتر یا کاغذ بزرگ‌تر انتخاب کنید)</span>` : ""}`
        : "در این بازه کسی نیست.";
    }, 120);
  };
  form.addEventListener("change", update);
  form.addEventListener("input", update);
  update();
  $("[data-cancel]", el).addEventListener("click", () => {
    $("#print-root").replaceChildren();
    close();
  });
  $("[data-go]", el).addEventListener("click", () => {
    clearTimeout(timer);
    const plan = buildPrint(read());
    if (!plan.pages.length) return;
    close();
    window.print();
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
      ? hits.map((p) => `<button data-id="${p.id}">${esc(lineageName(p))} <span class="muted">${esc(lifeSpan(p))}</span></button>`).join("")
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

// The demo build answers /api/* inside the browser (js/demo.js) instead of a server.
if (DEMO) import("./demo.js").then((d) => ((S.demo = d), d.install())).then(boot);
else boot();
