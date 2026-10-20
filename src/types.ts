export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
}

export type Role = "admin" | "editor" | "viewer";

export interface User {
  id: number;
  username: string;
  display_name: string;
  role: Role;
  prefs?: string;
  branch_root_id?: number | null;
  visible_gens?: number | null;
}

export interface Person {
  id: number;
  first_name: string;
  last_name: string;
  nickname: string;
  gender: "male" | "female";
  birth_date: string;
  death_date: string;
  is_deceased: number;
  birth_place: string;
  photo_url: string;
  notes: string;
  father_id: number | null;
  mother_id: number | null;
}

export interface Marriage {
  id: number;
  husband_id: number;
  wife_id: number;
  status: "married" | "divorced" | "widowed";
  marriage_date: string;
  end_date: string;
  notes: string;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
