import { ocrSignBuffer, prepImage } from "./gemini.js";
import {
  fetchListingDetail,
  filterListings,
  getAgencyListings,
  normalizeTown,
  resolveAgency,
  type AgencyListing,
} from "./agencies.js";
import { reverseGeocode } from "./geo.js";
import { scoreCandidate } from "./imageMatch.js";
import { sleep } from "./browser.js";

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
const PACING_MS = 350;

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
  reason: string;
}

export type MatchKind = "confident" | "candidates" | "none";

export interface MatchResult {
  agency: string | null;
  phone: string | null;
  town: string | null;
  website: string | null;
  ref: string | null;
  text: string;
  matchKind: MatchKind;
  candidates: MatchCandidate[];
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

export async function matchImage(input: MatchInput): Promise<MatchResult> {
  // 1. OCR the sign (agency name + phone). Phone is the resolution key.
  const ocr = await ocrSignBuffer(input.imageBuffer);

  // 2. Resolve agency by phone (fallback: printed website / name).
  const agency = await resolveAgency({ phone: ocr.phone, name: ocr.agency, website: ocr.website });
  if (!agency) {
    return emptyResult({
      agency: ocr.agency,
      phone: ocr.phone,
      website: ocr.website,
      ref: ocr.ref,
      text: ocr.text,
      debug: {
        crm: null,
        domain: null,
        townSource: "none",
        listingsTotal: 0,
        candidatesEvaluated: 0,
        fromCache: false,
        cacheDate: null,
        note: "could not resolve agency from phone/name/website on the sign",
      },
    });
  }

  // 3. Determine the town: sign first, then caller-provided, then GPS.
  let town: string | null = ocr.town;
  let townSource: MatchResult["debug"]["townSource"] = town ? "sign" : "none";
  if (!town && input.town) {
    town = input.town;
    townSource = "caller";
  }
  if (!town && input.gps) {
    try {
      const geo = await reverseGeocode(input.gps.lat, input.gps.lon);
      if (geo.town) {
        town = geo.town;
        townSource = "gps";
      }
    } catch {
      // best-effort
    }
  }

  // 4. Discover the agency's listings (served from the daily cache).
  const { listings, fromCache, date } = await getAgencyListings(agency);

  // 5. Filter to for-sale in town (or all for-sale if town unknown).
  let pool: AgencyListing[] = town
    ? filterListings(listings, { town })
    : listings.filter((l) => l.forSale);
  const cap = town ? TOWN_CANDIDATE_CAP : NO_TOWN_CANDIDATE_CAP;
  pool = pool.slice(0, cap);

  const queryB64 = await prepImage(input.imageBuffer, 1024);

  // 6. Facade vision-match each candidate (contact sheet => one call per listing).
  const scored: MatchCandidate[] = [];
  for (const listing of pool) {
    const detail = listing.imageUrls.length ? listing : await fetchListingDetail(listing);
    let candidate: MatchCandidate = {
      listingUrl: detail.listingUrl,
      ref: detail.ref,
      type: detail.type,
      town: detail.townLabel,
      address: detail.address,
      price: detail.price,
      facadeImageUrl: detail.imageUrls[0] ?? null,
      confidence: 0,
      reason: "",
    };
    try {
      if (detail.imageUrls.length) {
        const res = await scoreCandidate(queryB64, detail.imageUrls, 9);
        candidate.confidence = Math.round(Math.max(0, Math.min(1, res.score)) * 100);
        candidate.reason = res.reason || "";
        candidate.facadeImageUrl = res.facadeUrl ?? candidate.facadeImageUrl;
      } else {
        candidate.reason = "no listing photos extractable";
      }
    } catch (e) {
      candidate.reason = `scoring error: ${(e as Error).message}`;
    }
    scored.push(candidate);
    await sleep(PACING_MS);
  }

  scored.sort((a, b) => b.confidence - a.confidence);

  // 7. Honest confidence verdict.
  const top = scored[0];
  let matchKind: MatchKind = "none";
  if (top) matchKind = top.confidence >= CONFIDENT * 100 ? "confident" : "candidates";

  const max = input.maxCandidates ?? (matchKind === "confident" ? 4 : 8);

  return {
    agency: agency.name,
    phone: ocr.phone,
    town: town ?? null,
    website: ocr.website ?? `https://${agency.domain}`,
    ref: ocr.ref,
    text: ocr.text,
    matchKind,
    candidates: scored.slice(0, max),
    debug: {
      crm: agency.crm,
      domain: agency.domain,
      townSource,
      listingsTotal: listings.length,
      candidatesEvaluated: pool.length,
      fromCache,
      cacheDate: date,
      note:
        matchKind === "confident"
          ? "facade match above confidence threshold"
          : town
            ? "no confident facade match; showing town candidates to confirm"
            : "no town (no GPS / sign town); showing best-effort candidates to confirm",
    },
  };
}

export { normalizeTown };
