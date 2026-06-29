import { ENV } from "./env.js";
import { getBrowser, newPreparedPage, sleep, renderPage } from "./browser.js";
import type { Page } from "puppeteer-core";
import { getImmowebListing, resolveImmowebAgency } from "../portals/immoweb.js";
import { getSpottoListing, resolveSpottoMakelaar } from "../portals/spotto.js";

/**
 * PORTAL resolver.
 *
 * Given {agency, phone?, website?, town?} find that agency's for-sale listings
 * via real-estate PORTALS (not the agency's own hostile SPA).
 *
 * Design notes (validated during M1 recon):
 *  - The small Flemish agencies in scope (Immo Tijl, Immo Lot, Vastgoed Sinnaeve)
 *    are NOT members of immoscoop's makelaar platform, so immoscoop carries none
 *    of their listings. DuckDuckGo HTML is bot-blocked (202 challenge) and Bing
 *    does not surface these listings.
 *  - SerpApi's plain Google web-search engine reliably maps agency name / phone ->
 *    portal listing URLs. (This is NOT the dead reverse-image-search path.)
 *  - zimmo renders cleanly via Browserless (domcontentloaded + settle + DOM scrape
 *    yields the full gallery from files.zimmo.be) and has agency pages for all three
 *    agencies. immoweb is heavier but usable. spotto retains "verkocht" (sold) stubs
 *    with good addresses but strips the photo gallery.
 *  - The agencies' own sites (immotijl.be, vastgoedsinnaeve.be) are hostile SPAs that
 *    time out — used only as a best-effort fallback.
 *
 * So the resolver = SerpApi discovery -> classify URLs per portal ->
 * expand agency/index pages -> scrape each listing for images + address + price.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export interface ResolveQuery {
  agency: string;
  phone?: string | null;
  website?: string | null;
  town?: string | null;
}

export interface Candidate {
  listingUrl: string;
  source: string;
  address: string | null;
  price: string | null;
  /** best-guess representative image (often the listing's main/og image) */
  facadeImageUrl: string | null;
  /** every listing-photo URL we could harvest (facade is often NOT the first) */
  allImageUrls: string[];
}

/* ----------------------------- SerpApi discovery ---------------------------- */

async function serpLinks(q: string, num = 12): Promise<string[]> {
  const key = ENV.SERPAPI_KEY;
  if (!key) {
    console.error("[portals] SERPAPI_KEY missing — discovery disabled");
    return [];
  }
  const u = new URL("https://serpapi.com/search.json");
  u.searchParams.set("engine", "google");
  u.searchParams.set("q", q);
  u.searchParams.set("hl", "nl");
  u.searchParams.set("gl", "be");
  u.searchParams.set("num", String(num));
  u.searchParams.set("api_key", key);
  try {
    const r = await fetch(u);
    const j: any = await r.json();
    if (j.error) {
      console.error(`[portals] serp error for "${q}": ${j.error}`);
      return [];
    }
    return (j.organic_results || []).map((o: any) => o.link).filter(Boolean);
  } catch (e) {
    console.error(`[portals] serp fetch failed for "${q}": ${(e as Error).message}`);
    return [];
  }
}

function siteDomain(website?: string | null): string | null {
  if (!website) return null;
  const d = website
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .split(/[/?#]/)[0]
    .trim()
    .toLowerCase();
  return d || null;
}

/* ------------------------------- URL classifier ----------------------------- */

type Kind = "listing" | "agency" | "index" | "ignore";
interface Classified {
  kind: Kind;
  source: string;
  url: string;
  priority: number; // lower = better (portals that render well first)
}

/** Bare host (no leading www), lowercased. */
function hostOf(u: string): string | null {
  try {
    return new URL(u).host.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

// Real-estate aggregators we already handle natively — never treat these as an
// agency's "own" site.
const PORTAL_HOST = /(?:^|\.)(immoweb|zimmo|spotto|realo|immoscoop|immovlan|hebbes|logic-immo|zoekhuis|biddit)\.be$/i;
// Socials / search / review sites that surface in discovery but are never listings.
const NON_SITE_HOST =
  /(?:^|\.)(facebook|instagram|tiktok|youtube|youtu|linkedin|twitter|pinterest|google|gstatic|wikipedia|trustpilot|tripadvisor|booking|yelp|paruvendu|immo-vlaanderen)\.[a-z.]+$/i;

/** Strip tracking query/hash from an own-site URL when the id lives in the path. */
function cleanOwnUrl(u: string): string {
  // Normalise scheme + www so http/https and www/non-www variants of the same
  // listing dedupe to one candidate (own-site discovery surfaces both forms).
  const normed = u.replace(/^http:\/\//i, "https://").replace(/^(https:\/\/)www\./i, "$1");
  const hashless = normed.split("#")[0];
  if (/\/\d{4,}(?:[/?]|$)/.test(hashless)) return hashless.replace(/\?.*$/, "").replace(/\/+$/, "");
  return hashless; // id likely lives in the query string — keep it
}

/** A path segment that reads like a property description (multi-word slug). */
function isRichSlug(seg: string): boolean {
  return (seg.match(/-/g) || []).length >= 3 || seg.length >= 25;
}

// For-sale keyword as a WHOLE path segment (own-CRM routing token).
const KW_SEG =
  /^(?:te-koop|te_koop|tekoop|te-huur|aanbod|woning|woningen|panden|eigendommen|properties|property|detail|pand|huis|appartement|villa|object|zoekertje)$/i;

/** A non-portal URL that looks like a single listing/detail page (own CRM). */
function looksLikeOwnListing(u: string): boolean {
  // keyword somewhere in the path (any CRM route carries one)
  const hasKeyword =
    /\/(?:detail|te-koop|te_koop|tekoop|woning|woningen|aanbod|eigendom|eigendommen|pand|panden|property|properties|zoekertje|object|immo|huis|appartement|villa|listing|estate|vastgoed|realisatie|projecten?)\b/i.test(
      u
    );
  if (!hasKeyword) return false;
  // (a) explicit numeric listing id in path or query (Zabun/Skarabee, Whise, …)
  const hasId = /\/(\d{4,})(?:[/?#.]|$)/.test(u) || /[?&](?:id|ref|reference|propertyid)=\d{3,}/i.test(u);
  if (hasId) return true;
  // (b) idless CRM (e.g. Era/Drupal): /te-koop/<town>/<type>/<rich-description-slug>.
  // Require real depth + a description slug at the end so SEO/category stubs
  // (e.g. /detail/te-koop-woning-<town>) are NOT mistaken for listings.
  let segs: string[];
  try {
    segs = new URL(u).pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  } catch {
    return false;
  }
  if (segs.length < 4) return false;
  const kwIdx = segs.findIndex((s) => KW_SEG.test(s));
  const last = segs[segs.length - 1] || "";
  return kwIdx >= 0 && kwIdx < segs.length - 2 && isRichSlug(last);
}

/** A non-portal URL that looks like the agency's own for-sale index/overview. */
function looksLikeOwnIndex(u: string): boolean {
  let segs: string[];
  try {
    segs = new URL(u).pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  } catch {
    return false;
  }
  if (!segs.length) return false;
  if (/\d{4,}/.test(segs.join("/"))) return false; // detail pages carry ids
  const kwIdx = segs.findIndex((s) =>
    /^(?:te-koop|te_koop|tekoop|te-huur|aanbod(?:-te-koop)?|koopwoningen|te-koop-aanbod|properties|eigendommen|panden|ons-aanbod|for-sale)$/i.test(
      s
    )
  );
  if (kwIdx < 0) return false;
  // Index = a for-sale root followed only by short town/type filters (no rich
  // description slug, which would make it a detail page).
  return segs.slice(kwIdx + 1).every((s) => !isRichSlug(s));
}

/**
 * Classify a discovery URL.
 * `domain` is the agency's configured website (if any) and `agencyToken` is its
 * name reduced to [a-z0-9]; either is used to recognise the agency's OWN domain
 * so we keep (not discard) listings hosted on the agency's own site/CRM.
 */
function classify(url: string, domain: string | null, agencyToken: string | null = null): Classified {
  const u = url;
  // zimmo listing detail: /nl/<town-zip>/te-koop/<type>/<CODE>/
  if (/zimmo\.be\/(?:nl|fr)\/[a-z0-9-]+\/(?:te-koop|a-vendre)\/[a-z]+\/[A-Z0-9]{4,}/i.test(u))
    return { kind: "listing", source: "zimmo", url: u, priority: 1 };
  // zimmo agency page
  if (/zimmo\.be\/(?:nl|fr)\/vastgoedkantoor\//i.test(u))
    return { kind: "agency", source: "zimmo", url: u, priority: 1 };
  // immoweb listing detail: /nl/zoekertje/<type>/te-koop/<town>/<zip>/<id>
  if (/immoweb\.be\/(?:nl|en|fr)\/(?:zoekertje|classified|annonce)\/.*\/\d{5,}/i.test(u))
    return { kind: "listing", source: "immoweb", url: u, priority: 2 };
  // immoweb agency page
  if (/immoweb\.be\/(?:nl|en|fr)\/(?:agentschap|agency|agence)\//i.test(u))
    return { kind: "agency", source: "immoweb", url: u, priority: 3 };
  // spotto listing / sold stub: /nl/p/te-koop/<town>/<slug>/<id>
  if (/spotto\.be\/[a-z]{2}\/p\//i.test(u))
    return { kind: "listing", source: "spotto", url: u, priority: 2 };
  if (/spotto\.be\/[a-z]{2}\/makelaar\//i.test(u))
    return { kind: "agency", source: "spotto", url: u, priority: 2 };
  // realo listing detail
  if (/realo\.be\/(?:nl|fr|en)\/[a-z0-9-]+\/\d{6,}/i.test(u))
    return { kind: "listing", source: "realo", url: u, priority: 2 };

  // AGENCY OWN-SITE (additional source, lower priority than portals).
  // When discovery surfaces a detail/index page on a host that is NOT a known
  // portal, treat it as the agency's own listing source so we no longer discard it.
  const host = hostOf(u);
  if (host && !PORTAL_HOST.test(host) && !NON_SITE_HOST.test(host)) {
    const flat = host.replace(/[^a-z0-9]/g, "");
    const matchesAgency = !!(agencyToken && agencyToken.length >= 4 && flat.includes(agencyToken));
    const matchesDomain = !!(domain && (host === domain || host.endsWith("." + domain) || domain.endsWith("." + host)));
    const trusted = matchesAgency || matchesDomain;
    if (looksLikeOwnListing(u))
      return { kind: "listing", source: "agency", url: cleanOwnUrl(u), priority: trusted ? 5 : 6 };
    // Only follow an index/overview page if it is plausibly THIS agency's site,
    // to avoid scraping unrelated `/te-koop` pages.
    if (trusted && looksLikeOwnIndex(u))
      return { kind: "index", source: "agency", url: u, priority: 5 };
  }

  return { kind: "ignore", source: "", url: u, priority: 9 };
}

/* ------------------------------- Page scraping ------------------------------ */

interface ScrapeData {
  navOk: boolean;
  images: string[];
  links: string[];
  ogImage: string | null;
  ogTitle: string | null;
  jsonld: string[];
  title: string;
  text: string;
}

async function scrapePage(
  url: string,
  opts: { scrolls?: number; settle?: number; timeout?: number } = {}
): Promise<ScrapeData> {
  const { scrolls = 4, settle = 3000, timeout = 30_000 } = opts;
  const browser = await getBrowser();
  let page: Page | null = null;
  let navOk = true;
  try {
    page = await newPreparedPage(browser);
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    } catch {
      navOk = false; // hostile SPA timed out — still try to scrape partial DOM
    }
    await sleep(settle);
    for (let i = 0; i < scrolls; i++) {
      await page.evaluate(() => window.scrollBy(0, 1400)).catch(() => {});
      await sleep(600);
    }
    const data = await page.evaluate(() => {
      const images = new Set<string>();
      document.querySelectorAll("img").forEach((im: any) => {
        for (const v of [im.currentSrc, im.src, im.getAttribute("data-src"), im.getAttribute("data-lazy")])
          if (v) images.add(v);
        const ss = im.getAttribute("srcset");
        if (ss) ss.split(",").forEach((s: string) => images.add(s.trim().split(" ")[0]));
      });
      // CSS background images (some galleries use them)
      document.querySelectorAll<HTMLElement>("[style*='background']").forEach((el) => {
        const m = /url\((['"]?)(https?:\/\/[^'")]+)\1\)/.exec(el.getAttribute("style") || "");
        if (m) images.add(m[2]);
      });
      const links = new Set<string>();
      document.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((a) => links.add(a.href));
      const jsonld: string[] = [];
      document
        .querySelectorAll('script[type="application/ld+json"]')
        .forEach((s) => jsonld.push(s.textContent || ""));
      const meta = (p: string) =>
        (document.querySelector(`meta[property="${p}"]`) as HTMLMetaElement | null)?.content || null;
      return {
        images: [...images],
        links: [...links],
        ogImage: meta("og:image"),
        ogTitle: meta("og:title"),
        jsonld,
        title: document.title || "",
        text: (document.body?.innerText || "").slice(0, 6000),
      };
    });
    await page.close().catch(() => {});
    return { navOk, ...data };
  } catch (e) {
    if (page) await page.close().catch(() => {});
    console.error(`[portals] scrape failed ${url}: ${(e as Error).message}`);
    return { navOk, images: [], links: [], ogImage: null, ogTitle: null, jsonld: [], title: "", text: "" };
  }
}

/* ----------------------------- Field extraction ----------------------------- */

const IMG_EXCLUDE =
  /logo|sprite|icon|favicon|placeholder|avatar|brand|badge|flag|pixel|blank|loader|spinner|\/epc\b|epc\/|maps\.googleapis|gstatic|googleusercontent|facebook|fbcdn|instagram/i;

function listingImages(images: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of images) {
    if (!raw || raw.startsWith("data:") || !/^https?:\/\//i.test(raw)) continue;
    if (IMG_EXCLUDE.test(raw)) continue;
    const isPhoto =
      /files\.zimmo\.be\/backend-api/i.test(raw) ||
      /\.(jpe?g|webp)(?:\?|$)/i.test(raw) ||
      /(?:immoweb|realo|spotto|cloudfront|cloudinary|akamai|cdn)/i.test(raw);
    if (!isPhoto) continue;
    const key = raw.split("?")[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw); // NB: never rewrite signed CDN sizes (e.g. zimmo) — breaks the signature
  }
  return out;
}

const STREET =
  /([A-ZÉ][a-zà-üA-Zéëèïêç'.\- ]*?(?:straat|laan|steenweg|stwg|weg|baan|dreef|kaai|markt|plein|plaats|wijk|hof|pad|kouter|veld|berg|dijk|lei|ring|park|gracht|vest|kade|rij|dam|brug)\s*\d+\s*[a-zA-Z]?)\s*,?\s*(\d{4})\s+([A-Z][a-zà-ü\-\s]+?)\b/;

function parseAddress(d: ScrapeData): string | null {
  // 1) JSON-LD PostalAddress
  for (const raw of d.jsonld) {
    try {
      const j = JSON.parse(raw);
      const stack: any[] = Array.isArray(j) ? [...j] : [j];
      while (stack.length) {
        const o = stack.pop();
        if (o && typeof o === "object") {
          if (o.address) {
            const a = o.address;
            if (typeof a === "string") return a;
            const parts = [a.streetAddress, a.postalCode, a.addressLocality].filter(Boolean);
            if (parts.length) return parts.join(", ");
          }
          for (const v of Object.values(o)) if (v && typeof v === "object") stack.push(v);
        }
      }
    } catch {
      /* ignore */
    }
  }
  // 2) full street address in og:title or body text
  const hay = `${d.ogTitle || ""} ${d.text || ""}`;
  const m = STREET.exec(hay);
  if (m) return `${m[1].trim()}, ${m[2]} ${m[3].trim()}`;
  // 3) town only from "... in <Town> ..." (zimmo/immoweb og:title style)
  const t = /\bin\s+([A-Z][a-zà-ü\-]+(?:\s[A-Z][a-zà-ü\-]+)?)\b/.exec(d.ogTitle || "");
  if (t) return t[1].trim();
  return null;
}

function parsePrice(d: ScrapeData): string | null {
  const hay = `${d.ogTitle || ""} ${d.text || ""}`;
  const m = /€\s?[\d.]{4,}/.exec(hay);
  return m ? m[0].replace(/\s+/g, " ").trim() : null;
}

/* ----------------------- agency own-site (generic) extraction --------------- */

// Photo hosts used by Belgian agency CRMs (Whise/Storagewhise, Skarabee/Zabun,
// immo-connect) plus generic image extensions. Used to keep the gallery on an
// agency's OWN listing page (these are NOT matched by listingImages()).
const OWN_PHOTO =
  /\.(?:jpe?g|webp|png)(?:[?#]|$)/i;
const OWN_PHOTO_HOST =
  /zabun\.be|skarabee|storagewhise\.eu|whise\.eu|immo-connect\.be|cloudfront\.net|cloudinary|akamai|\bcdn\b|FileStore\.ashx|fileformat=jpe?g/i;

/** Harvest listing photos from an agency own-site page (browser DOM image set). */
function ownSiteImages(images: string[]): string[] {
  const byKey = new Map<string, string>();
  const width = (x: string) => Number(/[?&](?:width|w)=(\d+)/i.exec(x)?.[1] || 0);
  for (const raw0 of images) {
    const raw = raw0 ? raw0.replace(/&amp;/gi, "&") : raw0;
    if (!raw || raw.startsWith("data:") || !/^https?:\/\//i.test(raw)) continue;
    if (IMG_EXCLUDE.test(raw)) continue;
    if (!OWN_PHOTO.test(raw) && !OWN_PHOTO_HOST.test(raw)) continue;
    // Dedupe key: the Zabun/Skarabee content reference, else the path sans query.
    const ref = /[?&]reference=([0-9a-f]+)/i.exec(raw)?.[1];
    const key = ref || raw.split("?")[0];
    const prev = byKey.get(key);
    if (!prev || width(raw) > width(prev)) byKey.set(key, raw);
  }
  return [...byKey.values()];
}

/**
 * Listing street address from page headings. On Skarabee/Zabun/Whise own-sites
 * the JSON-LD PostalAddress is the AGENCY office (wrong for geo-ranking), so we
 * take the address from og:title / <title> / body text instead.
 */
function ownSiteAddress(d: ScrapeData): string | null {
  const heads = [d.ogTitle, d.title].filter(Boolean) as string[];
  for (const head of heads) {
    // Address is usually the trailing segment after " - " / "|" separators.
    const segs = head.split(/\s*[|–—]\s*|\s-\s/).map((s) => s.trim()).filter(Boolean);
    for (const seg of [...segs.reverse(), head]) {
      const m = STREET.exec(seg);
      if (m && !/\s-\s/.test(m[1])) return `${m[1].trim()}, ${m[2]} ${m[3].trim()}`;
    }
  }
  const m = STREET.exec(d.text || "");
  if (m) return `${m[1].trim()}, ${m[2]} ${m[3].trim()}`;
  // town-only fallback ("... in <Town>")
  const t = /\bin\s+([A-Z][a-zà-ü\-]+(?:\s[A-Z][a-zà-ü\-]+)?)\b/.exec(heads.join(" "));
  return t ? t[1].trim() : null;
}

/** Scrape an agency own-site listing into the shared Candidate fields. */
async function getOwnSiteListing(url: string): Promise<{
  address: string | null;
  price: string | null;
  facadeImageUrl: string | null;
  allImageUrls: string[];
}> {
  const d = await scrapePage(url, { scrolls: 5 });
  const imgs = ownSiteImages(d.images);
  const og = d.ogImage ? d.ogImage.replace(/&amp;/gi, "&") : null;
  const facade = og && !IMG_EXCLUDE.test(og) && (OWN_PHOTO.test(og) || OWN_PHOTO_HOST.test(og)) ? og : imgs[0] || null;
  // Make sure the og facade is also part of the gallery (deduped by reference).
  const gallery = facade && !imgs.includes(facade) ? [facade, ...imgs] : imgs;
  return {
    address: ownSiteAddress(d),
    price: parsePrice(d),
    facadeImageUrl: facade,
    allImageUrls: gallery.slice(0, 12),
  };
}

/**
 * Render an agency's own for-sale index and harvest every own-listing detail URL
 * from the full HTML (anchors AND embedded card data) — the visible page may only
 * paginate ~13 cards while the model carries the whole set. Returns clean URLs.
 */
async function expandOwnSiteIndex(indexUrl: string): Promise<string[]> {
  const host = hostOf(indexUrl);
  if (!host) return [];
  let html = "";
  try {
    ({ html } = await renderPage(indexUrl, { settle: 3500, retries: 2, timeout: 55_000, scroll: 10 }));
  } catch (e) {
    console.error(`[portals] own-index render failed ${indexUrl}: ${(e as Error).message}`);
    return [];
  }
  const decoded = html.replace(/&amp;/gi, "&");
  const esc = host.replace(/\./g, "\\.");
  const found = new Set<string>();
  // absolute on-host URLs anywhere in the markup/JSON
  for (const m of decoded.matchAll(new RegExp(`https?://(?:www\\.)?${esc}/[^"'\\s)<>\\\\]+`, "gi"))) found.add(m[0]);
  // root-relative hrefs
  for (const m of decoded.matchAll(/(?:href|url)["']?\s*[:=]\s*["'](\/[^"'\s)<>\\]+)["']/gi))
    found.add(`https://${host}${m[1]}`);
  const out = new Set<string>();
  for (const raw of found) if (looksLikeOwnListing(raw)) out.add(cleanOwnUrl(raw));
  return [...out];
}

/* ------------------------------ town helpers -------------------------------- */

function normTownSlug(t?: string | null): string | null {
  if (!t) return null;
  const s = t
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return s || null;
}

/** True when a listing URL's path carries the town slug (own-site detail URLs do). */
function urlInTown(url: string, townNorm: string): boolean {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    /* keep raw */
  }
  return path.toLowerCase().replace(/[^a-z0-9]/g, "").includes(townNorm);
}

/* --------------------------------- Resolver --------------------------------- */

export async function resolveCandidates(
  q: ResolveQuery,
  opts: { maxCandidates?: number } = {}
): Promise<Candidate[]> {
  const maxCandidates = opts.maxCandidates ?? 10;
  const domain = siteDomain(q.website);
  const agency = (q.agency || "").trim();
  const agencyToken = agency.toLowerCase().replace(/[^a-z0-9]/g, "");
  const townNorm = normTownSlug(q.town);

  // Build discovery queries (agency name + phone are the strongest keys).
  const queries: string[] = [];
  if (agency) {
    queries.push(`"${agency}" te koop${q.town ? ` ${q.town}` : ""}`);
    queries.push(`site:zimmo.be "${agency}"`);
    queries.push(`site:immoweb.be "${agency}"`);
    queries.push(`site:spotto.be "${agency}"`);
  }
  if (q.phone) queries.push(`"${q.phone}" te koop`);
  const links: string[] = [];
  for (const qq of queries) links.push(...(await serpLinks(qq)));

  // Classify + dedup.
  const seen = new Set<string>();
  const classified: Classified[] = [];
  for (const l of links) {
    const c = classify(l, domain, agencyToken);
    if (c.kind === "ignore" || seen.has(c.url)) continue;
    seen.add(c.url);
    classified.push(c);
  }

  // Expand agency / index pages into listing detail URLs.
  const expanded: Classified[] = [];
  const containers = classified.filter((c) => c.kind === "agency" || c.kind === "index").slice(0, 3);
  for (const ap of containers) {
    if (ap.source === "immoweb") {
      for (const card of await resolveImmowebAgency(ap.url)) {
        const c = classify(card.url, domain, agencyToken);
        if (c.kind === "listing" && !seen.has(c.url)) {
          seen.add(c.url);
          expanded.push(c);
        }
      }
      continue;
    }

    if (ap.source === "spotto") {
      for (const card of await resolveSpottoMakelaar(ap.url)) {
        const c = classify(card.url, domain, agencyToken);
        if (c.kind === "listing" && !seen.has(c.url)) {
          seen.add(c.url);
          expanded.push(c);
        }
      }
      continue;
    }

    if (ap.source === "agency") {
      // Agency own-site index: harvest the full detail-link set from the HTML.
      for (const url of await expandOwnSiteIndex(ap.url)) {
        const c = classify(url, domain, agencyToken);
        if (c.kind === "listing" && !seen.has(c.url)) {
          seen.add(c.url);
          expanded.push(c);
        }
      }
      continue;
    }

    const d = await scrapePage(ap.url, { scrolls: 6 });
    for (const href of d.links) {
      const c = classify(href, domain, agencyToken);
      if (c.kind === "listing" && !seen.has(c.url)) {
        seen.add(c.url);
        expanded.push(c);
      }
    }
  }

  // Split portal candidates (immoweb/spotto/zimmo/realo) from agency own-site ones.
  const all = [...classified.filter((c) => c.kind === "listing"), ...expanded];
  const portalListings = all.filter((c) => c.source !== "agency").sort((a, b) => a.priority - b.priority);
  let ownListings = all.filter((c) => c.source === "agency").sort((a, b) => a.priority - b.priority);

  // Own-site detail URLs carry the town slug, while the agency index lists every
  // town. When a town is known, narrow the own-site set to it (portals are already
  // town-targeted by the SerpApi query, so they are left untouched).
  if (townNorm) {
    const inTown = ownListings.filter((c) => urlInTown(c.url, townNorm));
    if (inTown.length) ownListings = inTown;
  }

  // Portals rank first (they render best); own-site is the additional source.
  // When a town is known the own-site set is already narrowed to a small in-town
  // list, so include it fully and top up with portals. When no town is known,
  // keep own-site a minority so portals stay the majority (don't break that path).
  const ownCap = townNorm ? ownListings.length : Math.ceil(maxCandidates / 3);
  const ownTake = Math.min(ownListings.length, ownCap, maxCandidates);
  const portalTake = Math.min(portalListings.length, maxCandidates - ownTake);
  let listings = [
    ...portalListings.slice(0, portalTake),
    ...ownListings.slice(0, maxCandidates - portalTake),
  ].slice(0, maxCandidates);

  // Scrape each listing for images / address / price.
  const out: Candidate[] = [];
  for (const c of listings) {
    if (c.source === "immoweb") {
      const detail = await getImmowebListing(c.url);
      out.push({
        listingUrl: c.url,
        source: c.source,
        address: detail.address,
        price: detail.price,
        facadeImageUrl: detail.primaryImage,
        allImageUrls: detail.images.slice(0, 12),
      });
      continue;
    }

    if (c.source === "spotto") {
      const detail = await getSpottoListing(c.url);
      out.push({
        listingUrl: c.url,
        source: c.source,
        address: detail.address,
        price: detail.price,
        facadeImageUrl: detail.primaryImage,
        allImageUrls: detail.images.slice(0, 12),
      });
      continue;
    }

    if (c.source === "agency") {
      // Agency own-site / CRM listing page: generic detail scrape with the
      // CRM-aware image harvester + heading-based address (NOT JSON-LD office).
      const detail = await getOwnSiteListing(c.url);
      out.push({
        listingUrl: c.url,
        source: c.source,
        address: detail.address,
        price: detail.price,
        facadeImageUrl: detail.facadeImageUrl,
        allImageUrls: detail.allImageUrls,
      });
      continue;
    }

    const d = await scrapePage(c.url, { scrolls: 4 });
    const imgs = listingImages(d.images);
    const facade =
      d.ogImage && !IMG_EXCLUDE.test(d.ogImage) ? d.ogImage : imgs[0] || null;
    out.push({
      listingUrl: c.url,
      source: c.source,
      address: parseAddress(d),
      price: parsePrice(d),
      facadeImageUrl: facade,
      allImageUrls: imgs.slice(0, 12),
    });
  }
  return out;
}
