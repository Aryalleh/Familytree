import { test } from "node:test";
import assert from "node:assert/strict";
import { Family } from "../public/js/kinship.js";
import { layoutTree } from "../public/js/tree.js";

// parents 1 + 2; by year the children are 4, 6, 3, 5 — but 6 is marked as the first child
const P = (id, gender, extra = {}) => ({ id, gender, first_name: `p${id}`, father_id: null, mother_id: null, ...extra });
const people = [
  P(1, "male"),
  P(2, "female"),
  P(3, "male", { father_id: 1, mother_id: 2, birth_date: "۱۳۳۰" }),
  P(4, "female", { father_id: 1, mother_id: 2, birth_date: "1320" }),
  P(5, "male", { father_id: 1, mother_id: 2, birth_date: "۱۳۴۰" }),
  P(6, "female", { father_id: 1, mother_id: 2, birth_date: "۱۳۲۵", birth_order: 1 }),
];
const marriages = [{ id: 1, husband_id: 1, wife_id: 2, status: "married" }];
const fam = new Family(people, marriages);

test("birth order: eldest on the right; «فرزند چندم» overrides the year", () => {
  const L = layoutTree(fam, fam, { siblingOrder: "birth" });
  const x = (id) => L.pos.get(id).x;
  assert.ok(x(6) > x(4) && x(4) > x(3) && x(3) > x(5), JSON.stringify([6, 4, 3, 5].map(x)));
  // parents are centred over their children
  const mid = (x(6) + x(5)) / 2;
  const couple = (x(1) + x(2)) / 2;
  assert.ok(Math.abs(mid - couple) < 1);
});

test("birth order, horizontal layout: eldest on top", () => {
  const L = layoutTree(fam, fam, { siblingOrder: "birth", orientation: "horizontal" });
  const y = (id) => L.pos.get(id).y;
  assert.ok(y(6) < y(4) && y(4) < y(3) && y(3) < y(5));
});
