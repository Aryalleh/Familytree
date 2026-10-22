// Updates: tell the admin when a newer version is published on GitHub, and update an install
// made with the "Deploy to Cloudflare" button from inside the app. Such an install lives in its
// own GitHub repository that Workers Builds deploys on every push, so updating means committing
// the new upstream files to that repository (through the GitHub API, with a token the admin
// types in; it is never stored). The build then applies migrations and deploys.

import RELEASE from "../version.json";
import { HttpError, type Env } from "./types";

export const UPSTREAM = "Aryalleh/Familytree";
const UPSTREAM_BRANCH = "main";
const LATEST_URL = `https://raw.githubusercontent.com/${UPSTREAM}/${UPSTREAM_BRANCH}/version.json`;
const CHECK_TTL = 6 * 3600;

export interface Release {
  version: string;
  date?: string;
  changes?: string[];
}

export const current: Release = RELEASE;

/** -1 / 0 / 1 for dotted version numbers. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** The newest published version, cached for a few hours; null when GitHub can't be reached. */
export async function latestRelease(fresh = false): Promise<Release | null> {
  const cache = (caches as unknown as { default: Cache }).default;
  const key = new Request(LATEST_URL);
  if (!fresh) {
    const hit = await cache.match(key);
    if (hit) return hit.json();
  }
  try {
    const res = await fetch(LATEST_URL, { headers: { "User-Agent": "familytree-worker" } });
    if (!res.ok) return null;
    const data = (await res.json()) as Release;
    if (typeof data?.version !== "string") return null;
    await cache.put(key, new Response(JSON.stringify(data), { headers: { "Cache-Control": `max-age=${CHECK_TTL}` } }));
    return data;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// GitHub

type Gh = <T = any>(method: string, path: string, body?: unknown) => Promise<T>;

export function github(token: string): Gh {
  if (!/^[\w-]{20,255}$/.test(token)) throw new HttpError(400, "توکن GitHub نامعتبر است");
  return async (method, path, body) => {
    const res = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "familytree-worker",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const msg = ((await res.json().catch(() => null)) as { message?: string } | null)?.message || res.statusText;
      if (res.status === 401) throw new HttpError(400, "توکن GitHub پذیرفته نشد (منقضی یا اشتباه است)");
      if (res.status === 403 || res.status === 404) throw new HttpError(400, `GitHub اجازه نداد (${res.status}: ${msg}). مطمئن شوید نام مخزن درست است و توکن به آن دسترسی «Contents: Read and write» دارد.`);
      throw new HttpError(502, `خطای GitHub (${res.status}): ${msg}`);
    }
    return res.status === 204 ? (null as never) : res.json();
  };
}

export function parseRepo(v: unknown): string {
  const s = String(v ?? "").trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(s)) throw new HttpError(400, "نام مخزن باید به شکل owner/repo باشد");
  if (s.toLowerCase() === UPSTREAM.toLowerCase()) throw new HttpError(400, "این مخزنِ اصلی پروژه است، نه مخزنِ نصب شما");
  return s;
}

interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
}

async function treeOf(gh: Gh, repo: string, ref: string) {
  const commit = await gh(`GET`, `/repos/${repo}/commits/${encodeURIComponent(ref)}`);
  const tree = await gh<{ tree: TreeEntry[]; truncated: boolean }>("GET", `/repos/${repo}/git/trees/${commit.commit.tree.sha}?recursive=1`);
  if (tree.truncated) throw new HttpError(502, "فهرست فایل‌های مخزن بیش از حد بزرگ است");
  return { commitSha: commit.sha as string, treeSha: commit.commit.tree.sha as string, files: tree.tree.filter((e) => e.type === "blob") };
}

// wrangler.toml keeps the install's own names and ids (set by the deploy button)
const KEEP = ["name", "account_id", "database_name", "database_id"];
export function mergeWrangler(upstream: string, mine: string): string {
  let out = upstream;
  for (const key of KEEP) {
    const re = new RegExp(`^(\\s*${key}\\s*=\\s*)"[^"]*"`, "m");
    const m = mine.match(re);
    if (!m) continue;
    const value = m[0].slice(m[1].length);
    out = re.test(out) ? out.replace(re, (_, pre) => pre + value) : out;
  }
  return out;
}

const decode = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0)));

/** Files that differ from upstream (wrangler.toml handled separately). Files only in the install are kept. */
export async function updatePlan(gh: Gh, repo: string) {
  const info = await gh("GET", `/repos/${repo}`);
  const branch = info.default_branch as string;
  const [up, mine] = await Promise.all([treeOf(gh, UPSTREAM, UPSTREAM_BRANCH), treeOf(gh, repo, branch)]);
  const have = new Map(mine.files.map((f) => [f.path, f.sha]));
  const files = up.files.filter((f) => f.path !== "wrangler.toml" && have.get(f.path) !== f.sha).map(({ path, mode, sha }) => ({ path, mode, sha }));
  return { branch, base: mine.commitSha, files };
}

/** Copy upstream blobs into the install's repository (same content → same sha). */
export async function copyBlobs(gh: Gh, repo: string, shas: string[]) {
  for (const sha of shas) {
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new HttpError(400, "شناسهٔ فایل نامعتبر است");
    const blob = await gh("GET", `/repos/${UPSTREAM}/git/blobs/${sha}`);
    const made = await gh("POST", `/repos/${repo}/git/blobs`, { content: String(blob.content).replace(/\s/g, ""), encoding: "base64" });
    if (made.sha !== sha) throw new HttpError(502, "رونوشت فایل با نسخهٔ اصلی یکی نیست");
  }
}

/** One commit with all the new files on top of the install's branch; Workers Builds deploys it. */
export async function commitUpdate(gh: Gh, repo: string, plan: { branch: string; base: string; files: { path: string; mode: string; sha: string }[] }, version: string) {
  const head = await gh("GET", `/repos/${repo}/git/ref/heads/${encodeURIComponent(plan.branch)}`);
  if (head.object.sha !== plan.base) throw new HttpError(409, "مخزن شما در این فاصله تغییر کرد؛ دوباره «به‌روزرسانی» را بزنید");
  const baseCommit = await gh("GET", `/repos/${repo}/git/commits/${plan.base}`);
  const entries: { path: string; mode: string; type: "blob"; sha?: string; content?: string }[] = plan.files.map((f) => ({ path: f.path, mode: f.mode, type: "blob", sha: f.sha }));
  // wrangler.toml: upstream's, with this install's names and ids
  const [upW, myW] = await Promise.all([
    gh("GET", `/repos/${UPSTREAM}/contents/wrangler.toml?ref=${UPSTREAM_BRANCH}`),
    gh("GET", `/repos/${repo}/contents/wrangler.toml?ref=${encodeURIComponent(plan.branch)}`).catch(() => null),
  ]);
  if (myW) {
    const merged = mergeWrangler(decode(upW.content), decode(myW.content));
    if (merged !== decode(myW.content)) entries.push({ path: "wrangler.toml", mode: "100644", type: "blob", content: merged });
  }
  if (!entries.length) return null;
  const tree = await gh("POST", `/repos/${repo}/git/trees`, { base_tree: baseCommit.tree.sha, tree: entries });
  const commit = await gh("POST", `/repos/${repo}/git/commits`, {
    message: `Update Familytree to ${version}\n\nFrom https://github.com/${UPSTREAM}`,
    tree: tree.sha,
    parents: [plan.base],
  });
  await gh("PATCH", `/repos/${repo}/git/refs/heads/${encodeURIComponent(plan.branch)}`, { sha: commit.sha });
  return commit.html_url as string;
}
