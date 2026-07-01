import { ocrSignBuffer, prepImage } from "./gemini.js";
import {
  fetchListingDetail,
  filterListings,
  getAgencyListings,
  resolveAgency,
  type AgencyListing,
} from "./agencies.js";
import { geocodeAddress, haversineMeters } from "./geo.js";
import { scoreCandidate } from "./imageMatch.js";
import {
  confidenceFromDistance,
  nearestLabel,
  proximityVerdict,
  type MatchCandidate,
  type MatchInput,
  type MatchKind,
} from "./matcher.js";

/**
 * Perf-first two-phase orchestration around the frozen matcher core.
 * `matcher.ts#matchImage` is a single blocking call (OCR -> discover -> vision
 * for the whole town) and is a hard invariant to keep byte-for-byte unchanged
 * (verify:gate pins it). It has no phase seam of its own, so this module
 * composes the SAME underlying libs (agencies/geo/gemini/imageMatch) into two
 * phases instead of re-deriving matcher's business logic:
 *   Phase A - OCR, agency resolve, town filter, candidate pool. No vision. Fast.
 *   Phase B - facade vision / GPS-distance scoring, run with progress callback
 *             so the caller can serve partial results while it completes.
 * Tunables below are duplicated from matcher.ts (kept in sync by hand) because
 * matcher.ts does not export them and must not be edited to do so.
 */
const CONFIDENT = 0.7;
const TOWN_CANDIDATE_CAP = 60;
const NO_TOWN_CANDIDATE_CAP = 24;
const SCORE_CONCURRENCY = 6;
const SCORE_TIMEOUT_MS = 30_000;

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
}

async function mapLimitProgress<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  onEach: (index: number, result: R) => void
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      const r = await fn(items[i], i);
      out[i] = r;
      onEach(i, r);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export interface PhaseAResult {
  ocr: { agency: string | null; phone: string | null; website: string | null; ref: string | null; text: string };
  agency: { name: string; domain: string; crm: string } | null;
  gps: { lat: number; lon: number } | null;
  town: string | null;
  townSource: "sign" | "gps" | "caller" | "none";
  pool: AgencyListing[];
  candidates: MatchCandidate[];
  fromCache: boolean;
  cacheDate: string | null;
  listingsTotal: number;
  queryB64: string;
  timings: { ocrMs: number; geoMs: number; discoverMs: number };
}

function candidateStub(listing: AgencyListing): MatchCandidate {
  return {
    listingUrl: listing.listingUrl,
    ref: listing.ref,
    type: listing.type,
    town: listing.townLabel,
    address: listing.address,
    price: listing.price,
    facadeImageUrl: listing.imageUrls[0] ?? null,
    confidence: 0,
    distanceM: null,
    reason: "pending",
  };
}

export async function matchPhaseA(input: MatchInput): Promise<PhaseAResult> {
  const t0 = Date.now();
  const ocr = await ocrSignBuffer(input.imageBuffer);
  const ocrMs = Date.now() - t0;

  const t1 = Date.now();
  const agency = await resolveAgency({ phone: ocr.phone, name: ocr.agency, website: ocr.website });
  const agencyMs = Date.now() - t1;
  if (!agency) {
    return {
      ocr: { agency: ocr.agency, phone: ocr.phone, website: ocr.website, ref: ocr.ref, text: ocr.text },
      agency: null,
      gps: input.gps ?? null,
      town: null,
      townSource: "none",
      pool: [],
      candidates: [],
      fromCache: false,
      cacheDate: null,
      listingsTotal: 0,
      queryB64: "",
      timings: { ocrMs, geoMs: agencyMs, discoverMs: 0 },
    };
  }

  let town: string | null = ocr.town;
  let townSource: PhaseAResult["townSource"] = town ? "sign" : "none";
  if (!town && input.town) {
    town = input.town;
    townSource = "caller";
  }

  const t2 = Date.now();
  const { listings, fromCache, date } = await getAgencyListings(agency);
  const discoverMs = Date.now() - t2;

  const t3 = Date.now();
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
  const geoMs = agencyMs + (Date.now() - t3);

  let pool: AgencyListing[] = town ? filterListings(listings, { town }) : listings.filter((l) => l.forSale);
  const cap = town ? TOWN_CANDIDATE_CAP : NO_TOWN_CANDIDATE_CAP;
  pool = pool.slice(0, cap);

  const queryB64 = await prepImage(input.imageBuffer, 1024);

  return {
    ocr: { agency: ocr.agency, phone: ocr.phone, website: ocr.website, ref: ocr.ref, text: ocr.text },
    agency: { name: agency.name, domain: agency.domain, crm: agency.crm },
    gps: input.gps ?? null,
    town,
    townSource,
    pool,
    candidates: pool.map(candidateStub),
    fromCache,
    cacheDate: date,
    listingsTotal: listings.length,
    queryB64,
    timings: { ocrMs, geoMs, discoverMs },
  };
}

export interface PhaseBResult {
  candidates: MatchCandidate[];
  matchKind: MatchKind;
  visionMs: number;
}

/** Scores `phaseA.pool` with the same bounded-concurrency + per-candidate
 * timeout as matcher.ts, calling `onProgress` after each candidate resolves so
 * the caller (server.ts) can serve partial state to a polling client. */
export async function runPhaseB(
  phaseA: PhaseAResult,
  onProgress: (index: number, candidate: MatchCandidate) => void
): Promise<PhaseBResult> {
  const t0 = Date.now();
  const gps = phaseA.gps;

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
    if (gps) {
      try {
        const g = candidate.address ? await geocodeAddress(candidate.address) : null;
        if (g) {
          candidate.distanceM = haversineMeters(gps.lat, gps.lon, g.lat, g.lon);
          candidate.confidence = confidenceFromDistance(candidate.distanceM);
          candidate.reason = `${candidate.distanceM} m from photo`;
        } else {
          candidate.reason = candidate.address ? "address not geocodable" : "no address on listing";
        }
      } catch (e) {
        candidate.reason = `geocode error: ${(e as Error).message}`;
      }
    } else {
      try {
        if (detail.imageUrls.length) {
          const res = await scoreCandidate(phaseA.queryB64, detail.imageUrls, 6);
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
    return candidate;
  }

  const scored = await mapLimitProgress(
    phaseA.pool,
    SCORE_CONCURRENCY,
    (listing) =>
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
      } as MatchCandidate),
    onProgress
  );

  if (gps) {
    scored.sort((a, b) => (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity));
  } else {
    scored.sort((a, b) => b.confidence - a.confidence);
  }

  const top = scored[0];
  let matchKind: MatchKind = "none";
  if (top) {
    if (gps) {
      matchKind = proximityVerdict(scored.map((c) => c.distanceM).filter((d): d is number => d != null));
    } else {
      matchKind = top.confidence >= CONFIDENT * 100 ? "confident" : "candidates";
    }
  }

  return { candidates: scored, matchKind, visionMs: Date.now() - t0 };
}
