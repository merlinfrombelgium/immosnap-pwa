import { ocrSignBuffer, prepImage } from "./gemini.js";
import {
  fetchListingDetail,
  filterListings,
  getAgencyListings,
  normalizeTown,
  resolveAgency,
  type AgencyListing,
} from "./agencies.js";
import { reverseGeocode, reverseGeocodeOSM, geocodeAddress, haversineMeters } from "./geo.js";
import { scoreCandidate } from "./imageMatch.js";

/**
 * The matcher (validated agency-site path):
 *   OCR(sign) -> resolve agency BY PHONE -> that agency's OWN listings (daily
 *   cache) -> filter by GPS/sign town -> facade vision-match -> ranked candidates.
 *
 * Confidence honesty is a hard requirement: we never surface a confident match
 * unless the facade genuinely matches. Below the confident threshold we return
 * "candidates to confirm", never a confident wrong answer.
 */

// Tunables.
const CONFIDENT = 0.7; // >= this on the top candidate => a confident match
const TOWN_CANDIDATE_CAP = 60; // evaluate the whole town set (Dendermonde ~53)
const NO_TOWN_CANDIDATE_CAP = 24; // when town is unknown, cap the vision work
const SCORE_CONCURRENCY = 12; // parallel facade vision calls (was 6; perf: halves wall time on a full town sweep)
const SCORE_TIMEOUT_MS = 30_000; // hard cap per candidate so a straggler cannot stall the run

/** Resolve `p`, or `fallback` if it does not settle within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
}

/** Map a proximity distance (metres) to a 0..100 confidence. */
export function confidenceFromDistance(m: number): number {
  if (m <= 40) return 97;
  if (m <= 80) return 92;
  if (m <= 150) return 85;
  if (m <= 300) return 72;
  if (m <= 600) return 55;
  if (m <= 1200) return 30;
  return 10;
}

/** Verdict from sorted ascending distances (metres) of ranked candidates.
 * Confident when the nearest is very close, OR clearly nearer than the runner-up
 * (so a shot taken down the street still resolves to the obvious house). */
export function proximityVerdict(sortedDistancesM: number[]): "confident" | "candidates" | "none" {
  if (sortedDistancesM.length === 0) return "none";
  const d0 = sortedDistancesM[0];
  const d1 = sortedDistancesM[1] ?? Infinity;
  if (d0 <= 120) return "confident";
  if (d0 <= 400 && d1 >= d0 * 3) return "confident";
  return "candidates";
}

/** Pick the label whose centroid is closest to the GPS point (pure; geocoding
 * happens by the caller). Resolves the municipality-vs-deelgemeente ambiguity by
 * choosing the geographically nearest town the agency lists in. */
export function nearestLabel(gps: { lat: number; lon: number }, entries: { label: string; lat: number; lon: number }[]): string | null {
  let best: { label: string; d: number } | null = null;
  for (const e of entries) {
    const d = haversineMeters(gps.lat, gps.lon, e.lat, e.lon);
    if (!best || d < best.d) best = { label: e.label, d };
  }
  return best ? best.label : null;
}

/** Map over items with a bounded number of concurrent workers, preserving order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export interface MatchInput {
  imageBuffer: Buffer;
  gps?: { lat: number; lon: number } | null;
  /** caller may pass a known town (e.g. from device reverse-geocode) */
  town?: string | null;
  maxCandidates?: number;
}

export interface MatchCandidate {
  listingUrl: string;
  ref: string | null;
  type: string | null;
  town: string | null;
  address: string | null;
  price: string | null;
  facadeImageUrl: string | null;
  confidence: number; // 0..100
  distanceM: number | null; // metres from photo GPS to geocoded address (proximity rank)
  reason: string;
}

export type MatchKind = "confident" | "candidates" | "none";

export interface MatchTimings {
  ocrMs: number;
  geoMs: number;
  discoverMs: number;
  visionMs: number;
  totalMs: number;
}

export interface MatchResult {
  agency: string | null;
  phone: string | null;
  town: string | null;
  website: string | null;
  ref: string | null;
  text: string;
  matchKind: MatchKind;
  candidates: MatchCandidate[];
  timings: MatchTimings;
  debug: {
    crm: string | null;
    domain: string | null;
    townSource: "sign" | "gps" | "caller" | "none";
    listingsTotal: number;
    candidatesEvaluated: number;
    fromCache: boolean;
    cacheDate: string | null;
    note: string;
  };
}

function zeroTimings(): MatchTimings {
  return { ocrMs: 0, geoMs: 0, discoverMs: 0, visionMs: 0, totalMs: 0 };
}

function emptyResult(partial: Partial<MatchResult>): MatchResult {
  return {
    agency: null,
    phone: null,
    town: null,
    website: null,
    ref: null,
    text: "",
    matchKind: "none",
    candidates: [],
    timings: zeroTimings(),
    debug: {
      crm: null,
      domain: null,
      townSource: "none",
      listingsTotal: 0,
      candidatesEvaluated: 0,
      fromCache: false,
      cacheDate: null,
      note: "",
    },
    ...partial,
  };
}

/**
 * Phase A: OCR -> resolve agency -> town -> agency listings -> filtered pool.
 * Everything up to (but not including) the per-candidate scoring loop, which is
 * the expensive part. Split out so the server can return this fast and score
 * progressively (perf fix, see ZIM-287 plan section 3.3).
 */
export interface DiscoverResult {
  agency: { name: string; domain: string; crm: string } | null;
  phone: string | null;
  town: string | null;
  townSource: MatchResult["debug"]["townSource"];
  website: string | null;
  ref: string | null;
  text: string;
  pool: AgencyListing[];
  queryB64: string | null;
  listingsTotal: number;
  fromCache: boolean;
  cacheDate: string | null;
  timings: Pick<MatchTimings, "ocrMs" | "geoMs" | "discoverMs">;
  note: string;
}

export async function discoverCandidates(input: MatchInput): Promise<DiscoverResult> {
  // 1. OCR the sign (agency name + phone). Phone is the resolution key.
  const ocrStart = Date.now();
  const ocr = await ocrSignBuffer(input.imageBuffer);
  const ocrMs = Date.now() - ocrStart;

  // 2. Resolve agency by phone (fallback: printed website / name).
  const discoverStart = Date.now();
  const agency = await resolveAgency({ phone: ocr.phone, name: ocr.agency, website: ocr.website });
  if (!agency) {
    return {
      agency: null,
      phone: ocr.phone,
      town: null,
      townSource: "none",
      website: ocr.website,
      ref: ocr.ref,
      text: ocr.text,
      pool: [],
      queryB64: null,
      listingsTotal: 0,
      fromCache: false,
      cacheDate: null,
      timings: { ocrMs, geoMs: 0, discoverMs: Date.now() - discoverStart },
      note: "could not resolve agency from phone/name/website on the sign",
    };
  }

  // 3. Determine the town: sign first, then caller-provided, then GPS.
  let town: string | null = ocr.town;
  let townSource: MatchResult["debug"]["townSource"] = town ? "sign" : "none";
  if (!town && input.town) {
    town = input.town;
    townSource = "caller";
  }
  // (GPS -> town is resolved after listings load: nearest-town centroid, below.)

  // 4. Discover the agency's listings (served from the daily cache).
  const { listings, fromCache, date } = await getAgencyListings(agency);
  const discoverMs = Date.now() - discoverStart;

  // GPS path: choose the nearest town the agency actually lists in, by geocoding
  // each unique town-slug centroid (Google) and taking the closest to the photo.
  // Robust to municipality-vs-deelgemeente slug mismatch (Dendermonde vs Baasrode).
  const geoStart = Date.now();
  if (!town && input.gps) {
    const labels = [...new Set(listings.filter((l) => l.forSale && l.townLabel).map((l) => l.townLabel as string))];
    const entries: { label: string; lat: number; lon: number }[] = [];
    for (const label of labels) {
      const g = await geocodeAddress(`${label}, Belgium`);
      if (g) entries.push({ label, lat: g.lat, lon: g.lon });
    }
    const near = nearestLabel({ lat: input.gps.lat, lon: input.gps.lon }, entries);
    if (near) { town = near; townSource = "gps"; }
  }
  const geoMs = Date.now() - geoStart;

  // 5. Filter to for-sale in town (or all for-sale if town unknown).
  let pool: AgencyListing[] = town
    ? filterListings(listings, { town })
    : listings.filter((l) => l.forSale);
  const cap = town ? TOWN_CANDIDATE_CAP : NO_TOWN_CANDIDATE_CAP;
  pool = pool.slice(0, cap);

  const queryB64 = await prepImage(input.imageBuffer, 1024);

  return {
    agency: { name: agency.name, domain: agency.domain, crm: agency.crm },
    phone: ocr.phone,
    town: town ?? null,
    townSource,
    website: ocr.website ?? `https://${agency.domain}`,
    ref: ocr.ref,
    text: ocr.text,
    pool,
    queryB64,
    listingsTotal: listings.length,
    fromCache,
    cacheDate: date,
    timings: { ocrMs, geoMs, discoverMs },
    note: "",
  };
}

export interface ScoreResult {
  candidates: MatchCandidate[];
  matchKind: MatchKind;
  visionMs: number;
}

/**
 * Phase B: score the discovered pool (facade vision-match, or GPS-proximity
 * rank when a photo location is known) and produce the honest verdict.
 */
export async function scoreAndRank(
  pool: AgencyListing[],
  input: Pick<MatchInput, "gps">,
  queryB64: string | null
): Promise<ScoreResult> {
  const visionStart = Date.now();

  // Facade vision-match each candidate (contact sheet => one call per listing).
  //    Run with bounded concurrency so a large home-town set (e.g. ~53 in
  //    Dendermonde) finishes in ~1 min instead of serially over several.
  let scoredCount = 0;
  async function scoreOne(listing: AgencyListing): Promise<MatchCandidate> {
    const detail = listing.imageUrls.length ? listing : await fetchListingDetail(listing);
    const candidate: MatchCandidate = {
      listingUrl: detail.listingUrl,
      ref: detail.ref,
      type: detail.type,
      town: detail.townLabel,
      address: detail.address,
      price: detail.price,
      facadeImageUrl: detail.imageUrls[0] ?? null,
      confidence: 0,
      distanceM: null,
      reason: "",
    };
    if (input.gps) {
      // Geo-proximity rank: photo location vs the listing's geocoded address.
      // The one hard signal (facade vision was confidently wrong). See geo.ts.
      try {
        const g = candidate.address ? await geocodeAddress(candidate.address) : null;
        if (g) {
          candidate.distanceM = haversineMeters(input.gps.lat, input.gps.lon, g.lat, g.lon);
          candidate.confidence = confidenceFromDistance(candidate.distanceM);
          candidate.reason = `${candidate.distanceM} m from photo`;
        } else {
          candidate.confidence = 0;
          candidate.reason = candidate.address ? "address not geocodable" : "no address on listing";
        }
      } catch (e) {
        candidate.reason = `geocode error: ${(e as Error).message}`;
      }
    } else {
      try {
        if (!queryB64) {
          candidate.reason = "no query image";
        } else if (detail.imageUrls.length) {
          const res = await scoreCandidate(queryB64, detail.imageUrls, 6);
          candidate.confidence = Math.round(Math.max(0, Math.min(1, res.score)) * 100);
          candidate.reason = res.reason || "";
          candidate.facadeImageUrl = res.facadeUrl ?? candidate.facadeImageUrl;
        } else {
          candidate.reason = "no listing photos extractable";
        }
      } catch (e) {
        candidate.reason = `scoring error: ${(e as Error).message}`;
      }
    }
    if (process.env.DEBUG_MATCH) console.error(`[match] scored ${++scoredCount}/${pool.length} ${candidate.ref}=${candidate.confidence}`);
    return candidate;
  }

  const scored = await mapLimit(pool, SCORE_CONCURRENCY, (listing) =>
    withTimeout(scoreOne(listing), SCORE_TIMEOUT_MS, {
      listingUrl: listing.listingUrl,
      ref: listing.ref,
      type: listing.type,
      town: listing.townLabel,
      address: listing.address,
      price: listing.price,
      facadeImageUrl: listing.imageUrls[0] ?? null,
      confidence: 0,
      distanceM: null,
      reason: "timed out",
    })
  );

  if (input.gps) {
    scored.sort((a, b) => (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity));
  } else {
    scored.sort((a, b) => b.confidence - a.confidence);
  }

  // 7. Honest confidence verdict.
  const top = scored[0];
  let matchKind: MatchKind = "none";
  if (top) {
    if (input.gps) {
      matchKind = proximityVerdict(scored.map((c) => c.distanceM).filter((d): d is number => d != null));
    } else {
      matchKind = top.confidence >= CONFIDENT * 100 ? "confident" : "candidates";
    }
  }

  return { candidates: scored, matchKind, visionMs: Date.now() - visionStart };
}

/** Full pipeline: discover + score, in one call. What verify:gate and any
 * non-streaming caller use; the server's /match route calls the two phases
 * separately instead so it can return Phase A immediately (see server.ts). */
export async function matchImage(input: MatchInput): Promise<MatchResult> {
  const t0 = Date.now();
  const disc = await discoverCandidates(input);

  if (!disc.agency) {
    return emptyResult({
      agency: null,
      phone: disc.phone,
      website: disc.website,
      ref: disc.ref,
      text: disc.text,
      timings: { ...disc.timings, visionMs: 0, totalMs: Date.now() - t0 },
      debug: {
        crm: null,
        domain: null,
        townSource: "none",
        listingsTotal: 0,
        candidatesEvaluated: 0,
        fromCache: false,
        cacheDate: null,
        note: disc.note,
      },
    });
  }

  const { candidates, matchKind, visionMs } = await scoreAndRank(disc.pool, { gps: input.gps }, disc.queryB64);
  const max = input.maxCandidates ?? (matchKind === "confident" ? 4 : 8);

  return {
    agency: disc.agency.name,
    phone: disc.phone,
    town: disc.town,
    website: disc.website,
    ref: disc.ref,
    text: disc.text,
    matchKind,
    candidates: candidates.slice(0, max),
    timings: { ...disc.timings, visionMs, totalMs: Date.now() - t0 },
    debug: {
      crm: disc.agency.crm,
      domain: disc.agency.domain,
      townSource: disc.townSource,
      listingsTotal: disc.listingsTotal,
      candidatesEvaluated: disc.pool.length,
      fromCache: disc.fromCache,
      cacheDate: disc.cacheDate,
      note:
        matchKind === "confident"
          ? "facade match above confidence threshold"
          : disc.town
            ? "no confident facade match; showing town candidates to confirm"
            : "no town (no GPS / sign town); showing best-effort candidates to confirm",
    },
  };
}

export { normalizeTown };
