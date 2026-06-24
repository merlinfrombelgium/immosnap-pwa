import { renderPage } from "../lib/browser.js";

export interface ListingCard {
  url: string;
  cardImg: string | null;
}

export interface ListingDetail {
  url: string;
  address: string | null;
  town: string | null;
  postcode: string | null;
  price: string | null;
  images: string[]; // full gallery, ordered as on the page
  primaryImage: string | null;
  source: "immoweb" | "spotto" | "agency";
  sold?: boolean;
  title?: string;
}

const UUID_IMG = /https?:\/\/[^"'\\\s]*classifieds\/[a-f0-9-]+\/[^"'\\\s]*?\.(?:jpg|jpeg|png|webp)/gi;

/** Render an immoweb agency or group page and pull its classified cards (url + thumbnail). */
export async function resolveImmowebAgency(agencyUrl: string): Promise<ListingCard[]> {
  const { html } = await renderPage(agencyUrl, { settle: 3500, retries: 3, timeout: 50_000, scroll: 7 });
  // listing URLs
  const urls = new Set<string>();
  for (const m of html.matchAll(/https?:\/\/www\.immoweb\.be\/[a-z]{2}\/zoekertje\/[^"'\\\s]+?\/\d{6,}/gi)) {
    urls.add(stripTrail(m[0]));
  }
  // also relative
  for (const m of html.matchAll(/\/[a-z]{2}\/zoekertje\/[^"'\\\s]+?\/\d{6,}/gi)) {
    urls.add("https://www.immoweb.be" + stripTrail(m[0]));
  }
  const cards: ListingCard[] = [];
  for (const u of urls) {
    const id = u.match(/\/(\d{6,})$/)?.[1];
    let cardImg: string | null = null;
    if (id) {
      // find an image near this id's mention (best-effort)
      const idx = html.indexOf(id);
      if (idx >= 0) {
        const around = html.slice(Math.max(0, idx - 1500), idx + 1500);
        const im = around.match(UUID_IMG);
        if (im) cardImg = im[0];
      }
    }
    cards.push({ url: u, cardImg });
  }
  return cards;
}

/** Render one immoweb classified and extract address/price/full gallery. */
export async function getImmowebListing(url: string): Promise<ListingDetail> {
  const { html } = await renderPage(url, { settle: 3000, retries: 3, timeout: 50_000 });
  const detail: ListingDetail = {
    url, address: null, town: null, postcode: null, price: null,
    images: [], primaryImage: null, source: "immoweb",
  };

  // Try the embedded window.classified JSON first (richest)
  const j = extractClassifiedJson(html);
  if (j) {
    try {
      const loc = j.property?.location || j.location;
      if (loc) {
        const street = [loc.street, loc.number].filter(Boolean).join(" ");
        detail.postcode = loc.postalCode ? String(loc.postalCode) : null;
        detail.town = loc.locality || loc.municipality || null;
        detail.address = [street || null, [detail.postcode, detail.town].filter(Boolean).join(" ") || null]
          .filter(Boolean).join(", ") || null;
      }
      const price = j.price?.mainValue ?? j.transaction?.sale?.price ?? j.price?.value;
      if (price) detail.price = "€ " + Number(price).toLocaleString("nl-BE");
      const pics = j.media?.pictures || j.pictures || [];
      detail.images = pics
        .map((p: any) => p.largeUrl || p.mediumUrl || p.url || p.smallUrl)
        .filter(Boolean);
    } catch { /* fall through to regex */ }
  }

  // Fallback / supplement: regex gallery images from HTML
  if (detail.images.length === 0) {
    const imgs = new Set<string>();
    for (const m of html.matchAll(UUID_IMG)) imgs.add(m[0]);
    detail.images = dedupeByClassifiedSize(Array.from(imgs));
  }
  // og:image as primary hint
  const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] || null;
  detail.primaryImage = og || detail.images[0] || null;

  // address fallback from JSON-LD or meta
  if (!detail.address) {
    const ld = html.match(/"address"\s*:\s*\{[^}]*"streetAddress"\s*:\s*"([^"]+)"[^}]*"postalCode"\s*:\s*"([^"]+)"[^}]*"addressLocality"\s*:\s*"([^"]+)"/i);
    if (ld) {
      detail.address = `${ld[1]}, ${ld[2]} ${ld[3]}`;
      detail.postcode = ld[2]; detail.town = ld[3];
    }
  }
  if (!detail.price) {
    const p = html.match(/€\s?([\d.,]{4,})/);
    if (p) detail.price = "€ " + p[1];
  }
  if (!detail.town) {
    const t = url.match(/\/zoekertje\/[^/]+\/[^/]+\/([^/]+)\/(\d{4})\//);
    if (t) { detail.town = decodeURIComponent(t[1]).replace(/-/g, " "); detail.postcode = t[2]; }
  }
  return detail;
}

function extractClassifiedJson(html: string): any | null {
  // immoweb: window.classified = {...};  (greedy-safe: balance braces)
  const marker = html.indexOf("window.classified");
  if (marker >= 0) {
    const eq = html.indexOf("=", marker);
    const start = html.indexOf("{", eq);
    if (start >= 0) {
      const obj = balancedSlice(html, start);
      if (obj) { try { return JSON.parse(obj); } catch { /* ignore */ } }
    }
  }
  return null;
}

function balancedSlice(s: string, start: number): string | null {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) return s.slice(start, i + 1); }
    }
  }
  return null;
}

function stripTrail(u: string): string {
  return u.replace(/[)"'.,]+$/, "");
}

/** When the same picture appears in multiple sizes, keep one (prefer larger) per classified-uuid+name. */
function dedupeByClassifiedSize(urls: string[]): string[] {
  const best = new Map<string, string>();
  for (const u of urls) {
    const key = u.replace(/\/\d+x\d+\//, "/SIZE/"); // collapse size segment
    const prev = best.get(key);
    if (!prev) best.set(key, u);
    else {
      const sz = (x: string) => { const m = x.match(/\/(\d+)x\d+\//); return m ? Number(m[1]) : 0; };
      if (sz(u) > sz(prev)) best.set(key, u);
    }
  }
  return Array.from(best.values());
}
