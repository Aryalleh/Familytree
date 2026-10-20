import { test } from "node:test";
import assert from "node:assert/strict";
import { Family } from "../public/js/kinship.js";

// A small family with a cousin marriage:
//   Ali(1) + Fatemeh(2)  → Hasan(3), Hossein(4), Zahra(5)
//   Hasan(3) + Maryam(6) → Reza(7)
//   Hossein(4) + Sara(8) → Narges(9)
//   Zahra(5) + Karim(10) → Mina(11)
//   Reza(7) + Narges(9)  → Ahmad(12)       (پسرعمو + دخترعمو)
//   Maryam's sister Leila(13), Leila + Javad(14); Maryam's parents Taghi(15)/Roya(16)
const P = (id, gender, father_id = null, mother_id = null) => ({ id, gender, father_id, mother_id });
const people = [
  P(1, "male"), P(2, "female"),
  P(3, "male", 1, 2), P(4, "male", 1, 2), P(5, "female", 1, 2),
  P(15, "male"), P(16, "female"),
  P(6, "female", 15, 16), P(13, "female", 15, 16), P(14, "male"),
  P(7, "male", 3, 6), P(8, "female"), P(9, "female", 4, 8),
  P(10, "male"), P(11, "female", 10, 5),
  P(12, "male", 7, 9),
];
const M = (id, husband_id, wife_id, status = "married") => ({ id, husband_id, wife_id, status });
const marriages = [M(1, 1, 2), M(2, 3, 6), M(3, 4, 8), M(4, 10, 5), M(5, 7, 9), M(6, 14, 13)];
const fam = new Family(people, marriages);
const rel = (a, b) => fam.relations(a, b).map((r) => r.label);

test("direct blood terms", () => {
  // Reza married his cousin, so his father is also his wife's uncle.
  assert.deepEqual(rel(7, 3), ["پدر", "عموی همسر"]);
  assert.deepEqual(rel(7, 6), ["مادر", "زن‌عموی همسر"]);
  assert.deepEqual(rel(3, 7), ["پسر", "داماد برادر"]);
  assert.equal(rel(1, 7)[0], "نوه");
  assert.equal(rel(7, 1)[0], "پدربزرگ پدری");
  assert.equal(rel(7, 15)[0], "پدربزرگ مادری");
  assert.equal(rel(3, 4)[0], "برادر");
  assert.equal(rel(3, 5)[0], "خواهر");
});

test("uncles, aunts and cousins", () => {
  assert.equal(rel(7, 4)[0], "عمو");
  assert.equal(rel(7, 5)[0], "عمه");
  assert.equal(rel(7, 13)[0], "خاله");
  assert.equal(rel(11, 3)[0], "دایی");
  assert.equal(rel(7, 11)[0], "دخترعمه");
  assert.equal(rel(11, 7)[0], "پسردایی");
  assert.equal(rel(4, 7)[0], "برادرزاده");
  assert.equal(rel(3, 11)[0], "خواهرزاده");
});

test("in-laws", () => {
  assert.ok(rel(3, 6).includes("همسر"));
  assert.ok(rel(6, 3).includes("شوهر"));
  assert.ok(rel(1, 6).includes("عروس"));
  assert.ok(rel(1, 10).includes("داماد"));
  assert.ok(rel(6, 1).includes("پدرشوهر"));
  assert.ok(rel(10, 1).includes("پدرزن"));
  assert.ok(rel(10, 3).includes("برادرزن"));
  assert.ok(rel(3, 13).includes("خواهرزن"));
  assert.ok(rel(3, 14).includes("باجناق"));
  assert.ok(rel(8, 6).includes("جاری"));
  assert.ok(rel(7, 8).includes("زن‌عمو"));
  assert.ok(rel(7, 10).includes("شوهرعمه"));
});

test("cousin marriage shows both spouse and blood relation", () => {
  const r = rel(7, 9);
  assert.equal(r[0], "همسر");
  assert.ok(r.includes("دخترعمو"));
  const c = fam.consanguinity(marriages[4]);
  assert.equal(c.wifeToHusband, "دخترعمو");
  assert.equal(c.husbandToWife, "پسرعمو");
  assert.equal(fam.consanguinity(marriages[1]), null);
});

test("child of a cousin marriage", () => {
  // Ahmad's paternal great-grandfather is also his maternal great-grandfather.
  assert.equal(rel(12, 1)[0], "پدرجد پدری");
  assert.equal(rel(12, 4)[0], "پدربزرگ مادری");
  assert.equal(rel(12, 3)[0], "پدربزرگ پدری");
  assert.equal(rel(12, 5)[0], "عمهٔ پدر");
  assert.equal(rel(12, 11)[0], "دخترعمهٔ پدر");
});

test("relative groups", () => {
  const groups = Object.fromEntries(fam.relativeGroups(1).map((g) => [g.title, g.ids]));
  assert.deepEqual(groups["پسران"], [3, 4]);
  assert.deepEqual(groups["دختران"], [5]);
  assert.deepEqual(groups["عروس‌ها"], [6, 8]);
  assert.deepEqual(groups["دامادها"], [10]);
  assert.deepEqual(groups["نوه‌ها"].sort((a, b) => a - b), [7, 9, 11]);
});

import { generations, access } from "../public/js/generations.js";

test("generations put married-in spouses on their partner's level", () => {
  const g = generations(people, marriages);
  assert.equal(g.get(1), 1);
  assert.equal(g.get(3), 2);
  assert.equal(g.get(6), 2); // Maryam married into gen 2 (her parents 15/16 are gen 1)
  assert.equal(g.get(7), 3);
  assert.equal(g.get(12), 4);
  assert.equal(g.get(14), 2); // Karim, married in without parents
});

test("branch access: own branch + lineage, others down to a generation", () => {
  // Hossein (4)'s branch; others visible down to gen 2
  const a = access({ role: "editor", branch_root_id: 4, visible_gens: 2 }, people, marriages);
  for (const id of [4, 8, 9, 7, 12]) assert.ok(a.visible.has(id), `visible ${id}`); // 7 married 9 → in branch
  for (const id of [1, 2, 3, 5]) assert.ok(a.visible.has(id), `gen ≤ 2 ${id}`);
  assert.ok(!a.visible.has(11), "Mina (gen 3, Zahra's branch) hidden");
  assert.ok(a.editable.has(9) && !a.editable.has(3));
  const v = access({ role: "viewer", branch_root_id: 999, visible_gens: null }, people, marriages);
  assert.equal(v.visible.size, 0, "missing branch root shows nothing");
});
