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
  const L = layoutTree(fam, fam, { siblingOrder: "birth" });
  const x = (id) => L.pos.get(id).x;
  const order = [4, 6, 3, 5, 8, 7];
  for (let i = 1; i < order.length; i++) assert.ok(x(order[i - 1]) > x(order[i]), JSON.stringify(order.map(x)));
  // parents are centred over their children
  const mid = (x(4) + x(7)) / 2;
  const couple = (x(1) + x(2)) / 2;
  assert.ok(Math.abs(mid - couple) < 1);
});

test("birth order, horizontal layout: eldest on top", () => {
  const L = layoutTree(fam, fam, { siblingOrder: "birth", orientation: "horizontal" });
  const y = (id) => L.pos.get(id).y;
  const order = [4, 6, 3, 5, 8, 7];
  for (let i = 1; i < order.length; i++) assert.ok(y(order[i - 1]) < y(order[i]));
});
