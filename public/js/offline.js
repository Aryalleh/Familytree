// Offline support: a local snapshot of the tree plus a queue of edits made while offline.
// Edits are replayed through the normal API once back online, or exported to a JSON
// "changes file" that can be uploaded to the main server later.

export class OfflineError extends Error {}

/** People and marriages created offline get ids from here up, mapped to real ids on replay. */
const TEMP_BASE = 1_000_000_000;
export const isTemp = (id) => typeof id === "number" && id >= TEMP_BASE;
export const CHANGES_FORMAT = "familytree-changes/v1";

function read(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export const local = {
  lastUser: () => read("ft_last_user", null),
  setLastUser: (u) => write("ft_last_user", u),
  snapshot: (uid) => read(`ft_snapshot_${uid}`, null),
  setSnapshot: (uid, data) => write(`ft_snapshot_${uid}`, data),
  ops: (uid) => read(`ft_ops_${uid}`, []),
  setOps: (uid, ops) => write(`ft_ops_${uid}`, ops),
  clear(uid) {
    write("ft_last_user", null);
    write(`ft_snapshot_${uid}`, null);
    write(`ft_ops_${uid}`, null);
  },
};

const PERSON_DEFAULTS = {
  first_name: "",
  last_name: "",
  nickname: "",
  gender: "male",
  birth_date: "",
  death_date: "",
  is_deceased: 0,
  birth_place: "",
  photo_url: "",
  notes: "",
  father_id: null,
  mother_id: null,
  clan_id: null,
};
const MARRIAGE_DEFAULTS = { status: "married", marriage_date: "", end_date: "", notes: "" };

const idOrNull = (v) => (v === "" || v == null ? null : Number(v));

function cleanPerson(d) {
  const out = {};
  for (const k of Object.keys(PERSON_DEFAULTS)) if (d[k] !== undefined) out[k] = d[k];
  for (const k of ["father_id", "mother_id", "clan_id"]) if (k in out) out[k] = idOrNull(out[k]);
  if ("is_deceased" in out || "death_date" in out) out.is_deceased = out.is_deceased || out.death_date ? 1 : 0;
  for (const k of Object.keys(out)) if (typeof out[k] === "string") out[k] = out[k].trim();
  return out;
}

function cleanMarriage(d) {
  const out = {};
  for (const k of ["husband_id", "wife_id", ...Object.keys(MARRIAGE_DEFAULTS)]) if (d[k] !== undefined) out[k] = d[k];
  for (const k of ["husband_id", "wife_id"]) if (k in out) out[k] = idOrNull(out[k]);
  return out;
}

/**
 * Apply queued edits on top of server data. Pure: returns new arrays.
 * Throws when an edit is invalid (only used to validate a new edit before queueing it).
 */
export function applyOps(people, marriages, ops, { strict = false } = {}) {
  const P = new Map(people.map((p) => [p.id, { ...p }]));
  let M = marriages.map((m) => ({ ...m }));
  const fail = (msg) => {
    if (strict) throw new Error(msg);
  };
  const marry = (id, data) => {
    const m = { ...MARRIAGE_DEFAULTS, ...data, id };
    const h = P.get(m.husband_id);
    const w = P.get(m.wife_id);
    if (!h || !w) return fail("شخص انتخاب‌شده وجود ندارد");
    if (h.gender !== "male" || w.gender !== "female") return fail("شوهر باید مرد و همسر باید زن باشد");
    if (M.some((x) => x.husband_id === m.husband_id && x.wife_id === m.wife_id && x.id !== id)) return fail("این ازدواج قبلاً ثبت شده است");
    M = M.filter((x) => x.id !== id).concat(m);
  };
  for (const op of ops) {
    switch (op.type) {
      case "createPerson": {
        const d = { ...PERSON_DEFAULTS, ...cleanPerson(op.data), id: op.id };
        if (d.clan_id == null) d.clan_id = (P.get(d.father_id) || P.get(d.mother_id) || P.get(Number(op.data.spouse_of)))?.clan_id ?? null;
        if (!d.first_name) {
          fail("نام الزامی است");
          break;
        }
        P.set(op.id, d);
        if (op.data.spouse_of && P.has(Number(op.data.spouse_of))) {
          const other = Number(op.data.spouse_of);
          const [h, w] = d.gender === "male" ? [op.id, other] : [other, op.id];
          marry(op.spouseMarriageId, { husband_id: h, wife_id: w });
        }
        break;
      }
      case "updatePerson": {
        const cur = P.get(op.id);
        if (!cur) {
          fail("شخص یافت نشد");
          break;
        }
        const next = { ...cur, ...cleanPerson(op.data) };
        if (!next.first_name) {
          fail("نام الزامی است");
          break;
        }
        P.set(op.id, next);
        break;
      }
      case "deletePerson":
        P.delete(op.id);
        for (const p of P.values()) {
          if (p.father_id === op.id) p.father_id = null;
          if (p.mother_id === op.id) p.mother_id = null;
        }
        M = M.filter((m) => m.husband_id !== op.id && m.wife_id !== op.id);
        break;
      case "createMarriage":
        marry(op.id, cleanMarriage(op.data));
        break;
      case "updateMarriage": {
        const cur = M.find((m) => m.id === op.id);
        if (!cur) {
          fail("ازدواج یافت نشد");
          break;
        }
        marry(op.id, { ...cur, ...cleanMarriage(op.data) });
        break;
      }
      case "deleteMarriage":
        M = M.filter((m) => m.id !== op.id);
        break;
    }
  }
  return { people: [...P.values()], marriages: M };
}

const ROUTES = [
  ["POST", /^\/api\/people$/, "createPerson"],
  ["PUT", /^\/api\/people\/(\d+)$/, "updatePerson"],
  ["DELETE", /^\/api\/people\/(\d+)$/, "deletePerson"],
  ["POST", /^\/api\/marriages$/, "createMarriage"],
  ["PUT", /^\/api\/marriages\/(\d+)$/, "updateMarriage"],
  ["DELETE", /^\/api\/marriages\/(\d+)$/, "deleteMarriage"],
];

/** Is this API call a family-tree edit that can be queued offline? */
export function editType(method, path) {
  const [p, query = ""] = path.split("?");
  for (const [m, re, type] of ROUTES) {
    const hit = method === m && p.match(re);
    if (hit) {
      const base = new URLSearchParams(query).get("base_version");
      return { type, id: hit[1] ? Number(hit[1]) : null, base_version: base ? Number(base) : null };
    }
  }
  return null;
}

function nextTempId(ops) {
  let max = TEMP_BASE;
  for (const op of ops) max = Math.max(max, op.id || 0, op.spouseMarriageId || 0);
  return max + 1;
}

/**
 * Turn an API edit into a queued op, validate it against the current local data, and return
 * the op plus a response shaped like the server's.
 */
export function queueEdit(ops, base, method, path, data = {}) {
  const e = editType(method, path);
  const op = { type: e.type, at: new Date().toISOString() };
  // the version this edit started from (for conflict detection on replay)
  const startedFrom = data?.base_version ?? e.base_version;
  if (startedFrom) op.base_version = Number(startedFrom);
  if (e.type === "createPerson" || e.type === "createMarriage") {
    op.id = nextTempId(ops);
    if (data.spouse_of) op.spouseMarriageId = op.id + 1;
  } else op.id = e.id;
  if (data && Object.keys(data).length) {
    const { base_version: _, ...rest } = data;
    if (Object.keys(rest).length) op.data = rest;
  }
  const next = [...ops, op];
  const cur = applyOps(base.people, base.marriages, ops);
  const result = applyOps(cur.people, cur.marriages, [op], { strict: true });
  let response = { ok: true };
  if (e.type === "createPerson" || e.type === "updatePerson") response = { person: result.people.find((p) => p.id === op.id) };
  if (e.type === "createMarriage") response = { id: op.id };
  return { ops: next, response };
}

const entityOf = (type) => (type.endsWith("Person") ? "person" : "marriage");

/**
 * Send queued edits to the server in order, mapping temporary ids to the real ones and
 * carrying each record's version forward so the server can merge or detect conflicts.
 * An edit that conflicts (or fails) holds back later edits of the same record.
 * @returns {Promise<{done:number, pending:{op:any, status:'conflict'|'failed'|'waiting', conflict?:any, error?:string, gone?:boolean}[], remaining:any[]}>}
 */
export async function replay(ops, api) {
  const map = new Map();
  const versions = new Map(); // "person:12" → version after our last successful edit
  const blocked = new Set();
  const pending = [];
  let done = 0;
  const real = (id) => {
    const v = map.has(id) ? map.get(id) : id;
    if (isTemp(v)) throw Object.assign(new Error("به شخص یا ازدواجی اشاره دارد که هنوز ساخته نشده"), { waiting: true });
    return v;
  };
  for (const op of ops) {
    const key = `${entityOf(op.type)}:${map.get(op.id) ?? op.id}`;
    if (blocked.has(key)) {
      pending.push({ op, status: "waiting", error: "پس از حل مورد قبلیِ همین شخص یا ازدواج ارسال می‌شود" });
      continue;
    }
    try {
      const d = op.data ? { ...op.data } : {};
      for (const k of ["father_id", "mother_id", "husband_id", "wife_id"]) if (d[k] != null && d[k] !== "") d[k] = real(Number(d[k]));
      const base = versions.get(key) ?? op.base_version ?? null;
      const q = base ? `?base_version=${base}` : "";
      switch (op.type) {
        case "createPerson": {
          const spouse = d.spouse_of ? real(Number(d.spouse_of)) : null;
          delete d.spouse_of;
          const r = await api("POST", "/api/people", d);
          map.set(op.id, r.person.id);
          versions.set(`person:${r.person.id}`, r.person.version);
          if (spouse) {
            const [h, w] = r.person.gender === "male" ? [r.person.id, spouse] : [spouse, r.person.id];
            const m = await api("POST", "/api/marriages", { husband_id: h, wife_id: w }).catch(() => null);
            if (m) {
              map.set(op.spouseMarriageId, m.id);
              versions.set(`marriage:${m.id}`, m.version);
            }
          }
          break;
        }
        case "updatePerson": {
          const id = real(op.id);
          const r = await api("PUT", `/api/people/${id}`, base ? { ...d, base_version: base } : d);
          versions.set(`person:${id}`, r.person.version);
          break;
        }
        case "deletePerson":
          await api("DELETE", `/api/people/${real(op.id)}${q}`);
          break;
        case "createMarriage": {
          const r = await api("POST", "/api/marriages", d);
          map.set(op.id, r.id);
          versions.set(`marriage:${r.id}`, r.version);
          break;
        }
        case "updateMarriage": {
          const id = real(op.id);
          const r = await api("PUT", `/api/marriages/${id}`, base ? { ...d, base_version: base } : d);
          versions.set(`marriage:${id}`, r.version);
          break;
        }
        case "deleteMarriage":
          await api("DELETE", `/api/marriages/${real(op.id)}${q}`);
          break;
        default:
          throw new Error("نوع تغییر ناشناخته است");
      }
      done++;
    } catch (e) {
      if (e instanceof OfflineError) throw e;
      blocked.add(key);
      if (e.waiting) pending.push({ op, status: "waiting", error: e.message });
      else if (e.status === 409 && e.data?.conflict) pending.push({ op, status: "conflict", conflict: e.data.conflict, error: e.message });
      else pending.push({ op, status: "failed", error: e.message, gone: !!e.data?.gone });
    }
  }
  // keep what didn't go through, with ids created meanwhile rewritten to the real ones
  const fix = (v) => (map.has(Number(v)) ? map.get(Number(v)) : v);
  for (const p of pending) {
    const o = { ...p.op, id: fix(p.op.id), data: p.op.data ? { ...p.op.data } : undefined };
    if (o.data) for (const k of ["father_id", "mother_id", "husband_id", "wife_id", "spouse_of"]) if (o.data[k] != null) o.data[k] = fix(o.data[k]);
    const v = versions.get(`${entityOf(o.type)}:${o.id}`);
    if (v && p.status === "waiting") o.base_version = v;
    p.op = o;
  }
  return { done, pending, remaining: pending.map((p) => p.op) };
}

export function describeOp(op, nameOf) {
  const who = (id) => nameOf(id) || "؟";
  switch (op.type) {
    case "createPerson":
      return `افزودن ${op.data?.first_name || ""} ${op.data?.last_name || ""}`.trim();
    case "updatePerson":
      return `ویرایش ${who(op.id)}`;
    case "deletePerson":
      return `حذف ${who(op.id)}`;
    case "createMarriage":
      return `ثبت ازدواج ${who(Number(op.data?.husband_id))} و ${who(Number(op.data?.wife_id))}`;
    case "updateMarriage":
      return "ویرایش ازدواج";
    case "deleteMarriage":
      return "حذف ازدواج";
    default:
      return op.type;
  }
}
