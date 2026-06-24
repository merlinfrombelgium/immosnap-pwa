import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_ROOT = resolve(__dirname, "../../.cache/agencies");

/**
 * Daily snapshot cache of an agency's listings.
 *
 * Why daily, per the brief: a *just-sold* sign disappears from the live site fast.
 * If we snapshot each agency's listing set once a day, a sign photographed today
 * still matches yesterday's snapshot, so a sold-but-recent property is not lost.
 *
 * Layout: .cache/agencies/<domain>/<YYYY-MM-DD>.json
 * A read returns the most recent snapshot no older than `maxAgeDays`.
 */

function todayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC, good enough for a daily bucket)
}

function agencyDir(domain: string): string {
  return resolve(CACHE_ROOT, domain.replace(/[^a-z0-9.-]/gi, "_"));
}

export interface CacheEntry<T> {
  domain: string;
  date: string;
  fetchedAt: string;
  listings: T[];
}

/** Read the most recent cached snapshot for a domain, within maxAgeDays. */
export async function readCache<T>(domain: string, maxAgeDays = 3): Promise<CacheEntry<T> | null> {
  const dir = agencyDir(domain);
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort().reverse();
  } catch {
    return null;
  }
  const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000);
  for (const f of files) {
    const date = f.replace(/\.json$/, "");
    const d = new Date(date + "T00:00:00Z");
    if (Number.isNaN(d.getTime()) || d < cutoff) continue;
    try {
      const raw = await readFile(resolve(dir, f), "utf8");
      return JSON.parse(raw) as CacheEntry<T>;
    } catch {
      // skip corrupt file, try older
    }
  }
  return null;
}

/** Write today's snapshot for a domain. */
export async function writeCache<T>(domain: string, listings: T[]): Promise<void> {
  const dir = agencyDir(domain);
  await mkdir(dir, { recursive: true });
  const date = todayKey();
  const entry: CacheEntry<T> = {
    domain,
    date,
    fetchedAt: new Date().toISOString(),
    listings,
  };
  await writeFile(resolve(dir, `${date}.json`), JSON.stringify(entry, null, 2), "utf8");
}
