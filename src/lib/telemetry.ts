import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Capture-everything dev telemetry (plan section 3.2). One append-only JSONL
 * row per snap, plus the raw image, so match accuracy can be measured and
 * improved from real ground truth instead of guesswork. Schema is shared with
 * Option B (feat/v2-incremental) so the two branches produce comparable data.
 * Never leaves the machine: store/snaps/** is git-ignored, export is localhost-only.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../store/snaps");
const IMAGES_DIR = resolve(ROOT, "images");

export interface SnapCandidateRecord {
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
  ts: number;
  imageRef: string;
  gps: { lat: number; lon: number } | null;
  town: string | null;
  townSource: "sign" | "gps" | "caller" | "none";
  ocr: { agency: string | null; phone: string | null; website: string | null; ref: string | null };
  agencyResolved: { name: string; domain: string; crm: string } | null;
  candidates: SnapCandidateRecord[];
  matchKind: "confident" | "candidates" | "none";
  chosenListingUrl: string | null;
  timings: SnapTimings;
  fromCache: boolean;
  cacheDate: string | null;
  outcome: SnapOutcome;
  error?: string;
}

function dateStr(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}

function dayFile(date: string): string {
  return resolve(ROOT, `${date}.jsonl`);
}

function dateFromSnapId(snapId: string): string {
  const raw = snapId.split("-")[0];
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

/** `YYYYMMDD-<8 hex>`: date-prefixed so a later /confirm can locate the day file
 * directly instead of scanning every JSONL file the store has ever written. */
export function makeSnapId(ts: number): string {
  return `${dateStr(ts).replace(/-/g, "")}-${randomBytes(4).toString("hex")}`;
}

export async function saveSnapImage(snapId: string, buffer: Buffer): Promise<string> {
  await mkdir(IMAGES_DIR, { recursive: true });
  await writeFile(resolve(IMAGES_DIR, `${snapId}.jpg`), buffer);
  return `store/snaps/images/${snapId}.jpg`;
}

export async function writeSnapRecord(record: SnapRecord): Promise<void> {
  await mkdir(ROOT, { recursive: true });
  await appendFile(dayFile(dateStr(record.ts)), JSON.stringify(record) + "\n", "utf8");
}

/** Patches the `chosenListingUrl` (the accuracy label) onto an already-written
 * record. JSONL is append-only in general; this is the one deliberate rewrite,
 * scoped to the single day file the snapId's date prefix points at. */
export async function confirmSnap(snapId: string, listingUrl: string): Promise<boolean> {
  const file = dayFile(dateFromSnapId(snapId));
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return false;
  }
  let found = false;
  const lines = text.split("\n").filter((l) => l.length > 0);
  const patched = lines.map((line) => {
    let row: SnapRecord;
    try {
      row = JSON.parse(line);
    } catch {
      return line;
    }
    if (row.snapId !== snapId) return line;
    found = true;
    row.chosenListingUrl = listingUrl;
    row.outcome = "success";
    return JSON.stringify(row);
  });
  if (!found) return false;
  await writeFile(file, patched.join("\n") + "\n", "utf8");
  return true;
}

/** Concatenated JSONL for every day file from `sinceDate` (YYYY-MM-DD) onward,
 * or the whole dataset when omitted. Dev-only; the server binds this to localhost. */
export async function exportSnaps(sinceDate: string | null): Promise<string> {
  await mkdir(ROOT, { recursive: true });
  const files = (await readdir(ROOT)).filter((f) => f.endsWith(".jsonl")).sort();
  const wanted = sinceDate ? files.filter((f) => f >= `${sinceDate}.jsonl`) : files;
  const parts = await Promise.all(wanted.map((f) => readFile(resolve(ROOT, f), "utf8")));
  return parts.join("");
}
