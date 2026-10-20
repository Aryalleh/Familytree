import {
  clearCookie,
  createSession,
  currentUser,
  destroySession,
  hashPassword,
  hasRole,
  readSessionToken,
  sessionCookie,
  verifyPassword,
} from "./auth";
import { HttpError, type Env, type Marriage, type Person, type Role, type User } from "./types";
// shared with the browser, so both sides agree on generations and branches
import { canAddInClan, permissions } from "../public/js/generations.js";

type Ctx = { env: Env; request: Request; url: URL; user: User | null; params: string[] };
type Handler = (ctx: Ctx) => Promise<Response>;

const ROLES: Role[] = ["admin", "editor", "viewer"];

// ---------------------------------------------------------------------------
// helpers

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const data = await request.json();
    if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HttpError(400, "بدنهٔ درخواست نامعتبر است");
}

function str(v: unknown, max = 500): string {
  if (v === undefined || v === null) return "";
  return String(v).trim().slice(0, max);
}

function optId(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "شناسه نامعتبر است");
  return n;
}

function require(user: User | null, role: Role): User {
  if (!user) throw new HttpError(401, "ابتدا وارد شوید");
  if (!hasRole(user, role)) throw new HttpError(403, "دسترسی کافی ندارید");
  return user;
}

function validateCredentials(username: string, password: string) {
  if (!/^[\p{L}\p{N}_.-]{3,32}$/u.test(username)) {
    throw new HttpError(400, "نام کاربری باید ۳ تا ۳۲ نویسه (حرف، عدد، _ . -) باشد");
  }
  if (password.length < 8) throw new HttpError(400, "رمز عبور باید دست‌کم ۸ نویسه باشد");
}

async function setting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

async function registrationOpen(env: Env): Promise<boolean> {
  return (await setting(env, "allow_registration")) === "1";
}

async function loginResponse(env: Env, url: URL, user: User, status = 200): Promise<Response> {
  const token = await createSession(env, user.id);
  return json({ user }, status, { "Set-Cookie": sessionCookie(token, url) });
}

// ---------------------------------------------------------------------------
// auth & account

const status: Handler = async ({ env, user }) => {
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
  return json({
    setupRequired: (count?.n ?? 0) === 0,
    allowRegistration: await registrationOpen(env),
    user,
  });
};

// The very first account becomes the admin. The INSERT ... WHERE NOT EXISTS makes
// this atomic, so two simultaneous setup requests can't both create an admin.
const setup: Handler = async ({ env, request, url }) => {
  const b = await body(request);
  const username = str(b.username, 32);
  const password = String(b.password ?? "");
  const displayName = str(b.display_name, 100) || username;
  validateCredentials(username, password);
  const hash = await hashPassword(password);
  const res = await env.DB.prepare(
    `INSERT INTO users (username, display_name, password_hash, role)
     SELECT ?, ?, ?, 'admin' WHERE NOT EXISTS (SELECT 1 FROM users)`,
  )
    .bind(username, displayName, hash)
    .run();
  if (!res.meta.changes) throw new HttpError(409, "حساب مدیر قبلاً ساخته شده است");
  const user: User = { id: Number(res.meta.last_row_id), username, display_name: displayName, role: "admin" };
  return loginResponse(env, url, user, 201);
};

const register: Handler = async ({ env, request, url }) => {
  if (!(await registrationOpen(env))) throw new HttpError(403, "ثبت‌نام عمومی بسته است؛ از مدیر بخواهید برایتان حساب بسازد");
  const b = await body(request);
  const username = str(b.username, 32);
  const password = String(b.password ?? "");
  const displayName = str(b.display_name, 100) || username;
  validateCredentials(username, password);
  const res = await env.DB.prepare(
    // self-registered accounts have no grants, so they see nothing until an admin gives them access
    `INSERT INTO users (username, display_name, password_hash, role)
     SELECT ?, ?, ?, 'viewer' WHERE EXISTS (SELECT 1 FROM users)
     ON CONFLICT(username) DO NOTHING`,
  )
    .bind(username, displayName, await hashPassword(password))
    .run();
  if (!res.meta.changes) throw new HttpError(409, "این نام کاربری قبلاً گرفته شده است");
  const user: User = { id: Number(res.meta.last_row_id), username, display_name: displayName, role: "viewer" };
  return loginResponse(env, url, user, 201);
};

const login: Handler = async ({ env, request, url }) => {
  const b = await body(request);
  const username = str(b.username, 32);
  const password = String(b.password ?? "");
  const row = await env.DB.prepare("SELECT id, username, display_name, role, prefs, password_hash FROM users WHERE username = ?")
    .bind(username)
    .first<User & { password_hash: string }>();
  if (!row || !(await verifyPassword(password, row.password_hash))) {
    throw new HttpError(401, "نام کاربری یا رمز عبور اشتباه است");
  }
  const { password_hash: _, ...user } = row;
  return loginResponse(env, url, user);
};

const logout: Handler = async ({ env, request, url }) => {
  const token = readSessionToken(request);
  if (token) await destroySession(env, token);
  return json({ ok: true }, 200, { "Set-Cookie": clearCookie(url) });
};

const PREF_LIMIT = 4000;

const updatePrefs: Handler = async ({ env, request, user }) => {
  const me = require(user, "viewer");
  const b = await body(request);
  const prefs = JSON.stringify(b.prefs ?? {});
  if (prefs.length > PREF_LIMIT || typeof b.prefs !== "object" || Array.isArray(b.prefs)) throw new HttpError(400, "تنظیمات نامعتبر است");
  await env.DB.prepare("UPDATE users SET prefs = ? WHERE id = ?").bind(prefs, me.id).run();
  return json({ ok: true });
};

const changePassword: Handler = async ({ env, request, user }) => {
  const me = require(user, "viewer");
  const b = await body(request);
  const row = await env.DB.prepare("SELECT password_hash FROM users WHERE id = ?").bind(me.id).first<{ password_hash: string }>();
  if (!row || !(await verifyPassword(String(b.current_password ?? ""), row.password_hash))) {
    throw new HttpError(400, "رمز عبور فعلی اشتباه است");
  }
  const next = String(b.new_password ?? "");
  validateCredentials(me.username, next);
  await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(await hashPassword(next), me.id).run();
  return json({ ok: true });
};

// ---------------------------------------------------------------------------
// users (admin)

const listUsers: Handler = async ({ env, user }) => {
  require(user, "admin");
  const { results } = await env.DB.prepare("SELECT id, username, display_name, role, created_at FROM users ORDER BY id").all();
  return json({ users: results, allowRegistration: await registrationOpen(env) });
};

function parseRole(v: unknown): Role {
  if (!ROLES.includes(v as Role)) throw new HttpError(400, "نقش نامعتبر است");
  return v as Role;
}

const createUser: Handler = async ({ env, request, user }) => {
  require(user, "admin");
  const b = await body(request);
  const username = str(b.username, 32);
  const password = String(b.password ?? "");
  validateCredentials(username, password);
  const role = parseRole(b.role ?? "viewer");
  const res = await env.DB.prepare(
    "INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, ?, ?) ON CONFLICT(username) DO NOTHING",
  )
    .bind(username, str(b.display_name, 100) || username, await hashPassword(password), role)
    .run();
  if (!res.meta.changes) throw new HttpError(409, "این نام کاربری قبلاً گرفته شده است");
  return json({ id: res.meta.last_row_id }, 201);
};

async function adminCount(env: Env): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").first<{ n: number }>();
  return r?.n ?? 0;
}

const updateUser: Handler = async ({ env, request, user, params }) => {
  require(user, "admin");
  const id = optId(params[0])!;
  const b = await body(request);
  const target = await env.DB.prepare("SELECT id, role FROM users WHERE id = ?").bind(id).first<{ id: number; role: Role }>();
  if (!target) throw new HttpError(404, "کاربر یافت نشد");
  const stmts: D1PreparedStatement[] = [];
  if (b.role !== undefined) {
    const role = parseRole(b.role);
    if (target.role === "admin" && role !== "admin" && (await adminCount(env)) <= 1) {
      throw new HttpError(400, "دست‌کم یک مدیر باید باقی بماند");
    }
    stmts.push(env.DB.prepare("UPDATE users SET role = ? WHERE id = ?").bind(role, id));
  }
  if (b.display_name !== undefined) {
    stmts.push(env.DB.prepare("UPDATE users SET display_name = ? WHERE id = ?").bind(str(b.display_name, 100), id));
  }
  if (b.password) {
    const pw = String(b.password);
    if (pw.length < 8) throw new HttpError(400, "رمز عبور باید دست‌کم ۸ نویسه باشد");
    stmts.push(env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(await hashPassword(pw), id));
    stmts.push(env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true });
};

const deleteUser: Handler = async ({ env, user, params }) => {
  const me = require(user, "admin");
  const id = optId(params[0])!;
  if (id === me.id) throw new HttpError(400, "نمی‌توانید حساب خودتان را حذف کنید");
  await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
  return json({ ok: true });
};

const updateSettings: Handler = async ({ env, request, user }) => {
  require(user, "admin");
  const b = await body(request);
  if (b.allow_registration !== undefined) {
    await env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES ('allow_registration', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
      .bind(b.allow_registration ? "1" : "0")
      .run();
  }
  return json({ ok: true });
};

// ---------------------------------------------------------------------------
// family tree

const PERSON_COLS =
  "id, first_name, last_name, nickname, gender, birth_date, death_date, is_deceased, birth_place, photo_url, notes, father_id, mother_id, clan_id";

function isAncestor(people: Map<number, Person>, ancestorId: number, personId: number): boolean {
  const stack = [personId];
  const seen = new Set<number>();
  while (stack.length) {
    const id = stack.pop()!;
    if (id === ancestorId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const p = people.get(id);
    if (p?.father_id) stack.push(p.father_id);
    if (p?.mother_id) stack.push(p.mother_id);
  }
  return false;
}

type PersonInput = Omit<Person, "id">;

function parsePerson(b: Record<string, unknown>, base?: Person): PersonInput {
  const pick = <K extends keyof PersonInput>(k: K): unknown => (b[k] !== undefined ? b[k] : base?.[k]);
  const gender = pick("gender");
  if (gender !== "male" && gender !== "female") throw new HttpError(400, "جنسیت باید مرد یا زن باشد");
  const first = str(pick("first_name"), 100);
  if (!first) throw new HttpError(400, "نام الزامی است");
  const photo = str(pick("photo_url"), 1000);
  if (photo && !/^https?:\/\//i.test(photo)) throw new HttpError(400, "نشانی عکس باید با http یا https شروع شود");
  const deathDate = str(pick("death_date"), 40);
  return {
    first_name: first,
    last_name: str(pick("last_name"), 100),
    nickname: str(pick("nickname"), 100),
    gender,
    birth_date: str(pick("birth_date"), 40),
    death_date: deathDate,
    is_deceased: pick("is_deceased") || deathDate ? 1 : 0,
    birth_place: str(pick("birth_place"), 200),
    photo_url: photo,
    notes: str(pick("notes"), 5000),
    father_id: optId(pick("father_id")),
    mother_id: optId(pick("mother_id")),
    clan_id: optId(pick("clan_id")),
  };
}

function checkParents(people: Map<number, Person>, p: PersonInput, selfId?: number) {
  for (const [key, gender, label] of [
    ["father_id", "male", "پدر"],
    ["mother_id", "female", "مادر"],
  ] as const) {
    const pid = p[key];
    if (!pid) continue;
    const parent = people.get(pid);
    if (!parent) throw new HttpError(400, `${label} انتخاب‌شده وجود ندارد`);
    if (parent.gender !== gender) throw new HttpError(400, `${label} باید ${gender === "male" ? "مرد" : "زن"} باشد`);
    if (selfId && isAncestor(people, selfId, pid)) {
      throw new HttpError(400, `${label} نمی‌تواند خود شخص یا یکی از نوادگانش باشد`);
    }
  }
}

type Perms = ReturnType<typeof permissions>;
interface Grant {
  id?: number;
  user_id?: number | null;
  group_id?: number | null;
  clan_id: number | null;
  root_id: number | null;
  level: "view" | "edit" | "delete";
  max_gen: number | null;
}
interface Clan {
  id: number;
  name: string;
  description: string;
}

/** A user's own grants plus those of every group they belong to. */
async function grantsOf(env: Env, user: User): Promise<Grant[]> {
  const { results } = await env.DB.prepare(
    `SELECT clan_id, root_id, level, max_gen FROM grants WHERE user_id = ?1
     UNION ALL
     SELECT g.clan_id, g.root_id, g.level, g.max_gen FROM grants g JOIN user_groups ug ON ug.group_id = g.group_id WHERE ug.user_id = ?1`,
  )
    .bind(user.id)
    .all<Grant>();
  return results;
}

/** Everything plus what this user may see, edit and delete (see public/js/generations.js). */
async function loadScoped(env: Env, user: User) {
  const [pr, mr, cr] = await env.DB.batch([
    env.DB.prepare(`SELECT ${PERSON_COLS} FROM people ORDER BY id`),
    env.DB.prepare("SELECT id, husband_id, wife_id, status, marriage_date, end_date, notes FROM marriages ORDER BY id"),
    env.DB.prepare("SELECT id, name, description FROM clans ORDER BY id"),
  ]);
  const people = pr.results as unknown as Person[];
  const marriages = mr.results as unknown as Marriage[];
  const clans = cr.results as unknown as Clan[];
  const perms: Perms = permissions(user, people, marriages, user.role === "admin" ? [] : await grantsOf(env, user));
  return { people: new Map(people.map((p) => [p.id, p])), list: people, marriages, clans, perms };
}

const canSee = (pm: Perms, id: number | null) => id != null && (pm.all || pm.visible!.has(id));
const canChange = (pm: Perms, id: number | null) => id != null && (pm.all || pm.editable!.has(id));
const canDelete = (pm: Perms, id: number | null) => id != null && (pm.all || pm.deletable!.has(id));
const NOT_YOURS = "این شخص در محدودهٔ ویرایش شما نیست";

/** Parents/spouses named in an edit must be people the user can see. */
function requireVisible(pm: Perms, ids: (number | null)[]) {
  for (const id of ids) if (id != null && !canSee(pm, id)) throw new HttpError(400, "شخص انتخاب‌شده وجود ندارد");
}

function requireClan(clans: Clan[], id: number) {
  if (!clans.some((c) => c.id === id)) throw new HttpError(400, "طایفهٔ انتخاب‌شده وجود ندارد");
}

const getTree: Handler = async ({ env, user }) => {
  const me = require(user, "viewer");
  const { list, marriages, clans, perms } = await loadScoped(env, me);
  const people = list
    .filter((p) => canSee(perms, p.id))
    .map((p) => ({
      ...p,
      // don't reveal links to people this user may not see
      father_id: canSee(perms, p.father_id) ? p.father_id : null,
      mother_id: canSee(perms, p.mother_id) ? p.mother_id : null,
    }));
  const shownClans = new Set(people.map((p) => p.clan_id));
  return json({
    people,
    marriages: marriages.filter((m) => canSee(perms, m.husband_id) && canSee(perms, m.wife_id)),
    clans: perms.all ? clans : clans.filter((c) => shownClans.has(c.id) || perms.addClans!.has(c.id) || perms.addClans!.has(null)),
    access: perms.all
      ? { all: true }
      : {
          all: false,
          everything: perms.everything,
          editable: [...perms.editable!],
          deletable: [...perms.deletable!],
          addClans: [...perms.addClans!],
        },
  });
};

const createPerson: Handler = async ({ env, request, user }) => {
  const me = require(user, "viewer");
  const b = await body(request);
  const p = parsePerson(b);
  const { people, clans, perms } = await loadScoped(env, me);
  const spouseOfId = optId(b.spouse_of);
  requireVisible(perms, [p.father_id, p.mother_id, spouseOfId]);
  // default clan: the father's, else the mother's, else the spouse's
  const linked = [p.father_id, p.mother_id, spouseOfId].map((id) => (id ? people.get(id) : undefined)).find(Boolean);
  if (p.clan_id == null) p.clan_id = linked?.clan_id ?? clans[0]?.id ?? 1;
  requireClan(clans, p.clan_id);
  // a new person must hang off someone the user may edit, unless they may add anywhere in that clan
  const attached = canChange(perms, p.father_id) || canChange(perms, p.mother_id) || canChange(perms, spouseOfId);
  if (!attached && !canAddInClan(perms, p.clan_id)) {
    throw new HttpError(403, "فقط می‌توانید فرزند یا همسرِ افرادی را که اجازهٔ ویرایششان را دارید اضافه کنید");
  }
  checkParents(people, p);
  const row = await env.DB.prepare(
    `INSERT INTO people (first_name, last_name, nickname, gender, birth_date, death_date, is_deceased, birth_place, photo_url, notes, father_id, mother_id, clan_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${PERSON_COLS}`,
  )
    .bind(p.first_name, p.last_name, p.nickname, p.gender, p.birth_date, p.death_date, p.is_deceased, p.birth_place, p.photo_url, p.notes, p.father_id, p.mother_id, p.clan_id)
    .first<Person>();

  // Optional: link the new person as spouse of an existing person in the same request.
  if (spouseOfId && row) {
    const other = people.get(spouseOfId);
    if (other && other.gender !== row.gender) {
      const [h, w] = row.gender === "male" ? [row.id, other.id] : [other.id, row.id];
      await env.DB.prepare("INSERT INTO marriages (husband_id, wife_id) VALUES (?, ?) ON CONFLICT DO NOTHING").bind(h, w).run();
    }
  }
  return json({ person: row }, 201);
};

const updatePerson: Handler = async ({ env, request, user, params }) => {
  const me = require(user, "viewer");
  const id = optId(params[0])!;
  const { people, clans, perms } = await loadScoped(env, me);
  const existing = people.get(id);
  if (!existing || !canSee(perms, id)) throw new HttpError(404, "شخص یافت نشد");
  if (!canChange(perms, id)) throw new HttpError(403, NOT_YOURS);
  const p = parsePerson(await body(request), existing);
  // hidden parents stay as they are; new ones must be visible
  if (p.father_id !== existing.father_id) requireVisible(perms, [p.father_id]);
  if (p.mother_id !== existing.mother_id) requireVisible(perms, [p.mother_id]);
  if (p.clan_id !== existing.clan_id) {
    requireClan(clans, p.clan_id!);
    if (!canAddInClan(perms, p.clan_id)) throw new HttpError(403, "اجازهٔ افزودن به آن طایفه را ندارید");
  }
  checkParents(people, p, id);
  if (p.gender !== existing.gender) {
    const key = existing.gender === "male" ? "father_id" : "mother_id";
    if ([...people.values()].some((c) => c[key] === id)) {
      throw new HttpError(400, "این شخص والد کسی است؛ ابتدا ارتباط فرزندان را اصلاح کنید");
    }
    const m = await env.DB.prepare("SELECT 1 FROM marriages WHERE husband_id = ? OR wife_id = ? LIMIT 1").bind(id, id).first();
    if (m) throw new HttpError(400, "این شخص ازدواج ثبت‌شده دارد؛ ابتدا ازدواج را حذف کنید");
  }
  const row = await env.DB.prepare(
    `UPDATE people SET first_name = ?, last_name = ?, nickname = ?, gender = ?, birth_date = ?, death_date = ?, is_deceased = ?,
       birth_place = ?, photo_url = ?, notes = ?, father_id = ?, mother_id = ?, clan_id = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? RETURNING ${PERSON_COLS}`,
  )
    .bind(p.first_name, p.last_name, p.nickname, p.gender, p.birth_date, p.death_date, p.is_deceased, p.birth_place, p.photo_url, p.notes, p.father_id, p.mother_id, p.clan_id, id)
    .first<Person>();
  return json({ person: row });
};

/** Move a person — optionally with their ancestors or descendants — to another clan. */
const movePerson: Handler = async ({ env, request, user, params }) => {
  const me = require(user, "viewer");
  const id = optId(params[0])!;
  const b = await body(request);
  const clanId = optId(b.clan_id);
  const { people, list, clans, perms } = await loadScoped(env, me);
  if (!people.has(id) || !canSee(perms, id)) throw new HttpError(404, "شخص یافت نشد");
  if (!clanId) throw new HttpError(400, "طایفه را انتخاب کنید");
  requireClan(clans, clanId);
  if (!canAddInClan(perms, clanId)) throw new HttpError(403, "اجازهٔ افزودن به آن طایفه را ندارید");
  const ids = new Set([id]);
  const walk = (next: (p: Person) => number[]) => {
    const stack = [id];
    while (stack.length) {
      for (const n of next(people.get(stack.pop()!)!)) if (people.has(n) && !ids.has(n)) (ids.add(n), stack.push(n));
    }
  };
  if (b.with === "ancestors") walk((p) => [p.father_id, p.mother_id].filter((x): x is number => !!x));
  // children take the father's clan, so descendants are followed through the father's line
  if (b.with === "descendants") walk((p) => list.filter((c) => c.father_id === p.id || (c.mother_id === p.id && !c.father_id)).map((c) => c.id));
  // only people the user may edit, and only people in the person's current clan
  const from = people.get(id)!.clan_id;
  const move = [...ids].filter((x) => canChange(perms, x) && people.get(x)!.clan_id === from);
  await env.DB.batch(move.map((x) => env.DB.prepare("UPDATE people SET clan_id = ? WHERE id = ?").bind(clanId, x)));
  return json({ ok: true, moved: move.length });
};

const deletePerson: Handler = async ({ env, user, params }) => {
  const me = require(user, "viewer");
  const id = optId(params[0])!;
  const { perms } = await loadScoped(env, me);
  if (!canSee(perms, id)) throw new HttpError(404, "شخص یافت نشد");
  if (!canDelete(perms, id)) throw new HttpError(403, "اجازهٔ حذف این شخص را ندارید");
  // deleting a branch root would silently change what a grant covers
  const used = await env.DB.prepare(
    `SELECT COALESCE(u.display_name, u.username, ag.name) AS who FROM grants g
     LEFT JOIN users u ON u.id = g.user_id LEFT JOIN access_groups ag ON ag.id = g.group_id
     WHERE g.root_id = ? LIMIT 1`,
  )
    .bind(id)
    .first<{ who: string }>();
  if (used) throw new HttpError(400, `این شخص مبنای یک دسترسی («${used.who}») است؛ ابتدا آن دسترسی را تغییر دهید`);
  await env.DB.batch([
    env.DB.prepare("UPDATE people SET father_id = NULL WHERE father_id = ?").bind(id),
    env.DB.prepare("UPDATE people SET mother_id = NULL WHERE mother_id = ?").bind(id),
    env.DB.prepare("DELETE FROM marriages WHERE husband_id = ? OR wife_id = ?").bind(id, id),
    env.DB.prepare("DELETE FROM people WHERE id = ?").bind(id),
  ]);
  return json({ ok: true });
};

const MARRIAGE_STATUSES = ["married", "divorced", "widowed"];

function parseMarriage(b: Record<string, unknown>, base?: Marriage): Omit<Marriage, "id"> {
  const pick = (k: keyof Marriage): unknown => (b[k] !== undefined ? b[k] : base?.[k]);
  const status = String(pick("status") ?? "married");
  if (!MARRIAGE_STATUSES.includes(status)) throw new HttpError(400, "وضعیت ازدواج نامعتبر است");
  const husband = optId(pick("husband_id"));
  const wife = optId(pick("wife_id"));
  if (!husband || !wife) throw new HttpError(400, "شوهر و همسر هر دو الزامی‌اند");
  return {
    husband_id: husband,
    wife_id: wife,
    status: status as Marriage["status"],
    marriage_date: str(pick("marriage_date"), 40),
    end_date: str(pick("end_date"), 40),
    notes: str(pick("notes"), 2000),
  };
}

async function checkSpouses(env: Env, user: User, m: Omit<Marriage, "id">, existing?: Marriage) {
  const { people, perms } = await loadScoped(env, user);
  requireVisible(perms, [m.husband_id, m.wife_id]);
  if (!canChange(perms, m.husband_id) && !canChange(perms, m.wife_id)) throw new HttpError(403, NOT_YOURS);
  if (existing && !canChange(perms, existing.husband_id) && !canChange(perms, existing.wife_id)) throw new HttpError(403, NOT_YOURS);
  const h = people.get(m.husband_id);
  const w = people.get(m.wife_id);
  if (!h || !w) throw new HttpError(400, "شخص انتخاب‌شده وجود ندارد");
  if (h.gender !== "male") throw new HttpError(400, "شوهر باید مرد باشد");
  if (w.gender !== "female") throw new HttpError(400, "همسر (زن) باید زن باشد");
  if (isAncestor(people, h.id, w.id) || isAncestor(people, w.id, h.id)) {
    throw new HttpError(400, "ازدواج میان نیا و نواده ممکن نیست");
  }
}

const createMarriage: Handler = async ({ env, request, user }) => {
  const me = require(user, "viewer");
  const m = parseMarriage(await body(request));
  await checkSpouses(env, me, m);
  const row = await env.DB.prepare(
    `INSERT INTO marriages (husband_id, wife_id, status, marriage_date, end_date, notes) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING RETURNING id`,
  )
    .bind(m.husband_id, m.wife_id, m.status, m.marriage_date, m.end_date, m.notes)
    .first<{ id: number }>();
  if (!row) throw new HttpError(409, "این ازدواج قبلاً ثبت شده است");
  return json({ id: row.id }, 201);
};

const updateMarriage: Handler = async ({ env, request, user, params }) => {
  const me = require(user, "viewer");
  const id = optId(params[0])!;
  const existing = await env.DB.prepare("SELECT * FROM marriages WHERE id = ?").bind(id).first<Marriage>();
  if (!existing) throw new HttpError(404, "ازدواج یافت نشد");
  const m = parseMarriage(await body(request), existing);
  await checkSpouses(env, me, m, existing);
  try {
    await env.DB.prepare(
      "UPDATE marriages SET husband_id = ?, wife_id = ?, status = ?, marriage_date = ?, end_date = ?, notes = ? WHERE id = ?",
    )
      .bind(m.husband_id, m.wife_id, m.status, m.marriage_date, m.end_date, m.notes, id)
      .run();
  } catch {
    throw new HttpError(409, "این ازدواج قبلاً ثبت شده است");
  }
  return json({ ok: true });
};

const deleteMarriage: Handler = async ({ env, user, params }) => {
  const me = require(user, "viewer");
  const id = optId(params[0])!;
  const existing = await env.DB.prepare("SELECT * FROM marriages WHERE id = ?").bind(id).first<Marriage>();
  if (!existing) return json({ ok: true });
  const { perms } = await loadScoped(env, me);
  if (!canChange(perms, existing.husband_id) && !canChange(perms, existing.wife_id)) throw new HttpError(403, NOT_YOURS);
  await env.DB.prepare("DELETE FROM marriages WHERE id = ?").bind(id).run();
  return json({ ok: true });
};

// ---------------------------------------------------------------------------
// clans (admin)

const createClan: Handler = async ({ env, request, user }) => {
  require(user, "admin");
  const b = await body(request);
  const name = str(b.name, 100);
  if (!name) throw new HttpError(400, "نام طایفه الزامی است");
  const row = await env.DB.prepare("INSERT INTO clans (name, description) VALUES (?, ?) RETURNING id, name, description")
    .bind(name, str(b.description, 1000))
    .first<Clan>();
  return json({ clan: row }, 201);
};

const updateClan: Handler = async ({ env, request, user, params }) => {
  require(user, "admin");
  const b = await body(request);
  const name = str(b.name, 100);
  if (!name) throw new HttpError(400, "نام طایفه الزامی است");
  await env.DB.prepare("UPDATE clans SET name = ?, description = ? WHERE id = ?").bind(name, str(b.description, 1000), optId(params[0])).run();
  return json({ ok: true });
};

const deleteClan: Handler = async ({ env, user, params }) => {
  require(user, "admin");
  const id = optId(params[0])!;
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM people WHERE clan_id = ?").bind(id).first<{ n: number }>();
  if (n?.n) throw new HttpError(400, "این طایفه هنوز عضو دارد؛ ابتدا اعضا را به طایفهٔ دیگری منتقل یا حذف کنید");
  const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM clans").first<{ n: number }>();
  if ((total?.n ?? 0) <= 1) throw new HttpError(400, "دست‌کم یک طایفه باید باقی بماند");
  await env.DB.batch([env.DB.prepare("DELETE FROM grants WHERE clan_id = ?").bind(id), env.DB.prepare("DELETE FROM clans WHERE id = ?").bind(id)]);
  return json({ ok: true });
};

// ---------------------------------------------------------------------------
// access: groups and grants (admin)

const LEVEL_NAMES = ["view", "edit", "delete"];

async function parseGrants(env: Env, raw: unknown): Promise<Grant[]> {
  if (!Array.isArray(raw)) throw new HttpError(400, "فهرست دسترسی نامعتبر است");
  if (raw.length > 100) throw new HttpError(400, "دسترسی‌ها بیش از اندازه است");
  const out: Grant[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    const level = String(r.level);
    if (!LEVEL_NAMES.includes(level)) throw new HttpError(400, "سطح دسترسی نامعتبر است");
    const clan = optId(r.clan_id);
    const root = optId(r.root_id);
    let max: number | null = null;
    if (r.max_gen !== undefined && r.max_gen !== null && r.max_gen !== "") {
      max = Number(r.max_gen);
      if (!Number.isInteger(max) || max < 1 || max > 200) throw new HttpError(400, "تعداد نسل نامعتبر است");
    }
    if (clan && !(await env.DB.prepare("SELECT 1 FROM clans WHERE id = ?").bind(clan).first())) throw new HttpError(400, "طایفه وجود ندارد");
    if (root && !(await env.DB.prepare("SELECT 1 FROM people WHERE id = ?").bind(root).first())) throw new HttpError(400, "شخصِ مبنای شاخه وجود ندارد");
    out.push({ clan_id: clan, root_id: root, level: level as Grant["level"], max_gen: max });
  }
  return out;
}

const grantInsert = (env: Env, owner: "user_id" | "group_id", id: number, g: Grant) =>
  env.DB.prepare(`INSERT INTO grants (${owner}, clan_id, root_id, level, max_gen) VALUES (?, ?, ?, ?, ?)`).bind(id, g.clan_id, g.root_id, g.level, g.max_gen);

const getAccess: Handler = async ({ env, user }) => {
  require(user, "admin");
  const [u, g, ug, gr] = await env.DB.batch([
    env.DB.prepare("SELECT id, username, display_name, role FROM users ORDER BY id"),
    env.DB.prepare("SELECT id, name, description FROM access_groups ORDER BY name"),
    env.DB.prepare("SELECT user_id, group_id FROM user_groups"),
    env.DB.prepare("SELECT id, user_id, group_id, clan_id, root_id, level, max_gen FROM grants ORDER BY id"),
  ]);
  const links = ug.results as { user_id: number; group_id: number }[];
  const grants = gr.results as unknown as Grant[];
  return json({
    users: (u.results as unknown as User[]).map((x) => ({
      ...x,
      groups: links.filter((l) => l.user_id === x.id).map((l) => l.group_id),
      grants: grants.filter((q) => q.user_id === x.id),
    })),
    groups: (g.results as { id: number; name: string; description: string }[]).map((x) => ({
      ...x,
      members: links.filter((l) => l.group_id === x.id).map((l) => l.user_id),
      grants: grants.filter((q) => q.group_id === x.id),
    })),
  });
};

const setUserAccess: Handler = async ({ env, request, user, params }) => {
  require(user, "admin");
  const id = optId(params[0])!;
  const b = await body(request);
  const grants = await parseGrants(env, b.grants ?? []);
  const groups = Array.isArray(b.groups) ? [...new Set((b.groups as unknown[]).map(optId).filter((x): x is number => !!x))] : [];
  await env.DB.batch([
    env.DB.prepare("DELETE FROM grants WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM user_groups WHERE user_id = ?").bind(id),
    ...grants.map((g) => grantInsert(env, "user_id", id, g)),
    ...groups.map((gid) => env.DB.prepare("INSERT OR IGNORE INTO user_groups (user_id, group_id) SELECT ?, id FROM access_groups WHERE id = ?").bind(id, gid)),
  ]);
  return json({ ok: true });
};

async function saveGroup(env: Env, id: number | null, b: Record<string, unknown>) {
  const name = str(b.name, 100);
  if (!name) throw new HttpError(400, "نام گروه الزامی است");
  const grants = await parseGrants(env, b.grants ?? []);
  const members = Array.isArray(b.members) ? [...new Set((b.members as unknown[]).map(optId).filter((x): x is number => !!x))] : [];
  if (id == null) {
    const row = await env.DB.prepare("INSERT INTO access_groups (name, description) VALUES (?, ?) RETURNING id").bind(name, str(b.description, 500)).first<{ id: number }>();
    id = row!.id;
  } else {
    await env.DB.prepare("UPDATE access_groups SET name = ?, description = ? WHERE id = ?").bind(name, str(b.description, 500), id).run();
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM grants WHERE group_id = ?").bind(id),
    env.DB.prepare("DELETE FROM user_groups WHERE group_id = ?").bind(id),
    ...grants.map((g) => grantInsert(env, "group_id", id!, g)),
    ...members.map((uid) => env.DB.prepare("INSERT OR IGNORE INTO user_groups (user_id, group_id) SELECT id, ? FROM users WHERE id = ?").bind(id, uid)),
  ]);
  return id;
}

const createGroup: Handler = async ({ env, request, user }) => {
  require(user, "admin");
  return json({ id: await saveGroup(env, null, await body(request)) }, 201);
};

const updateGroup: Handler = async ({ env, request, user, params }) => {
  require(user, "admin");
  await saveGroup(env, optId(params[0]), await body(request));
  return json({ ok: true });
};

const deleteGroup: Handler = async ({ env, user, params }) => {
  require(user, "admin");
  const id = optId(params[0]);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM grants WHERE group_id = ?").bind(id),
    env.DB.prepare("DELETE FROM user_groups WHERE group_id = ?").bind(id),
    env.DB.prepare("DELETE FROM access_groups WHERE id = ?").bind(id),
  ]);
  return json({ ok: true });
};

// ---------------------------------------------------------------------------
// backup (admin)

const exportData: Handler = async ({ env, user }) => {
  require(user, "admin");
  const res = await getTree({ env, user } as Ctx);
  const data = (await res.json()) as Record<string, unknown>;
  delete data.access;
  return json({ format: "familytree/v1", exported_at: new Date().toISOString(), ...data }, 200, {
    "Content-Disposition": 'attachment; filename="familytree-backup.json"',
  });
};

const importData: Handler = async ({ env, request, user }) => {
  require(user, "admin");
  const b = await body(request);
  if (!Array.isArray(b.people) || !Array.isArray(b.marriages)) throw new HttpError(400, "فایل پشتیبان نامعتبر است");
  // clans: from the file, or keep the current ones
  const fileClans = Array.isArray(b.clans)
    ? (b.clans as Record<string, unknown>[]).map((c) => ({ id: optId(c.id)!, name: str(c.name, 100) || "طایفه", description: str(c.description, 1000) })).filter((c) => c.id)
    : null;
  const clanIds = new Set(
    fileClans ? fileClans.map((c) => c.id) : ((await env.DB.prepare("SELECT id FROM clans").all<{ id: number }>()).results.map((c) => c.id)),
  );
  const fallbackClan = [...clanIds][0] ?? 1;
  const rawPeople = b.people as Record<string, unknown>[];
  const ids = new Set<number>();
  const people = rawPeople.map((r) => {
    const id = optId(r.id);
    if (!id || ids.has(id)) throw new HttpError(400, "شناسهٔ اشخاص در فایل نامعتبر یا تکراری است");
    ids.add(id);
    const p = { id, ...parsePerson(r) } as Person;
    if (p.clan_id == null || !clanIds.has(p.clan_id)) p.clan_id = fallbackClan;
    return p;
  });
  const map = new Map(people.map((p) => [p.id, p]));
  for (const p of people) {
    for (const k of ["father_id", "mother_id"] as const) if (p[k] && !map.has(p[k]!)) p[k] = null;
    checkParents(map, p, p.id);
  }
  const marriages = (b.marriages as Record<string, unknown>[])
    .map((r) => parseMarriage(r))
    .filter((m) => map.get(m.husband_id)?.gender === "male" && map.get(m.wife_id)?.gender === "female");

  const stmts: D1PreparedStatement[] = [env.DB.prepare("DELETE FROM marriages"), env.DB.prepare("DELETE FROM people")];
  if (fileClans?.length) {
    stmts.push(env.DB.prepare("DELETE FROM clans"));
    if (!clanIds.size) stmts.push(env.DB.prepare("INSERT INTO clans (id, name) VALUES (1, 'خاندان اصلی')"));
    for (const c of fileClans) stmts.push(env.DB.prepare("INSERT INTO clans (id, name, description) VALUES (?, ?, ?)").bind(c.id, c.name, c.description));
  }
  for (const p of people) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO people (id, first_name, last_name, nickname, gender, birth_date, death_date, is_deceased, birth_place, photo_url, notes, clan_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(p.id, p.first_name, p.last_name, p.nickname, p.gender, p.birth_date, p.death_date, p.is_deceased, p.birth_place, p.photo_url, p.notes, p.clan_id),
    );
  }
  for (const p of people) {
    if (p.father_id || p.mother_id) {
      stmts.push(env.DB.prepare("UPDATE people SET father_id = ?, mother_id = ? WHERE id = ?").bind(p.father_id, p.mother_id, p.id));
    }
  }
  for (const m of marriages) {
    stmts.push(
      env.DB.prepare(
        "INSERT INTO marriages (husband_id, wife_id, status, marriage_date, end_date, notes) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
      ).bind(m.husband_id, m.wife_id, m.status, m.marriage_date, m.end_date, m.notes),
    );
  }
  await env.DB.batch(stmts);
  return json({ ok: true, people: people.length, marriages: marriages.length });
};

// ---------------------------------------------------------------------------
// router

const routes: [string, RegExp, Handler][] = [
  ["GET", /^\/api\/status$/, status],
  ["POST", /^\/api\/setup$/, setup],
  ["POST", /^\/api\/register$/, register],
  ["POST", /^\/api\/login$/, login],
  ["POST", /^\/api\/logout$/, logout],
  ["PUT", /^\/api\/me\/password$/, changePassword],
  ["PUT", /^\/api\/me\/prefs$/, updatePrefs],
  ["GET", /^\/api\/users$/, listUsers],
  ["POST", /^\/api\/users$/, createUser],
  ["PUT", /^\/api\/users\/(\d+)$/, updateUser],
  ["DELETE", /^\/api\/users\/(\d+)$/, deleteUser],
  ["PUT", /^\/api\/settings$/, updateSettings],
  ["GET", /^\/api\/tree$/, getTree],
  ["POST", /^\/api\/people$/, createPerson],
  ["PUT", /^\/api\/people\/(\d+)$/, updatePerson],
  ["POST", /^\/api\/people\/(\d+)\/move$/, movePerson],
  ["POST", /^\/api\/clans$/, createClan],
  ["PUT", /^\/api\/clans\/(\d+)$/, updateClan],
  ["DELETE", /^\/api\/clans\/(\d+)$/, deleteClan],
  ["GET", /^\/api\/access$/, getAccess],
  ["PUT", /^\/api\/users\/(\d+)\/access$/, setUserAccess],
  ["POST", /^\/api\/groups$/, createGroup],
  ["PUT", /^\/api\/groups\/(\d+)$/, updateGroup],
  ["DELETE", /^\/api\/groups\/(\d+)$/, deleteGroup],
  ["DELETE", /^\/api\/people\/(\d+)$/, deletePerson],
  ["POST", /^\/api\/marriages$/, createMarriage],
  ["PUT", /^\/api\/marriages\/(\d+)$/, updateMarriage],
  ["DELETE", /^\/api\/marriages\/(\d+)$/, deleteMarriage],
  ["GET", /^\/api\/export$/, exportData],
  ["POST", /^\/api\/import$/, importData],
];

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  // Mutations must be JSON: a cross-site HTML form can't send that without a CORS preflight.
  if (request.method !== "GET" && !(request.headers.get("Content-Type") || "").includes("application/json")) {
    throw new HttpError(415, "Content-Type must be application/json");
  }
  let pathMatched = false;
  for (const [method, re, handler] of routes) {
    const m = url.pathname.match(re);
    if (!m) continue;
    pathMatched = true;
    if (method !== request.method) continue;
    const user = await currentUser(env, request);
    return handler({ env, request, url, user, params: m.slice(1) });
  }
  throw new HttpError(pathMatched ? 405 : 404, pathMatched ? "Method not allowed" : "Not found");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, env, url);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: "خطای داخلی سرور" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
