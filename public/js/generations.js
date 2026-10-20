// Generation numbers (نسل) shared by the Worker (access rules) and the browser (filters, labels).
// Gen 1 is the oldest. Someone with parents in the tree is one generation below the younger
// parent; someone who married in takes their spouse's generation (or sits just above their
// children). Only people without parents get the spouse/child rules, so the result is stable.

/**
 * @param {{id:number, father_id:number|null, mother_id:number|null}[]} people
 * @param {{husband_id:number, wife_id:number}[]} marriages
 * @returns {Map<number, number>}
 */
export function generations(people, marriages) {
  const byId = new Map(people.map((p) => [p.id, p]));
  const spouses = new Map();
  const children = new Map();
  const push = (m, k, v) => (m.has(k) ? m.get(k).push(v) : m.set(k, [v]));
  for (const m of marriages) {
    if (!byId.has(m.husband_id) || !byId.has(m.wife_id)) continue;
    push(spouses, m.husband_id, m.wife_id);
    push(spouses, m.wife_id, m.husband_id);
  }
  for (const p of people) for (const pid of [p.father_id, p.mother_id]) if (pid && byId.has(pid)) push(children, pid, p.id);

  const gen = new Map(people.map((p) => [p.id, 1]));
  for (let iter = 0; iter < people.length + 2; iter++) {
    let changed = false;
    for (const p of people) {
      const parents = [p.father_id, p.mother_id].filter((id) => id && byId.has(id));
      let g;
      if (parents.length) g = 1 + Math.max(...parents.map((id) => gen.get(id)));
      else {
        g = 1;
        for (const s of spouses.get(p.id) || []) g = Math.max(g, gen.get(s));
        for (const c of children.get(p.id) || []) g = Math.max(g, gen.get(c) - 1);
      }
      if (g !== gen.get(p.id)) {
        gen.set(p.id, g);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return gen;
}

/**
 * A branch: the root person, all their descendants, and everyone married to one of them.
 * @returns {Set<number>}
 */
export function branchOf(rootId, people, marriages) {
  const out = new Set();
  if (!people.some((p) => p.id === rootId)) return out;
  const children = new Map();
  for (const p of people) {
    for (const pid of [p.father_id, p.mother_id]) {
      if (!pid) continue;
      if (!children.has(pid)) children.set(pid, []);
      children.get(pid).push(p.id);
    }
  }
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    if (out.has(id)) continue;
    out.add(id);
    stack.push(...(children.get(id) || []));
  }
  for (const m of marriages) {
    if (out.has(m.husband_id)) out.add(m.wife_id);
    else if (out.has(m.wife_id)) out.add(m.husband_id);
  }
  return out;
}

/** The root's ancestors and their spouses, so a branch stays connected to the top of the tree. */
export function lineageOf(rootId, people, marriages) {
  const byId = new Map(people.map((p) => [p.id, p]));
  const out = new Set();
  const stack = [rootId];
  while (stack.length) {
    const p = byId.get(stack.pop());
    if (!p) continue;
    for (const pid of [p.father_id, p.mother_id]) if (pid && byId.has(pid) && !out.has(pid)) (out.add(pid), stack.push(pid));
  }
  for (const m of marriages) {
    if (out.has(m.husband_id)) out.add(m.wife_id);
    else if (out.has(m.wife_id)) out.add(m.husband_id);
  }
  return out;
}

/**
 * Who a user may see and edit.
 * - no branch, no generation limit: everything
 * - branch: the branch and its line of ancestors always; other people only down to `visibleGens`
 *   (null = no limit)
 * - editing is limited to the branch, or to what the user can see when there is no branch
 * @param {{role:string, branch_root_id?:number|null, visible_gens?:number|null}} user
 */
export function access(user, people, marriages, gens = generations(people, marriages)) {
  if (user.role === "admin") return { all: true, visible: null, editable: null, gens };
  const root = user.branch_root_id ?? null;
  const limit = user.visible_gens ?? null;
  const rootMissing = root != null && !people.some((p) => p.id === root);
  const branch = root != null ? branchOf(root, people, marriages) : new Set();
  const lineage = root != null ? lineageOf(root, people, marriages) : new Set();
  const visible = new Set();
  for (const p of people) {
    const others = limit == null ? !rootMissing : gens.get(p.id) <= limit;
    if (branch.has(p.id) || lineage.has(p.id) || others) visible.add(p.id);
  }
  const all = visible.size === people.length && root == null;
  const editable = user.role === "editor" ? (root != null ? branch : visible) : new Set();
  return { all, visible, editable, branch, gens };
}

// ---------------------------------------------------------------------------
// clans (طایفه‌ها) and grants

/**
 * A clan's tree: its members plus "guests" — spouses and children of members who belong to
 * another clan (a bride from another family, a daughter's children).
 */
export function clanView(clanId, people, marriages) {
  const members = new Set(people.filter((p) => p.clan_id === clanId).map((p) => p.id));
  const guests = new Set();
  for (const m of marriages) {
    if (members.has(m.husband_id) && !members.has(m.wife_id)) guests.add(m.wife_id);
    if (members.has(m.wife_id) && !members.has(m.husband_id)) guests.add(m.husband_id);
  }
  for (const p of people) {
    if (!members.has(p.id) && (members.has(p.father_id) || members.has(p.mother_id))) guests.add(p.id);
  }
  return { members, guests };
}

/** Generations computed inside a set of people (so each clan starts at generation 1). */
export function generationsWithin(ids, people, marriages) {
  const sub = people.filter((p) => ids.has(p.id));
  return generations(
    sub,
    marriages.filter((m) => ids.has(m.husband_id) && ids.has(m.wife_id)),
  );
}

/** Each person's generation inside their own clan. */
export function homeGenerations(people, marriages) {
  const byClan = new Map();
  for (const p of people) {
    if (!byClan.has(p.clan_id)) byClan.set(p.clan_id, new Set());
    byClan.get(p.clan_id).add(p.id);
  }
  const out = new Map();
  for (const ids of byClan.values()) for (const [id, g] of generationsWithin(ids, people, marriages)) out.set(id, g);
  return out;
}

const LEVELS = { view: 1, edit: 2, delete: 3 };

/**
 * Effective permissions from a list of grants (a user's own plus those of their groups).
 * A grant: {clan_id|null, root_id|null, level:'view'|'edit'|'delete', max_gen|null}
 *  - root_id: that person's branch (them, descendants, spouses) — the root's ancestors stay
 *    visible for context; otherwise the whole clan (members + guests), or everything when
 *    clan_id is null too
 *  - max_gen: only people down to that generation (counted inside the clan's tree)
 * @returns {{all:boolean, everything?:boolean, visible:Set<number>|null, editable:Set<number>|null, deletable:Set<number>|null, addClans:Set<number|null>|null}}
 */
export function permissions(user, people, marriages, grants) {
  if (user.role === "admin") return { all: true, visible: null, editable: null, deletable: null, addClans: null };
  const byId = new Map(people.map((p) => [p.id, p]));
  const visible = new Set();
  const editable = new Set();
  const deletable = new Set();
  const addClans = new Set(); // clans where unlinked people may be added; null = any clan
  const clanCache = new Map();
  const viewOf = (clanId) => {
    if (!clanCache.has(clanId)) {
      const v = clanView(clanId, people, marriages);
      const ids = new Set([...v.members, ...v.guests]);
      clanCache.set(clanId, { ids, gens: generationsWithin(ids, people, marriages) });
    }
    return clanCache.get(clanId);
  };
  let home = null;
  for (const g of grants) {
    const level = LEVELS[g.level] || 0;
    if (!level) continue;
    let scope;
    let gens;
    let editScope = null; // clan grants edit members only; their guests are just visible
    if (g.root_id != null) {
      const root = byId.get(g.root_id);
      if (!root) continue;
      scope = branchOf(g.root_id, people, marriages);
      for (const id of lineageOf(g.root_id, people, marriages)) visible.add(id);
      const clan = viewOf(root.clan_id);
      const ids = new Set([...clan.ids, ...scope]);
      gens = generationsWithin(ids, people, marriages);
    } else if (g.clan_id != null) {
      const clan = viewOf(g.clan_id);
      scope = clan.ids;
      gens = clan.gens;
      editScope = new Set(people.filter((p) => p.clan_id === g.clan_id).map((p) => p.id));
      if (level >= LEVELS.edit && g.max_gen == null) addClans.add(g.clan_id);
    } else {
      scope = new Set(byId.keys());
      gens = home ??= homeGenerations(people, marriages);
      if (level >= LEVELS.edit && g.max_gen == null) addClans.add(null);
    }
    for (const id of scope) {
      if (g.max_gen != null && (gens.get(id) ?? 1) > g.max_gen) continue;
      visible.add(id);
      if (editScope && !editScope.has(id)) continue;
      if (level >= LEVELS.edit) editable.add(id);
      if (level >= LEVELS.delete) deletable.add(id);
    }
  }
  const all = addClans.has(null) && visible.size === people.length;
  return { all: false, everything: all, visible, editable, deletable, addClans };
}

export const canAddInClan = (perm, clanId) => perm.all || perm.addClans.has(null) || perm.addClans.has(clanId);
