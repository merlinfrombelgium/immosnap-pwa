import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Dev telemetry: one JSONL row per snap, plus the raw captured image, so match
 * accuracy and timing can be measured against real ground truth over time. See
 * the plan doc (ZIM-287, section 3.2) for the schema this implements.
 *
 * Append-only per day (store/snaps/YYYY-MM-DD.jsonl). Confirming a pick
 * (POST /confirm) rewrites that day's file in place to patch chosenListingUrl,
 * since JSONL has no native update. Local dataset only, git-ignored.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_DIR = resolve(__dirname, "../../store/snaps");
const IMAGES_DIR = resolve(STORE_DIR, "images");

export interface SnapCandidate {
  ref: string | null;
  listingUrl: string;
  address: string | null;
  price: string | null;
  confidence: number;
  facadeImageUrl: string | null;
}

export interface SnapTimings {
  ocrMs: number;
  geoMs: number;
  discoverMs: number;
  visionMs: number;
  totalMs: number;
}

export type SnapOutcome = "success" | "no_match" | "error";

export interface SnapRecord {
  snapId: string;
  ts: string; // ISO 8601
  imageRef: string | null;
  gps: { lat: number; lon: number } | null;
  town: string | null;
  townSource: "sign" | "gps" | "caller" | "none";
  ocr: { agency: string | null; phone: string | null; website: string | null; ref: string | null };
  agencyResolved: { name: string; domain: string; crm: string } | null;
  candidates: SnapCandidate[];
  matchKind: "confident" | "candidates" | "none";
  chosenListingUrl: string | null;
  timings: SnapTimings;
  fromCache: boolean;
  cacheDate: string | null;
  outcome: SnapOutcome;
  error?: string;
}

export function makeSnapId(): string {
  return `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function dayFileFor(iso: string): string {
  return resolve(STORE_DIR, `${iso.slice(0, 10)}.jsonl`);
}

/** Save the raw captured photo under store/snaps/images/<snapId>.jpg. Returns the repo-relative path stored on the record. */
export async function saveSnapImage(snapId: string, buffer: Buffer): Promise<string> {
  await mkdir(IMAGES_DIR, { recursive: true });
  await writeFile(resolve(IMAGES_DIR, `${snapId}.jpg`), buffer);
  return `store/snaps/images/${snapId}.jpg`;
}

export async function appendSnapRecord(record: SnapRecord): Promise<void> {
  await mkdir(STORE_DIR, { recursive: true });
  await appendFile(dayFileFor(record.ts), `${JSON.stringify(record)}\n`, "utf8");
}

/** List day files newest-first, so confirm/export scan recent days first. */
async function listDayFiles(): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(STORE_DIR);
  } catch {
    return [];
  }
  return names
    .filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
    .sort()
    .reverse()
    .map((n) => resolve(STORE_DIR, n));
}

/** Patch chosenListingUrl (and outcome) onto a previously written snap record. Returns false if the snapId isn't found in any day file. */
export async function confirmSnap(snapId: string, listingUrl: string): Promise<boolean> {
  for (const file of await listDayFiles()) {
    const raw = await readFile(file, "utf8").catch(() => null);
    if (!raw) continue;
    const lines = raw.split("\n").filter(Boolean);
    let found = false;
    const next = lines.map((line) => {
      let rec: SnapRecord;
      try {
        rec = JSON.parse(line);
      } catch {
        return line;
      }
      if (rec.snapId !== snapId) return line;
      found = true;
      rec.chosenListingUrl = listingUrl;
      rec.outcome = "success";
      return JSON.stringify(rec);
    });
    if (found) {
      await writeFile(file, `${next.join("\n")}\n`, "utf8");
      return true;
    }
  }
  return false;
}

/** All records with ts >= since (YYYY-MM-DD), oldest first. Dev-only export path. */
export async function exportSnaps(since?: string): Promise<SnapRecord[]> {
  const files = (await listDayFiles()).reverse(); // oldest first for export
  const out: SnapRecord[] = [];
  for (const file of files) {
    const dateStr = file.slice(-15, -6); // YYYY-MM-DD from the filename
    if (since && dateStr < since) continue;
    const raw = await readFile(file, "utf8").catch(() => "");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* skip a corrupt line rather than failing the whole export */
      }
    }
  }
  return out;
}

const CSV_COLUMNS = [
  "snapId", "ts", "town", "townSource", "agency", "phone", "matchKind",
  "candidatesCount", "chosenListingUrl", "ocrMs", "geoMs", "discoverMs", "visionMs", "totalMs",
  "fromCache", "outcome",
] as const;

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(records: SnapRecord[]): string {
  const rows = records.map((r) =>
    [
      r.snapId, r.ts, r.town, r.townSource, r.ocr?.agency, r.ocr?.phone, r.matchKind,
      r.candidates?.length ?? 0, r.chosenListingUrl, r.timings?.ocrMs, r.timings?.geoMs,
      r.timings?.discoverMs, r.timings?.visionMs, r.timings?.totalMs, r.fromCache, r.outcome,
    ]
      .map(csvCell)
      .join(",")
  );
  return [CSV_COLUMNS.join(","), ...rows].join("\n") + "\n";
}
