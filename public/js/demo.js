// Demo mode: a stand-in for the Worker API that runs entirely in the browser, so the app can be
// shown on a static site with no database. Data lives in this browser's localStorage and starts
// from /demo-data.json; the visitor is signed in as an admin and can try everything.

// bump the suffix when demo/data.json changes, so returning visitors get the new sample
const KEY = "ft_demo_db_2";
const USER = { id: 1, username: "demo", display_name: "کاربر نمایشی", role: "admin", prefs: "{}" };
const PERSON_FIELDS = ["first_name", "last_name", "nickname", "gender", "birth_date", "death_date", "is_deceased", "birth_place", "photo_url", "notes", "father_id", "mother_id", "clan_id", "birth_order"];
const MARRIAGE_FIELDS = ["husband_id", "wife_id", "status", "marriage_date", "end_date", "notes"];

let db;
const realFetch = window.fetch.bind(window);

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(db));
  } catch {
    // private mode / storage full: the demo keeps working in memory
  }
}

async function load(reset = false) {
  if (!reset) {
    try {
      db = JSON.parse(localStorage.getItem(KEY) || "null");
    } catch {
      db = null;
    }
  }
  if (!db) {
    const seed = await (await realFetch("/demo-data.json")).json();
    db = { clans: seed.clans, people: [], marriages: [], history: [], nextId: 1, prefs: "{}" };
    for (const p of seed.people) db.people.push({ ...pick(p, PERSON_FIELDS), id: p.id, version: 1 });
    for (const m of seed.marriages) db.marriages.push({ ...pick(m, MARRIAGE_FIELDS), id: m.id, version: 1 });
    db.nextId = Math.max(0, ...db.people.map((p) => p.id), ...db.marriages.map((m) => m.id)) + 1;
    for (const p of db.people) log("person", p, "create", [], "داده‌های نمونه");
    for (const m of db.marriages) log("marriage", m, "create", [], "داده‌های نمونه");
    save();
  }
}

function pick(o, fields) {
  return Object.fromEntries(fields.map((f) => [f, o[f] ?? (f.endsWith("_id") || f === "birth_order" ? null : f === "is_deceased" ? 0 : "")]));
}

function log(entity, rec, action, changed, who = USER.display_name) {
  db.history.push({
    id: db.history.length + 1,
    entity,
    entity_id: rec.id,
    version: rec.version,
    action,
    user_name: who,
    at: new Date().toISOString().replace("T", " ").slice(0, 19),
    changed,
    data: pick(rec, entity === "person" ? PERSON_FIELDS : MARRIAGE_FIELDS),
  });
}

class Fail extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const num = (v) => (v === "" || v == null ? null : Number(v));

function cleanPerson(b, base = {}) {
  const p = { ...base };
  for (const f of PERSON_FIELDS) if (b[f] !== undefined) p[f] = b[f];
  for (const f of ["father_id", "mother_id", "clan_id", "birth_order"]) p[f] = num(p[f]);
  p.is_deceased = p.is_deceased || p.death_date ? 1 : 0;
  for (const f of PERSON_FIELDS) if (typeof p[f] === "string") p[f] = p[f].trim();
  if (!p.first_name) throw new Fail(400, "نام الزامی است");
  if (p.gender !== "male" && p.gender !== "female") throw new Fail(400, "جنسیت باید مرد یا زن باشد");
  const father = db.people.find((x) => x.id === p.father_id);
  const mother = db.people.find((x) => x.id === p.mother_id);
  if (p.father_id && father?.gender !== "male") throw new Fail(400, "پدر باید مرد باشد");
  if (p.mother_id && mother?.gender !== "female") throw new Fail(400, "مادر باید زن باشد");
  return p;
}

const person = (id) => {
  const p = db.people.find((x) => x.id === id);
  if (!p) throw new Fail(404, "شخص یافت نشد");
  return p;
};
const marriage = (id) => {
  const m = db.marriages.find((x) => x.id === id);
  if (!m) throw new Fail(404, "ازدواج یافت نشد");
  return m;
};

function audit() {
  const out = [];
  for (const p of db.people) {
    const h = db.history.filter((x) => x.entity === "person" && x.entity_id === p.id);
    if (!h.length) continue;
    const [f, l] = [h[0], h[h.length - 1]];
    out.push({ id: p.id, created_by: f.user_name, created_at: f.at, updated_by: l.user_name, updated_at: l.at, edits: h.length - 1 });
  }
  return out;
}

const DISABLED = "در نسخهٔ نمایشی در دسترس نیست";

/** [method, path regex, handler(match, body, url)] */
const routes = [
  ["GET", /^\/api\/status$/, () => ({ setupRequired: false, allowRegistration: false, user: { ...USER, prefs: db.prefs } })],
  ["POST", /^\/api\/(login|setup|register)$/, () => ({ user: { ...USER, prefs: db.prefs } })],
  ["POST", /^\/api\/logout$/, () => ({ ok: true })],
  ["PUT", /^\/api\/me\/prefs$/, (m, b) => ((db.prefs = JSON.stringify(b.prefs || {})), { ok: true })],
  ["PUT", /^\/api\/me\/password$/, () => {
    throw new Fail(400, DISABLED);
  }],
  ["GET", /^\/api\/tree$/, () => ({ people: db.people, marriages: db.marriages, clans: db.clans, access: { all: true }, audit: audit() })],

  ["POST", /^\/api\/people$/, (m, b) => {
    const p = cleanPerson(b);
    if (p.clan_id == null) p.clan_id = (db.people.find((x) => x.id === (p.father_id || p.mother_id || num(b.spouse_of))) || db.clans[0]).clan_id ?? db.clans[0].id;
    p.id = db.nextId++;
    p.version = 1;
    db.people.push(p);
    log("person", p, "create", []);
    const other = db.people.find((x) => x.id === num(b.spouse_of));
    if (other && other.gender !== p.gender) {
      const mm = { id: db.nextId++, husband_id: p.gender === "male" ? p.id : other.id, wife_id: p.gender === "male" ? other.id : p.id, status: "married", marriage_date: "", end_date: "", notes: "", version: 1 };
      db.marriages.push(mm);
      log("marriage", mm, "create", []);
    }
    return { person: p };
  }],
  ["PUT", /^\/api\/people\/(\d+)$/, (m, b) => {
    const cur = person(Number(m[1]));
    const next = cleanPerson(b, cur);
    const changed = PERSON_FIELDS.filter((f) => String(next[f] ?? "") !== String(cur[f] ?? ""));
    if (!changed.length) return { person: cur, unchanged: true };
    Object.assign(cur, next, { version: cur.version + 1 });
    log("person", cur, "update", changed);
    return { person: cur };
  }],
  ["POST", /^\/api\/people\/(\d+)\/move$/, (m, b) => {
    const p = person(Number(m[1]));
    p.clan_id = num(b.clan_id);
    p.version++;
    log("person", p, "update", ["clan_id"]);
    return { ok: true, moved: 1 };
  }],
  ["DELETE", /^\/api\/people\/(\d+)$/, (m) => {
    const id = Number(m[1]);
    const p = person(id);
    for (const c of db.people) {
      for (const k of ["father_id", "mother_id"]) {
        if (c[k] === id) {
          c[k] = null;
          c.version++;
          log("person", c, "update", [k]);
        }
      }
    }
    for (const mm of db.marriages.filter((x) => x.husband_id === id || x.wife_id === id)) log("marriage", { ...mm, version: mm.version + 1 }, "delete", []);
    db.marriages = db.marriages.filter((x) => x.husband_id !== id && x.wife_id !== id);
    log("person", { ...p, version: p.version + 1 }, "delete", []);
    db.people = db.people.filter((x) => x.id !== id);
    return { ok: true };
  }],
  ["POST", /^\/api\/people\/(\d+)\/restore$/, (m) => {
    const id = Number(m[1]);
    const last = [...db.history].reverse().find((h) => h.entity === "person" && h.entity_id === id);
    if (!last || db.people.some((x) => x.id === id)) throw new Fail(400, "قابل بازیابی نیست");
    const p = { ...last.data, id, version: last.version + 1 };
    db.people.push(p);
    log("person", p, "restore", []);
    return { ok: true, marriages: 0 };
  }],
  ["GET", /^\/api\/(people|marriages)\/(\d+)\/history$/, (m) => ({
    history: db.history.filter((h) => h.entity === (m[1] === "people" ? "person" : "marriage") && h.entity_id === Number(m[2])).reverse(),
  })],
  ["GET", /^\/api\/history$/, () => ({
    history: [...db.history].reverse().slice(0, 100).map((h) => ({ ...h, deleted: h.entity === "person" && !db.people.some((p) => p.id === h.entity_id) })),
    next: null,
  })],

  ["POST", /^\/api\/marriages$/, (m, b) => {
    const mm = { ...pick(b, MARRIAGE_FIELDS), status: b.status || "married", id: db.nextId++, version: 1 };
    mm.husband_id = num(mm.husband_id);
    mm.wife_id = num(mm.wife_id);
    if (person(mm.husband_id).gender !== "male" || person(mm.wife_id).gender !== "female") throw new Fail(400, "شوهر باید مرد و همسر باید زن باشد");
    if (db.marriages.some((x) => x.husband_id === mm.husband_id && x.wife_id === mm.wife_id)) throw new Fail(409, "این ازدواج قبلاً ثبت شده است");
    db.marriages.push(mm);
    log("marriage", mm, "create", []);
    return { id: mm.id, version: 1 };
  }],
  ["PUT", /^\/api\/marriages\/(\d+)$/, (m, b) => {
    const cur = marriage(Number(m[1]));
    const changed = MARRIAGE_FIELDS.filter((f) => b[f] !== undefined && String(b[f] ?? "") !== String(cur[f] ?? ""));
    for (const f of changed) cur[f] = f.endsWith("_id") ? num(b[f]) : b[f];
    if (changed.length) {
      cur.version++;
      log("marriage", cur, "update", changed);
    }
    return { ok: true, version: cur.version };
  }],
  ["DELETE", /^\/api\/marriages\/(\d+)$/, (m) => {
    const cur = marriage(Number(m[1]));
    log("marriage", { ...cur, version: cur.version + 1 }, "delete", []);
    db.marriages = db.marriages.filter((x) => x !== cur);
    return { ok: true };
  }],

  ["POST", /^\/api\/clans$/, (m, b) => {
    const c = { id: Math.max(0, ...db.clans.map((x) => x.id)) + 1, name: String(b.name || "").trim() || "طایفهٔ تازه", description: "" };
    db.clans.push(c);
    return { clan: c };
  }],
  ["PUT", /^\/api\/clans\/(\d+)$/, (m, b) => {
    const c = db.clans.find((x) => x.id === Number(m[1]));
    if (c) c.name = String(b.name || c.name);
    return { ok: true };
  }],
  ["DELETE", /^\/api\/clans\/(\d+)$/, (m) => {
    const id = Number(m[1]);
    if (db.people.some((p) => p.clan_id === id)) throw new Fail(400, "این طایفه هنوز عضو دارد");
    db.clans = db.clans.filter((c) => c.id !== id);
    return { ok: true };
  }],

  ["GET", /^\/api\/users$/, () => ({ users: [{ ...USER, created_at: "" }], allowRegistration: false })],
  ["GET", /^\/api\/access$/, () => ({ users: [{ ...USER, groups: [], grants: [] }], groups: [] })],
  ["GET", /^\/api\/export$/, () => ({ format: "familytree/v1", exported_at: new Date().toISOString(), people: db.people, marriages: db.marriages, clans: db.clans })],
  ["POST", /^\/api\/import$/, (m, b) => {
    if (!Array.isArray(b.people) || !Array.isArray(b.marriages)) throw new Fail(400, "فایل پشتیبان نامعتبر است");
    db = { clans: b.clans?.length ? b.clans : db.clans, people: [], marriages: [], history: [], nextId: 1, prefs: db.prefs };
    for (const p of b.people) db.people.push({ ...pick(p, PERSON_FIELDS), id: p.id, version: 1 });
    for (const x of b.marriages) db.marriages.push({ ...pick(x, MARRIAGE_FIELDS), id: x.id, version: 1 });
    db.nextId = Math.max(0, ...db.people.map((p) => p.id), ...db.marriages.map((x) => x.id)) + 1;
    return { ok: true, people: db.people.length, marriages: db.marriages.length };
  }],
];

const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

async function handle(method, url, init) {
  let b = {};
  try {
    b = init?.body ? JSON.parse(init.body) : {};
  } catch {
    // not JSON
  }
  for (const [m, re, fn] of routes) {
    const hit = url.pathname.match(re);
    if (!hit || m !== method) continue;
    try {
      const out = fn(hit, b, url);
      if (method !== "GET") save();
      return reply(200, out);
    } catch (e) {
      return reply(e.status || 500, { error: e.message });
    }
  }
  return reply(400, { error: DISABLED });
}

/** Route /api/* calls to the in-browser backend. */
export async function install() {
  await load();
  window.fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    if (url.origin === location.origin && url.pathname.startsWith("/api/")) return handle((init?.method || "GET").toUpperCase(), url, init);
    return realFetch(input, init);
  };
}

/** Start the demo over from the sample data. */
export async function reset() {
  try {
    localStorage.removeItem(KEY);
    for (const k of Object.keys(localStorage)) if (k.startsWith("ft_")) localStorage.removeItem(k);
  } catch {
    // ignore
  }
  await load(true);
}

/** The demo's data as a backup file (the export link can't reach a server here). */
export const exportData = () => routes.find(([, re]) => re.test("/api/export"))[2]();
