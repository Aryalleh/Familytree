// Persian kinship terminology (نسبت‌های خانوادگی) computed from a family graph.
// Pure module: used by the browser app and by the node tests.

/**
 * @typedef {{id:number, gender:'male'|'female', father_id:number|null, mother_id:number|null, first_name?:string, last_name?:string}} Person
 * @typedef {{id:number, husband_id:number, wife_id:number, status:string}} Marriage
 * @typedef {{label:string, kind:string, key?:string}} Relation
 */

export class Family {
  /** @param {Person[]} people @param {Marriage[]} marriages */
  constructor(people, marriages) {
    this.people = new Map(people.map((p) => [p.id, p]));
    this.marriages = marriages.filter((m) => this.people.has(m.husband_id) && this.people.has(m.wife_id));
    /** @type {Map<number, number[]>} */
    this.children = new Map();
    /** @type {Map<number, {id:number, marriage:Marriage}[]>} */
    this.spouses = new Map();
    for (const p of people) {
      for (const pid of [p.father_id, p.mother_id]) {
        if (pid && this.people.has(pid)) {
          if (!this.children.has(pid)) this.children.set(pid, []);
          this.children.get(pid).push(p.id);
        }
      }
    }
    for (const m of this.marriages) {
      for (const [a, b] of [
        [m.husband_id, m.wife_id],
        [m.wife_id, m.husband_id],
      ]) {
        if (!this.spouses.has(a)) this.spouses.set(a, []);
        this.spouses.get(a).push({ id: b, marriage: m });
      }
    }
    this._anc = new Map();
  }

  get(id) {
    return this.people.get(id);
  }

  parentsOf(id) {
    const p = this.people.get(id);
    if (!p) return [];
    return [p.father_id, p.mother_id].filter((x) => x && this.people.has(x));
  }

  childrenOf(id) {
    return this.children.get(id) || [];
  }

  spousesOf(id) {
    return this.spouses.get(id) || [];
  }

  /** Ancestors of `id` (including itself at depth 0) with shortest depth and the next node back toward `id`. */
  ancestors(id) {
    let m = this._anc.get(id);
    if (m) return m;
    m = new Map([[id, { depth: 0, via: null }]]);
    const queue = [id];
    while (queue.length) {
      const cur = queue.shift();
      const d = m.get(cur).depth;
      for (const pid of this.parentsOf(cur)) {
        if (!m.has(pid)) {
          m.set(pid, { depth: d + 1, via: cur });
          queue.push(pid);
        }
      }
    }
    this._anc.set(id, m);
    return m;
  }

  /** Path [from, ..., ancestor] following shortest links. */
  chainUp(from, ancestor) {
    const anc = this.ancestors(from);
    const path = [ancestor];
    let cur = ancestor;
    while (cur !== from) {
      cur = anc.get(cur).via;
      path.push(cur);
    }
    return path.reverse();
  }

  /** Closest common ancestor link between a and b, or null when not blood relatives. */
  bloodLink(a, b) {
    const A = this.ancestors(a);
    const B = this.ancestors(b);
    let best = null;
    for (const [c, ia] of A) {
      const ib = B.get(c);
      if (!ib) continue;
      const score = ia.depth + ib.depth;
      if (!best || score < best.score || (score === best.score && ia.depth < best.up)) {
        best = { ancestor: c, up: ia.depth, down: ib.depth, score };
      }
    }
    if (!best) return null;
    return { ...best, upPath: this.chainUp(a, best.ancestor), downPath: this.chainUp(b, best.ancestor).reverse() };
  }

  /** @returns {Relation|null} what `b` is to `a` by blood */
  bloodRelation(a, b) {
    if (a === b) return { label: "خود شخص", kind: "self", key: "self" };
    const link = this.bloodLink(a, b);
    if (!link) return null;
    return this._fromChain(link.upPath, link.downPath);
  }

  _g(id) {
    return this.people.get(id).gender;
  }

  _isMale(id) {
    return this._g(id) === "male";
  }

  /** upPath = [a, ..., C], downPath = [C, ..., b] */
  _fromChain(upPath, downPath) {
    const up = upPath.length - 1;
    const down = downPath.length - 1;
    const b = downPath[down];
    const male = this._isMale(b);

    if (down === 0) return ancestorTerm(upPath, this);
    if (up === 0) return descendantTerm(down, male);

    if (up === 1 && down === 1) {
      const a = upPath[0];
      const pa = this.people.get(a);
      const pb = this.people.get(b);
      const full = pa.father_id && pa.mother_id && pa.father_id === pb.father_id && pa.mother_id === pb.mother_id;
      const base = male ? "برادر" : "خواهر";
      return { label: full ? base : `${base} ناتنی`, kind: "sibling", key: male ? "brother" : "sister" };
    }

    if (up === 2 && down === 1) {
      const paternal = this._isMale(upPath[1]);
      const label = paternal ? (male ? "عمو" : "عمه") : male ? "دایی" : "خاله";
      return { label, kind: "blood", key: label };
    }

    if (up === 1 && down === 2) {
      const viaBrother = this._isMale(downPath[1]);
      return { label: viaBrother ? "برادرزاده" : "خواهرزاده", kind: "blood", key: viaBrother ? "brother_child" : "sister_child" };
    }

    if (up === 2 && down === 2) {
      const paternal = this._isMale(upPath[1]);
      const uncleMale = this._isMale(downPath[1]);
      const parent = paternal ? (uncleMale ? "عمو" : "عمه") : uncleMale ? "دایی" : "خاله";
      return { label: (male ? "پسر" : "دختر") + parent, kind: "blood", key: "cousin" };
    }

    if (down >= 3) {
      // b is the child of someone whose relation we already know: "پسرِ برادرزاده", "دخترِ پسرعمو", ...
      const inner = this._fromChain(upPath, downPath.slice(0, -1));
      return { label: `${male ? "پسر" : "دختر"} ${ezafe(inner.label)}`.replace(/\s+$/, ""), kind: "blood" };
    }

    // up >= 3, down in 1..2: relative of one of a's ancestors: "عموی پدر", "پسرخالهٔ مادربزرگ", ...
    const pivot = up - 2;
    const inner = this._fromChain(upPath.slice(pivot), downPath);
    const outer = ancestorTerm(upPath.slice(0, pivot + 1), this, false);
    return { label: `${ezafe(inner.label)}${outer.label}`, kind: "blood" };
  }

  /**
   * Every way `b` is related to `a` (blood, marriage, in-law), closest first.
   * @returns {Relation[]}
   */
  relations(a, b) {
    if (a === b) return [{ label: "خود شخص", kind: "self", key: "self" }];
    /** @type {Relation[]} */
    const out = [];
    const add = (r) => {
      if (r && !out.some((x) => x.label === r.label)) out.push(r);
    };
    const aMale = this._isMale(a);
    const bMale = this._isMale(b);

    // 1. spouse
    for (const s of this.spousesOf(a)) {
      if (s.id === b) {
        const ex = s.marriage.status === "divorced" ? " سابق" : "";
        add({ label: (bMale ? "شوهر" : "همسر") + ex, kind: "spouse", key: "spouse" });
      }
    }

    // 2. blood
    const blood = this.bloodRelation(a, b);
    add(blood);

    // 3. b is the spouse of a's blood relative r
    for (const s of this.spousesOf(b)) {
      const r = s.id;
      if (r === a) continue;
      const rel = this.bloodRelation(a, r);
      if (rel) add(spouseOfRelative(rel, bMale, blood));
    }

    // 4. b is a blood relative of a's spouse
    const spouseWord = aMale ? "همسر" : "شوهر";
    for (const s of this.spousesOf(a)) {
      if (s.id === b) continue;
      const rel = this.bloodRelation(s.id, b);
      if (rel) add(relativeOfSpouse(rel, aMale, spouseWord, !!blood));

      // 5. b is the spouse of a blood relative of a's spouse (باجناق، جاری، ...)
      for (const bs of this.spousesOf(b)) {
        if (bs.id === s.id || bs.id === a) continue;
        const r2 = this.bloodRelation(s.id, bs.id);
        if (!r2) continue;
        if (aMale && bMale && r2.key === "sister") add({ label: "باجناق", kind: "inlaw" });
        else if (!aMale && !bMale && r2.key === "brother") add({ label: "جاری", kind: "inlaw" });
        else {
          const so = spouseOfRelative(r2, bMale, this.bloodRelation(s.id, b));
          if (so) add({ label: `${ezafe(so.label)}${spouseWord}`, kind: "inlaw" });
        }
      }
    }

    // 6. b is a close blood relative of the spouse of a's close relative ("پدرِ عروس"، "مادرِ داماد")
    if (!out.length) {
      for (const r of [...this.childrenOf(a), ...this.siblingsOf(a)]) {
        const rRel = this.bloodRelation(a, r);
        for (const x of this.spousesOf(r)) {
          if (x.id === a) continue;
          const xRel = this.bloodRelation(x.id, b);
          if (!xRel || xRel.kind === "self") continue;
          const link = this.bloodLink(x.id, b);
          if (link.up + link.down > 2) continue;
          const xLabel = spouseOfRelative(rRel, this._isMale(x.id), null).label;
          add({ label: `${ezafe(xRel.label)}${xLabel}`, kind: "inlaw" });
        }
      }
    }
    return out;
  }

  siblingsOf(id) {
    const set = new Set();
    for (const p of this.parentsOf(id)) for (const c of this.childrenOf(p)) if (c !== id) set.add(c);
    return [...set];
  }

  /** Blood relation between the spouses of a marriage, or null if they are not relatives. */
  consanguinity(marriage) {
    const link = this.bloodLink(marriage.husband_id, marriage.wife_id);
    if (!link) return null;
    return {
      ...link,
      wifeToHusband: this.bloodRelation(marriage.husband_id, marriage.wife_id).label,
      husbandToWife: this.bloodRelation(marriage.wife_id, marriage.husband_id).label,
    };
  }

  /**
   * Grouped list of relatives of `id` for the details panel.
   * @returns {{title:string, ids:number[]}[]}
   */
  relativeGroups(id) {
    const p = this.people.get(id);
    if (!p) return [];
    const children = this.childrenOf(id);
    const sons = children.filter((c) => this._isMale(c));
    const daughters = children.filter((c) => !this._isMale(c));
    const spouses = this.spousesOf(id).map((s) => s.id);
    const brides = sons.flatMap((s) => this.spousesOf(s).map((x) => x.id));
    const grooms = daughters.flatMap((d) => this.spousesOf(d).map((x) => x.id));
    const grandchildren = children.flatMap((c) => this.childrenOf(c));
    const siblings = this.siblingsOf(id);
    const inLawParents = spouses.flatMap((s) => this.parentsOf(s));
    const grandparents = this.parentsOf(id).flatMap((x) => this.parentsOf(x));
    const groups = [
      { title: "پدر", ids: p.father_id && this.people.has(p.father_id) ? [p.father_id] : [] },
      { title: "مادر", ids: p.mother_id && this.people.has(p.mother_id) ? [p.mother_id] : [] },
      { title: p.gender === "male" ? "همسر" : "شوهر", ids: spouses },
      { title: "پسران", ids: sons },
      { title: "دختران", ids: daughters },
      { title: "عروس‌ها", ids: brides },
      { title: "دامادها", ids: grooms },
      { title: "نوه‌ها", ids: grandchildren },
      { title: "برادران", ids: siblings.filter((s) => this._isMale(s)) },
      { title: "خواهران", ids: siblings.filter((s) => !this._isMale(s)) },
      { title: "پدربزرگ و مادربزرگ", ids: grandparents },
      { title: p.gender === "male" ? "پدرزن و مادرزن" : "پدرشوهر و مادرشوهر", ids: inLawParents },
    ];
    return groups.filter((g) => g.ids.length);
  }
}

// ---------------------------------------------------------------------------
// term helpers

/** Persian ezafe joiner: "عمو" → "عموی ", "خاله" → "خالهٔ ", "پسر" → "پسرِ " (written without kasra). */
export function ezafe(word) {
  if (/[اوآ]$/.test(word)) return word + "ی ";
  if (/ه$/.test(word) && !/اه$/.test(word)) return word + "ٔ ";
  return word + " ";
}

function descendantTerm(down, male) {
  if (down === 1) return { label: male ? "پسر" : "دختر", kind: "child", key: male ? "son" : "daughter" };
  const names = { 2: "نوه", 3: "نتیجه", 4: "نبیره" };
  return { label: names[down] || `نوادهٔ نسل ${down}`, kind: "child", key: down === 2 ? "grandchild" : undefined };
}

/** chain = [a, ..., ancestor] */
function ancestorTerm(chain, fam, withSide = true) {
  const up = chain.length - 1;
  const top = chain[up];
  const male = fam._isMale(top);
  if (up === 1) return { label: male ? "پدر" : "مادر", kind: "parent", key: male ? "father" : "mother" };
  const side = withSide ? (fam._isMale(chain[1]) ? " پدری" : " مادری") : "";
  if (up === 2) return { label: (male ? "پدربزرگ" : "مادربزرگ") + side, kind: "parent", key: "grandparent" };
  if (up === 3) return { label: (male ? "پدرجد" : "مادرجد") + side, kind: "parent" };
  return { label: `نیای نسل ${up}` + side, kind: "parent" };
}

/** Term for the spouse of a's blood relative r (relation rel). */
function spouseOfRelative(rel, spouseMale, bloodRel) {
  switch (rel.key) {
    case "son":
      return { label: "عروس", kind: "inlaw", key: "bride" };
    case "daughter":
      return { label: "داماد", kind: "inlaw", key: "groom" };
    case "brother":
      return { label: "زن‌برادر", kind: "inlaw" };
    case "sister":
      return { label: "شوهرخواهر", kind: "inlaw" };
    case "father":
      // father's wife who is not one's mother
      return bloodRel?.key === "mother" ? null : { label: "نامادری", kind: "step" };
    case "mother":
      return bloodRel?.key === "father" ? null : { label: "ناپدری", kind: "step" };
    case "عمو":
      return { label: "زن‌عمو", kind: "inlaw" };
    case "عمه":
      return { label: "شوهرعمه", kind: "inlaw" };
    case "دایی":
      return { label: "زن‌دایی", kind: "inlaw" };
    case "خاله":
      return { label: "شوهرخاله", kind: "inlaw" };
    case "brother_child":
      return { label: spouseMale ? "داماد برادر" : "عروس برادر", kind: "inlaw" };
    case "sister_child":
      return { label: spouseMale ? "داماد خواهر" : "عروس خواهر", kind: "inlaw" };
    case "grandchild":
      return { label: spouseMale ? "داماد نوه" : "عروس نوه", kind: "inlaw" };
    case "self":
      return null;
    default:
      return { label: `${spouseMale ? "شوهر" : "همسر"} ${rel.label}`, kind: "inlaw" };
  }
}

/** Term for a blood relative (rel, relative to the spouse) of a's spouse. */
function relativeOfSpouse(rel, aMale, spouseWord, isOwnBlood) {
  const sfx = aMale ? "زن" : "شوهر";
  switch (rel.key) {
    case "self":
      return null;
    case "father":
      return { label: `پدر${sfx}`, kind: "inlaw", key: "inlaw_parent" };
    case "mother":
      return { label: `مادر${sfx}`, kind: "inlaw", key: "inlaw_parent" };
    case "brother":
      return { label: `برادر${sfx}`, kind: "inlaw", key: "inlaw_brother" };
    case "sister":
      return { label: `خواهر${sfx}`, kind: "inlaw", key: "inlaw_sister" };
    case "son":
      return isOwnBlood ? null : { label: "ناپسری", kind: "step" };
    case "daughter":
      return isOwnBlood ? null : { label: "نادختری", kind: "step" };
    default:
      return { label: `${ezafe(rel.label)}${spouseWord}`, kind: "inlaw" };
  }
}

export const KIND_LABELS = {
  self: "خود",
  spouse: "همسر",
  parent: "نیاکان",
  child: "فرزندان و نوادگان",
  sibling: "خواهر و برادر",
  blood: "خویشاوند نسبی",
  inlaw: "خویشاوند سببی (عروس، داماد، ...)",
  step: "ناتنی",
};
