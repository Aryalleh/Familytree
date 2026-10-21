// Version control for people and marriages: every change bumps `version` and is written to
// `history` with the full record after it. Edits name the version they started from; if the
// record moved on since, the change is merged field by field and only overlapping fields that
// ended up different are reported as a conflict.
import type { Env, User } from "./types";

export const PERSON_FIELDS = [
  "first_name",
  "last_name",
  "nickname",
  "gender",
  "birth_date",
  "death_date",
  "is_deceased",
  "birth_place",
  "photo_url",
  "notes",
  "father_id",
  "mother_id",
  "clan_id",
  "birth_order",
  "phone",
  "sons_count",
  "daughters_count",
] as const;
export const MARRIAGE_FIELDS = ["husband_id", "wife_id", "status", "marriage_date", "end_date", "notes"] as const;

export type Entity = "person" | "marriage";
const TABLE: Record<Entity, string> = { person: "people", marriage: "marriages" };
const FIELDS: Record<Entity, readonly string[]> = { person: PERSON_FIELDS, marriage: MARRIAGE_FIELDS };

const jsonObject = (entity: Entity) => `json_object(${FIELDS[entity].map((f) => `'${f}', ${f}`).join(", ")})`;

/** Values are equal for versioning purposes (null, "" and 0/"0" normalised). */
export function same(a: unknown, b: unknown): boolean {
  const n = (v: unknown) => (v === null || v === undefined ? "" : String(v));
  return n(a) === n(b);
}

/**
 * History row for the current state of rows matching `where` (run after the change it
 * records, in the same batch). `offset` 1 is for a delete, recorded just before the row goes.
 */
export function historyStmt(
  env: Env,
  entity: Entity,
  action: "create" | "update" | "delete" | "restore",
  user: User,
  changed: string[],
  where: string,
  binds: unknown[],
  offset = 0,
) {
  return env.DB.prepare(
    `INSERT INTO history (entity, entity_id, version, action, user_id, user_name, changed, data)
     SELECT ?, id, version + ?, ?, ?, ?, ?, ${jsonObject(entity)} FROM ${TABLE[entity]} WHERE ${where}`,
  ).bind(entity, offset, action, user.id, user.display_name || user.username, JSON.stringify(changed), ...binds);
}

/** The record as it was at `version`, or null if that version is unknown. */
export async function recordAt(env: Env, entity: Entity, id: number, version: number): Promise<Record<string, unknown> | null> {
  const row = await env.DB.prepare("SELECT data FROM history WHERE entity = ? AND entity_id = ? AND version = ? ORDER BY id DESC LIMIT 1")
    .bind(entity, id, version)
    .first<{ data: string }>();
  return row ? JSON.parse(row.data) : null;
}

export interface FieldConflict {
  field: string;
  base: unknown;
  server: unknown;
  mine: unknown;
}

/**
 * Three-way merge of one record.
 * @param base     the record the edit started from
 * @param current  the record now on the server
 * @param proposed the record as the edit wants it (base + the edit's changes)
 */
export function merge(entity: Entity, base: Record<string, unknown>, current: Record<string, unknown>, proposed: Record<string, unknown>) {
  const fields = FIELDS[entity];
  const mine = fields.filter((f) => !same(proposed[f], base[f]));
  const theirs = new Set(fields.filter((f) => !same(current[f], base[f])));
  const conflicts: FieldConflict[] = mine
    .filter((f) => theirs.has(f) && !same(proposed[f], current[f]))
    .map((f) => ({ field: f, base: base[f] ?? null, server: current[f] ?? null, mine: proposed[f] ?? null }));
  const merged: Record<string, unknown> = { ...current };
  for (const f of mine) merged[f] = proposed[f];
  return { mine, theirs: [...theirs], conflicts, merged };
}

/** Baseline history (version as it stands, action "create") for every row — used after an import. */
export function baselineStmts(env: Env) {
  return (["person", "marriage"] as Entity[]).map((e) =>
    env.DB.prepare(`INSERT INTO history (entity, entity_id, version, action, data) SELECT '${e}', id, version, 'create', ${jsonObject(e)} FROM ${TABLE[e]}`),
  );
}
