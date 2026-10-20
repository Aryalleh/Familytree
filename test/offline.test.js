import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOps, queueEdit, replay, isTemp } from "../public/js/offline.js";

const base = {
  people: [
    { id: 1, first_name: "علی", gender: "male", father_id: null, mother_id: null },
    { id: 2, first_name: "فاطمه", gender: "female", father_id: null, mother_id: null },
  ],
  marriages: [],
};

test("offline edits are queued with temporary ids and applied locally", () => {
  let ops = [];
  let r = queueEdit(ops, base, "POST", "/api/people", { first_name: "حسن", gender: "male", father_id: "1", mother_id: 2 });
  ops = r.ops;
  const hasan = r.response.person;
  assert.ok(isTemp(hasan.id));
  assert.equal(hasan.father_id, 1);
  r = queueEdit(ops, base, "POST", "/api/people", { first_name: "زینب", gender: "female", spouse_of: hasan.id });
  ops = r.ops;
  r = queueEdit(ops, base, "PUT", `/api/people/${hasan.id}`, { nickname: "حسنی" });
  ops = r.ops;
  const out = applyOps(base.people, base.marriages, ops);
  assert.equal(out.people.length, 4);
  assert.equal(out.people.find((p) => p.id === hasan.id).nickname, "حسنی");
  assert.equal(out.marriages.length, 1);
  assert.equal(out.marriages[0].husband_id, hasan.id);
});

test("invalid offline edits are rejected", () => {
  assert.throws(() => queueEdit([], base, "POST", "/api/people", { first_name: "", gender: "male" }), /نام/);
  assert.throws(() => queueEdit([], base, "POST", "/api/marriages", { husband_id: 2, wife_id: 1 }), /شوهر/);
});

test("replay maps temporary ids to the ids the server returns", async () => {
  let ops = [];
  let r = queueEdit(ops, base, "POST", "/api/people", { first_name: "حسن", gender: "male", father_id: 1 });
  ops = r.ops;
  const temp = r.response.person.id;
  ops = queueEdit(ops, base, "POST", "/api/people", { first_name: "رضا", gender: "male", father_id: temp }).ops;
  ops.push({ type: "updatePerson", id: 999, data: { nickname: "x" } }); // deleted on the server meanwhile

  const calls = [];
  let next = 50;
  const api = async (method, path, data) => {
    calls.push([method, path, data]);
    if (path === "/api/people/999") throw new Error("شخص یافت نشد");
    if (method === "POST" && path === "/api/people") return { person: { id: next++, ...data } };
    return { ok: true };
  };
  const res = await replay(ops, api);
  assert.equal(res.done, 2);
  assert.equal(res.pending.length, 1);
  assert.equal(res.pending[0].status, "failed");
  assert.equal(res.remaining.length, 1);
  assert.equal(calls[1][2].father_id, 50); // رضا's father is the new real id of حسن
});

test("replay carries versions forward and holds edits behind a conflict", async () => {
  const ops = [
    { type: "updatePerson", id: 1, base_version: 3, data: { nickname: "a" } },
    { type: "updatePerson", id: 1, base_version: 3, data: { notes: "b" } },
    { type: "updatePerson", id: 2, base_version: 5, data: { nickname: "c" } },
    { type: "updatePerson", id: 2, base_version: 5, data: { notes: "d" } },
  ];
  const sent = [];
  const api = async (method, path, data) => {
    sent.push([path, data.base_version]);
    if (path === "/api/people/2") {
      throw Object.assign(new Error("conflict"), { status: 409, data: { conflict: { entity: "person", id: 2, version: 7, fields: [] } } });
    }
    return { person: { id: 1, version: data.base_version + 1 } };
  };
  const res = await replay(ops, api);
  assert.deepEqual(sent, [["/api/people/1", 3], ["/api/people/1", 4], ["/api/people/2", 5]]);
  assert.equal(res.done, 2);
  assert.deepEqual(res.pending.map((p) => p.status), ["conflict", "waiting"]);
});

test("queued edits keep the version they started from", () => {
  const base2 = { people: [{ id: 1, first_name: "علی", gender: "male", version: 4 }], marriages: [] };
  const { ops } = queueEdit([], base2, "PUT", "/api/people/1", { nickname: "x", base_version: 4 });
  assert.equal(ops[0].base_version, 4);
  assert.deepEqual(ops[0].data, { nickname: "x" });
  const del = queueEdit(ops, base2, "DELETE", "/api/people/1?base_version=4");
  assert.equal(del.ops[1].base_version, 4);
});
