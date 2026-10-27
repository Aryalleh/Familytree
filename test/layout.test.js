import { test } from "node:test";
import assert from "node:assert/strict";
import { Family } from "../public/js/kinship.js";
import { layoutTree } from "../public/js/tree.js";

// parents 1 + 2; years decide first (4, 6, 3, 5); «فرزند چندم» orders the ones without a year (7, 8)
const P = (id, gender, extra = {}) => ({ id, gender, first_name: `p${id}`, father_id: null, mother_id: null, ...extra });
const people = [
  P(1, "male"),
  P(2, "female"),
  P(3, "male", { father_id: 1, mother_id: 2, birth_date: "۱۳۳۰" }),
  P(4, "female", { father_id: 1, mother_id: 2, birth_date: "1320" }),
  P(5, "male", { father_id: 1, mother_id: 2, birth_date: "۱۳۴۰" }),
  P(6, "female", { father_id: 1, mother_id: 2, birth_date: "۱۳۲۵", birth_order: 1 }), // the year wins
  P(7, "male", { father_id: 1, mother_id: 2, birth_order: 2 }),
  P(8, "male", { father_id: 1, mother_id: 2, birth_order: 1 }),
];
const marriages = [{ id: 1, husband_id: 1, wife_id: 2, status: "married" }];
const fam = new Family(people, marriages);

test("birth order: eldest on the right; year first, then «فرزند چندم»", () => {
  const L = layoutTree(fam, fam, { layout: "tree" });
  const x = (id) => L.pos.get(id).x;
  const order = [4, 6, 3, 5, 8, 7];
  for (let i = 1; i < order.length; i++) assert.ok(x(order[i - 1]) > x(order[i]), JSON.stringify(order.map(x)));
  // parents are centred over their children
  const mid = (x(4) + x(7)) / 2;
  const couple = (x(1) + x(2)) / 2;
  assert.ok(Math.abs(mid - couple) < 1);
});

test("birth order, horizontal layout: eldest on top", () => {
  const L = layoutTree(fam, fam, { layout: "tree", orientation: "horizontal" });
  const y = (id) => L.pos.get(id).y;
  const order = [4, 6, 3, 5, 8, 7];
  for (let i = 1; i < order.length; i++) assert.ok(y(order[i - 1]) < y(order[i]));
});

// cousins from two sub-branches marry: 10 → 11 → 13 (husband) and 10 → 12 → 14 → 15 (wife),
// so the wife's family is a generation deeper; their child is 16
const cousins = new Family(
  [
    P(10, "male"),
    P(11, "male", { father_id: 10 }),
    P(12, "male", { father_id: 10 }),
    P(13, "male", { father_id: 11 }),
    P(14, "male", { father_id: 12 }),
    P(15, "female", { father_id: 14 }),
    P(16, "male", { father_id: 13, mother_id: 15 }),
  ],
  [{ id: 1, husband_id: 13, wife_id: 15, status: "married" }],
);

for (const layout of ["tree", "compact"]) {
  test(`${layout} layout: a couple from two sub-branches continues under the husband's family`, () => {
    const L = layoutTree(cousins, cousins, { layout });
    const link = (child) => L.links.find((l) => Math.abs(l.child) === child);
    assert.equal(link(13).cross, false, "husband's family: the main line");
    assert.equal(link(15).cross, true, "wife's family: the side link");
    // the couple sits within the husband's father's branch, not the wife's father's
    const x = (id) => L.pos.get(id).x;
    assert.ok(Math.abs(x(13) - x(11)) < Math.abs(x(13) - x(14)), JSON.stringify([x(11), x(13), x(14)]));
  });
}

test("children with only the father recorded hang from his only marriage", () => {
  const f = new Family(
    [P(20, "male"), P(21, "female"), P(22, "male", { father_id: 20 }), P(23, "female", { father_id: 20 })],
    [{ id: 1, husband_id: 20, wife_id: 21, status: "married" }],
  );
  const L = layoutTree(f, f, { layout: "tree" });
  const u = L.unions.find((x) => x.marriage?.id === 1);
  assert.deepEqual([...u.children].sort(), [22, 23]);
  assert.ok(!L.unions.some((x) => x.single === 20), "no separate single-parent union");
});
