import { ENV } from "./env.js";
import { getBrowser, newPreparedPage, sleep } from "./browser.js";
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

function classify(url: string, domain: string | null): Classified {
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

/* --------------------------------- Resolver --------------------------------- */

export async function resolveCandidates(
  q: ResolveQuery,
  opts: { maxCandidates?: number } = {}
): Promise<Candidate[]> {
  const maxCandidates = opts.maxCandidates ?? 10;
  const domain = siteDomain(q.website);
  const agency = (q.agency || "").trim();

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
    const c = classify(l, domain);
    if (c.kind === "ignore" || seen.has(c.url)) continue;
    seen.add(c.url);
    classified.push(c);
  }

  // Expand agency / index pages into listing detail URLs.
  const expanded: Classified[] = [];
  const containers = classified.filter((c) => c.kind === "agency" || c.kind === "index").slice(0, 2);
  for (const ap of containers) {
    if (ap.source === "immoweb") {
      for (const card of await resolveImmowebAgency(ap.url)) {
        const c = classify(card.url, domain);
        if (c.kind === "listing" && !seen.has(c.url)) {
          seen.add(c.url);
          expanded.push(c);
        }
      }
      continue;
    }

    if (ap.source === "spotto") {
      for (const card of await resolveSpottoMakelaar(ap.url)) {
        const c = classify(card.url, domain);
        if (c.kind === "listing" && !seen.has(c.url)) {
          seen.add(c.url);
          expanded.push(c);
        }
      }
      continue;
    }

    const d = await scrapePage(ap.url, { scrolls: 6 });
    for (const href of d.links) {
      const c = classify(href, domain);
      if (c.kind === "listing" && !seen.has(c.url)) {
        seen.add(c.url);
        expanded.push(c);
      }
    }
  }

  let listings = [...classified.filter((c) => c.kind === "listing"), ...expanded];
  listings.sort((a, b) => a.priority - b.priority);
  listings = listings.slice(0, maxCandidates);

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
