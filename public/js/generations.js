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
