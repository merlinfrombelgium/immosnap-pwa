import { compareFacades, ocrSignBuffer, pickBestListing, prepImage } from "./gemini.js";
import { resolveCandidates, type Candidate } from "./portals.js";
import { reverseGeocode } from "./geo.js";
import { sleep } from "./browser.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export interface MatchInput {
  imageBuffer: Buffer;
  gps?: { lat: number; lon: number } | null;
  maxCandidates?: number;
}

export interface MatchCandidate {
  listingUrl: string;
  address: string | null;
  price: string | null;
  facadeImageUrl: string | null;
  confidence: number;
  source: string;
  reason: string;
}

export interface MatchResult {
  agency: string | null;
  phone: string | null;
  town: string | null;
  candidates: MatchCandidate[];
  website: string | null;
  ref: string | null;
  text: string;
}

async function fetchImageB64(url: string, referer?: string): Promise<string | null> {
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": UA,
        "Accept-Language": "nl-BE,nl;q=0.9",
        ...(referer ? { Referer: referer } : {}),
      },
    });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 1500) return null;
    return await prepImage(buf, 768);
  } catch {
    return null;
  }
}

async function scoreCandidate(queryB64: string, cand: Candidate): Promise<MatchCandidate> {
  const urls = cand.allImageUrls.slice(0, 6);
  const imgs: { label: string; b64: string; url: string }[] = [];
  for (let i = 0; i < urls.length; i++) {
    const b64 = await fetchImageB64(urls[i], cand.listingUrl);
    if (b64) imgs.push({ label: String(i), b64, url: urls[i] });
  }

  if (imgs.length === 0) {
    return {
      listingUrl: cand.listingUrl,
      source: cand.source,
      address: cand.address,
      price: cand.price,
      confidence: 0,
      reason: "no listing photos extractable",
      facadeImageUrl: cand.facadeImageUrl,
    };
  }

  const pick = await pickBestListing(queryB64, imgs.map((x) => ({ label: x.label, b64: x.b64 })));
  const best = imgs.find((x) => x.label === String(pick.label)) ?? imgs[0];
  await sleep(400);
  const cmp = await compareFacades(queryB64, best.b64);

  return {
    listingUrl: cand.listingUrl,
    source: cand.source,
    address: cand.address,
    price: cand.price,
    confidence: Math.round(Math.max(0, Math.min(1, cmp.score)) * 100),
    reason: cmp.reason || pick.reason || "",
    facadeImageUrl: best.url,
  };
}

export async function matchImage(input: MatchInput): Promise<MatchResult> {
  const ocr = await ocrSignBuffer(input.imageBuffer);
  let town = ocr.town;

  if (!town && input.gps) {
    try {
      const geo = await reverseGeocode(input.gps.lat, input.gps.lon);
      town = geo.town;
    } catch {
      // best-effort only
    }
  }

  const queryB64 = await prepImage(input.imageBuffer, 1024);
  const candidates =
    ocr.agency
      ? await resolveCandidates(
          { agency: ocr.agency, phone: ocr.phone, website: ocr.website, town },
          { maxCandidates: input.maxCandidates ?? 8 }
        )
      : [];

  const scored: MatchCandidate[] = [];
  for (const candidate of candidates) {
    try {
      scored.push(await scoreCandidate(queryB64, candidate));
    } catch (error) {
      scored.push({
        listingUrl: candidate.listingUrl,
        source: candidate.source,
        address: candidate.address,
        price: candidate.price,
        confidence: 0,
        reason: `scoring error: ${(error as Error).message}`,
        facadeImageUrl: candidate.facadeImageUrl,
      });
    }
    await sleep(500);
  }

  scored.sort((a, b) => b.confidence - a.confidence);

  return {
    agency: ocr.agency,
    phone: ocr.phone,
    town: town ?? null,
    candidates: scored,
    website: ocr.website,
    ref: ocr.ref,
    text: ocr.text,
  };
}
