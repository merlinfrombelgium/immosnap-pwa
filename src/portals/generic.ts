import { renderPage } from "../lib/browser.js";
import { ListingDetail } from "./immoweb.js";

// Known Belgian listing image CDNs (agency CRM backends + portals).
const IMG_PATTERNS = [
  /https?:\/\/r2\.storagewhise\.eu\/[^"'\s)]+?\/(?:1600|1024|800)\/[^"'\s)]+?\.(?:jpg|jpeg|webp)/gi,
  /https?:\/\/[^"'\s)]*storagewhise\.eu\/[^"'\s)]+?\.(?:jpg|jpeg|webp)/gi,
  /https?:\/\/file\.immo-connect\.be\/image\/[a-f0-9-]{36}[^"'\s)]*/gi,
  /https?:\/\/[^"'\s)]*immowebstatic\.be\/[^"'\s)]*classifieds\/[^"'\s)]+?\.(?:jpg|jpeg|webp)/gi,
  /https?:\/\/[^"'\s)]*\.cloudfront\.net\/[^"'\s)]+?\.(?:jpg|jpeg|webp)/gi,
];

const STREET_RE =
  /([A-ZÉÈ][a-zéëèïA-Za-z'.-]+(?:\s[A-ZÉÈ][a-zéëèïA-Za-z'.-]+)*\s(?:straat|laan|steenweg|weg|baan|dreef|kaai|markt|plein|kouter|veld|berg|dam|lei|hof|park|dijk|wijk|pad|heide|akker)\s*\d+[a-zA-Z]?)\s*,?\s*(\d{4})?\s*([A-Z][a-zA-Z]+)?/;

/** Best-effort detail extraction for an agency's own listing page (Whise, etc.). */
export async function getGenericListing(url: string): Promise<ListingDetail> {
  const { html } = await renderPage(url, { settle: 3500, retries: 3, timeout: 55_000, scroll: 5 });
  const imgs = new Set<string>();
  for (const re of IMG_PATTERNS) for (const m of html.matchAll(re)) imgs.add(m[0]);
  let images = Array.from(imgs).filter((u) => !/logo|icon|favicon|sprite|placeholder|map/i.test(u));
  // whise: prefer the 1600 variants, dedupe by filename
  images = dedupe(images);

  const ogImage = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1];
  if (ogImage && !images.includes(ogImage) && /\.(jpg|jpeg|webp)/i.test(ogImage)) images.unshift(ogImage);

  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] || null;
  const sold = /verkocht|verhuurd|onder\s*bod|in\s*optie|verkaveld|geannuleerd|sold/i.test(html);
  const price = html.match(/€\s?([\d.]{4,})/)?.[1] || null;

  // address from JSON-LD or visible text
  let address: string | null = null, town: string | null = null, postcode: string | null = null;
  const ld = html.match(/"streetAddress"\s*:\s*"([^"]+)"[\s\S]{0,160}?"postalCode"\s*:\s*"?(\d{4})"?[\s\S]{0,160}?"addressLocality"\s*:\s*"([^"]+)"/i);
  if (ld) { address = `${ld[1]}, ${ld[2]} ${ld[3]}`; postcode = ld[2]; town = ld[3]; }
  if (!address) {
    const text = html.replace(/<[^>]+>/g, " ");
    const m = text.match(STREET_RE);
    if (m) { address = m[0].replace(/\s+/g, " ").trim(); postcode = m[2] || null; town = m[3] || null; }
  }

  return {
    url, address, town, postcode,
    price: price ? "€ " + price : null,
    images, primaryImage: images[0] || ogImage || null,
    source: "agency" as any,
    ...(ogTitle ? { title: ogTitle } : {}),
    ...(sold ? { sold: true } : {}),
  } as ListingDetail & { sold?: boolean; title?: string };
}

function dedupe(urls: string[]): string[] {
  const best = new Map<string, string>();
  for (const u of urls) {
    const file = u.split("/").pop()!.split("?")[0];
    if (!best.has(file)) best.set(file, u);
  }
  return Array.from(best.values());
}

/* ===========================================================================
 * Generic OWN-SITE adapter
 * ---------------------------------------------------------------------------
 * For agencies whose listings live on their OWN domain (Woonvast, Era, Berno,
 * …) rather than a portal. Scrapes an own-domain detail page into the Candidate
 * shape used by lib/portals.ts. Tuned (recon-validated) for the common Flemish
 * agency CRMs: Zabun/Skarabee (skarabeecmsfilestore…zabun.be/FileStore.ashx),
 * Whise (storagewhise.eu) and immo-connect, with a generic jpg/webp fallback.
 * ======================================================================== */

export interface OwnSiteListing {
  listingUrl: string;
  address: string | null;
  town: string | null;
  price: string | null;
  facadeImageUrl: string | null;
  allImageUrls: string[];
}

// Zabun/Skarabee serve every photo from one FileStore.ashx endpoint, keyed by a
// long `reference=` digit string. The same photo recurs at many widths, so we
// MUST dedupe by reference (not by filename — the filename is always
// "FileStore.ashx", which would collapse the whole gallery to one image).
const ZABUN_RE = /https?:\/\/[a-z0-9.-]*zabun\.be\/[^"'\s)<>]*FileStore\.ashx\?[^"'\s)<>]+/gi;
const WHISE_RE = /https?:\/\/[^"'\s)<>]*storagewhise\.eu\/[^"'\s)<>]+?\.(?:jpg|jpeg|webp)/gi;
const IMMOCONNECT_RE = /https?:\/\/file\.immo-connect\.be\/image\/[a-f0-9-]{36}[^"'\s)<>]*/gi;
const GENERIC_IMG_RE = /https?:\/\/[^"'\s)<>]+?\.(?:jpe?g|webp)(?:\?[^"'\s)<>]*)?/gi;

const OWN_IMG_JUNK_RE =
  /logo|sprite|icon|favicon|placeholder|avatar|brand|badge|flag|pixel|blank|loader|spinner|\bepc\b|epc\/|theme|assets\/|\/static\/|gstatic|googleusercontent|maps\.google|facebook|fbcdn|instagram|youtube/i;

/** Harvest + dedupe listing photos from already-`&amp;`-decoded HTML. */
function ownSiteImages(decoded: string): string[] {
  const out: string[] = [];
  // 1) Zabun/Skarabee — dedupe by reference=, normalise to a full-size URL.
  const refSeen = new Set<string>();
  for (const m of decoded.matchAll(ZABUN_RE)) {
    const url = m[0];
    const ref = url.match(/[?&]reference=([0-9a-f]+)/i)?.[1];
    if (!ref || refSeen.has(ref)) continue;
    refSeen.add(ref);
    const host = url.match(/^https?:\/\/[^/]+/)![0];
    out.push(`${host}/Public/FileStore.ashx?noError=true&reference=${ref}`);
  }
  // 2) Other known CDNs + a generic jpg/webp sweep — dedupe by filename.
  const fileSeen = new Set<string>();
  for (const re of [WHISE_RE, IMMOCONNECT_RE, GENERIC_IMG_RE]) {
    for (const m of decoded.matchAll(re)) {
      const url = m[0];
      if (OWN_IMG_JUNK_RE.test(url)) continue;
      const file = url.split("/").pop()!.split("?")[0].toLowerCase();
      if (!file || fileSeen.has(file)) continue;
      fileSeen.add(file);
      out.push(url);
    }
  }
  return out;
}

// Property street address — taken from og:title / h1 / <title>, NOT from
// JSON-LD PostalAddress (on Zabun/Skarabee that block is the AGENCY office
// address, not the property's).
const OWN_STREET_RE =
  /([A-ZÉÈ][a-zà-ÿ'.]+(?:[ ][A-ZÉÈ]?[a-zà-ÿ'.]+){0,3})\s(\d+\s*[a-zA-Z]?)\s*,\s*(\d{4})\s+([A-ZÉÈ][a-zà-ÿ'\- ]+?)(?:\s{2,}|\s*[|·•]|\s*$)/;

function ownSiteAddress(html: string): { address: string | null; town: string | null } {
  const meta = (p: string) =>
    html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]+content=["']([^"']+)["']`, "i"))?.[1] || null;
  const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const title = html.match(/<title>([^<]+)<\/title>/i)?.[1] || "";
  const hay = [meta("og:title"), meta("twitter:title"), h1, title].filter(Boolean).join("   ||   ") + "   ";
  const m = OWN_STREET_RE.exec(hay);
  if (m) {
    const town = m[4].trim();
    return { address: `${m[1].trim()} ${m[2].replace(/\s+/g, "")}, ${m[3]} ${town}`, town };
  }
  // Town-only fallback ("… te koop in <Town> …").
  const t = /\bin\s+([A-ZÉÈ][a-zà-ÿ\-]+)/.exec(hay);
  return t ? { address: t[1].trim(), town: t[1].trim() } : { address: null, town: null };
}

/**
 * Scrape ONE own-domain detail page into the Candidate-compatible shape.
 * Uses the raw rendered HTML (regex) rather than DOM `img` collection because
 * the CRM galleries (Zabun) carry the photo refs in the page source even when
 * the <img> elements lazy-load late.
 */
export async function getOwnSiteListing(url: string): Promise<OwnSiteListing> {
  const { html } = await renderPage(url, { settle: 3500, retries: 2, timeout: 50_000, scroll: 6 });
  const decoded = html.replace(/&amp;/gi, "&");
  const images = ownSiteImages(decoded).slice(0, 20);
  const { address, town } = ownSiteAddress(html);
  const price = (html.match(/€\s?[\d][\d.\s]{2,}\d/)?.[0] || "").replace(/\s+/g, " ").trim() || null;
  return {
    listingUrl: url,
    address,
    town,
    price,
    facadeImageUrl: images[0] ?? null,
    allImageUrls: images,
  };
}

/**
 * From an own-domain INDEX page (e.g. /te-koop, /nl/te-koop/<town>), harvest
 * detail URLs. Generic signal: an own-domain path segment of 4+ digits is the
 * listing id (Zabun /detail/<slug>/<id>, Whise /nl/aanbod/<id>/<slug>, …).
 */
export function harvestOwnSiteDetailUrls(html: string, ownDomain: string): string[] {
  const decoded = html.replace(/&amp;/gi, "&");
  const esc = ownDomain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const out = new Set<string>();
  const absRe = new RegExp(`https?://(?:www\\.)?${esc}(/[A-Za-z0-9/_\\-]*?/\\d{4,}(?:/[A-Za-z0-9/_\\-]*)?)`, "gi");
  for (const m of decoded.matchAll(absRe)) out.add(`https://www.${ownDomain}${m[1]}`);
  const relRe = /(?:href|content)=["'](\/[A-Za-z0-9/_\-]*?\/\d{4,}(?:\/[A-Za-z0-9/_\-]*)?)["']/gi;
  for (const m of decoded.matchAll(relRe)) out.add(`https://www.${ownDomain}${m[1]}`);
  return [...out];
}
