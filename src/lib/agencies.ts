import { readCache, writeCache } from "./cache.js";

/**
 * Agency-site discovery (the validated matcher path).
 *
 * OCR(sign) -> resolve agency BY PHONE -> fetch that agency's OWN listings ->
 * filter by GPS town -> hand a small candidate set to the facade vision-match.
 *
 * Phone is the stable key: the agency *name* OCR varies on stylized signs
 * ("De Simpel" / "Simons" / "Sinnaeve" are the same office), but the phone is
 * printed cleanly and is unique. We map known phones to known sites, and detect
 * the CRM so the right discovery adapter runs.
 *
 * Everything here is plain HTTPS (sitemaps, index pages, listing detail pages are
 * static HTML). No headless browser and no API keys are needed for discovery or
 * for harvesting the facade gallery. Portals (immoweb/zimmo) are NOT scraped:
 * they are bot-walled and legally risky, and they produced confident false
 * positives. Agency-site / Whise-API only.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export type Crm = "whise-sitemap" | "whise-wp" | "skarabee" | "unknown";

export interface AgencyInfo {
  name: string;
  /** bare domain, e.g. "immotijl.be" */
  domain: string;
  crm: Crm;
  /** normalized phone (digits, leading 0), the registry key */
  phone: string;
}

export interface AgencyListing {
  listingUrl: string;
  ref: string | null; // listing id from the URL
  type: string | null; // huis, appartement, bouwgrond, ...
  forSale: boolean; // te-koop (true) vs te-huur (false)
  town: string | null; // normalized (accent/space-stripped, lowercase)
  townLabel: string | null; // display form
  postcode: string | null;
  address: string | null; // filled by fetchListingDetail
  price: string | null; // filled by fetchListingDetail
  imageUrls: string[]; // facade gallery, filled by fetchListingDetail
}

/* ------------------------------ phone + town ------------------------------- */

/** Normalize a Belgian phone to digits with a leading 0. "+32 52 690 691" -> "052690691". */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = raw.replace(/\D+/g, "");
  if (d.startsWith("0032")) d = "0" + d.slice(4);
  else if (d.startsWith("32") && d.length >= 10 && !d.startsWith("320")) d = "0" + d.slice(2);
  if (!d.startsWith("0")) d = "0" + d;
  return d.length >= 8 ? d : null;
}

/** Normalize a town/municipality for comparison: lowercase, strip accents + separators. */
export function normalizeTown(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return t || null;
}

/* -------------------------------- registry --------------------------------- */

/**
 * Known agencies, keyed by phone. This is the phone -> site map the brief calls for.
 * Seeded from the validated proto set; extend as more agencies onboard (or migrate
 * Whise agencies to the Whise partner API once partner access lands).
 */
export const AGENCY_REGISTRY: AgencyInfo[] = [
  { name: "Immo Tijl", domain: "immotijl.be", crm: "whise-sitemap", phone: "052690691" },
  { name: "Immo Lot", domain: "immolot.be", crm: "whise-wp", phone: "093980000" },
  { name: "Vastgoed Sinnaeve", domain: "vastgoedsinnaeve.be", crm: "skarabee", phone: "0492975352" },
];

function registryByPhone(phone: string | null): AgencyInfo | null {
  if (!phone) return null;
  return AGENCY_REGISTRY.find((a) => a.phone === phone) ?? null;
}

function bareDomain(website: string | null | undefined): string | null {
  if (!website) return null;
  const d = website
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .split(/[/?#]/)[0]
    .trim()
    .toLowerCase();
  return /\.[a-z]{2,}$/.test(d) ? d : null;
}

/* ----------------------------- fetch + CRM sniff --------------------------- */

async function fetchText(url: string, timeoutMs = 20_000): Promise<string | null> {
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, "Accept-Language": "nl-BE,nl;q=0.9,en;q=0.8" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

/** Detect the CRM from a site's HTML signature. */
export function detectCrm(html: string): Crm {
  const h = html.toLowerCase();
  if (/skarabee/.test(h)) return "skarabee";
  if (/whise/.test(h)) {
    // Whise on a WordPress site embeds whise.eu storage images + an estate post type.
    if (/wp-content|wp-json|estatelist|estate_purpose/.test(h)) return "whise-wp";
    return "whise-sitemap";
  }
  return "unknown";
}

/**
 * Resolve the OCR'd sign to a concrete agency site.
 * Phone-first (registry), then the website printed on the sign (sniff its CRM).
 */
export async function resolveAgency(input: {
  phone?: string | null;
  name?: string | null;
  website?: string | null;
}): Promise<AgencyInfo | null> {
  const phone = normalizePhone(input.phone);
  const hit = registryByPhone(phone);
  if (hit) return hit;

  // Fallback: a website was printed on the sign -> sniff its CRM and use it.
  const domain = bareDomain(input.website);
  if (domain) {
    const html = (await fetchText(`https://${domain}/`)) || "";
    return {
      name: input.name?.trim() || domain,
      domain,
      crm: detectCrm(html),
      phone: phone || "",
    };
  }
  return null;
}

/* ------------------------------- adapters ---------------------------------- */

function sitemapLocs(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

/**
 * Whise via sitemap.xml (Immo Tijl). Individual listing URLs look like:
 *   https://www.immotijl.be/<type>-te-koop-in-<town>/<id>
 *   https://www.immotijl.be/<type>-te-huur-in-<town>/<id>   (rental, dropped)
 */
function whiseSitemapListings(domain: string, locs: string[]): AgencyListing[] {
  const re = new RegExp(
    `^https?://(?:www\\.)?${domain.replace(/\./g, "\\.")}/([a-z-]+)-te-(koop|huur)-in-([a-z0-9-]+)/(\\d{4,})/?$`,
    "i"
  );
  const out: AgencyListing[] = [];
  for (const url of locs) {
    const m = re.exec(url);
    if (!m) continue;
    const [, type, deal, townSlug, id] = m;
    out.push({
      listingUrl: url.replace(/\/$/, ""),
      ref: id,
      type,
      forSale: deal.toLowerCase() === "koop",
      town: normalizeTown(townSlug),
      townLabel: townSlug.replace(/-/g, " "),
      postcode: null,
      address: null,
      price: null,
      imageUrls: [],
    });
  }
  return out;
}

/**
 * Whise on WordPress (Immo Lot). The /te-koop/ page (and its pagination) carry
 * listing-detail links https://<domain>/te-koop/<id>/ in static HTML. Town is not
 * in the URL, so it is resolved later from the detail page.
 */
async function whiseWpListings(domain: string): Promise<AgencyListing[]> {
  const seenIds = new Set<string>();
  const out: AgencyListing[] = [];
  // Listing links may be absolute or root-relative ("/te-koop/<id>/").
  const idRe = new RegExp(`(?:https?://(?:www\\.)?${domain.replace(/\./g, "\\.")})?/te-koop/(\\d{5,})/?`, "gi");

  for (let page = 1; page <= 8; page++) {
    const url = page === 1 ? `https://${domain}/te-koop/` : `https://${domain}/te-koop/${page}/`;
    const html = await fetchText(url);
    if (!html) break;
    let added = 0;
    let m: RegExpExecArray | null;
    idRe.lastIndex = 0;
    while ((m = idRe.exec(html))) {
      const id = m[1];
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      added++;
      out.push({
        listingUrl: `https://${domain}/te-koop/${id}/`,
        ref: id,
        type: null,
        forSale: true,
        town: null,
        townLabel: null,
        postcode: null,
        address: null,
        price: null,
        imageUrls: [],
      });
    }
    if (added === 0) break; // no new listings on this page -> end of pagination
  }
  return out;
}

/**
 * Skarabee (Vastgoed Sinnaeve). sitemap.xml lists index pages; the full-offer page
 * carries listing-detail links:
 *   https://<domain>/nl/aanbod/<id>/<type>-te-koop-in-<zip>-<town>
 */
async function skarabeeListings(domain: string): Promise<AgencyListing[]> {
  const html =
    (await fetchText(`https://${domain}/nl/te-koop/volledig-aanbod-te-koop`)) ||
    (await fetchText(`https://${domain}/nl/te-koop`)) ||
    "";
  const re = new RegExp(
    `/nl/aanbod/(\\d+)/([a-z-]+)-te-(koop|huur)-in-(\\d{4})-([a-z0-9-]+)`,
    "gi"
  );
  const seen = new Set<string>();
  const out: AgencyListing[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const [full, id, type, deal, zip, townSlug] = m;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      listingUrl: `https://${domain}${full.startsWith("/") ? "" : "/"}${full}`,
      ref: id,
      type,
      forSale: deal.toLowerCase() === "koop",
      town: normalizeTown(townSlug),
      townLabel: townSlug.replace(/-/g, " "),
      postcode: zip,
      address: null,
      price: null,
      imageUrls: [],
    });
  }
  return out;
}

/** Run the right discovery adapter for an agency's CRM. */
async function discoverListings(agency: AgencyInfo): Promise<AgencyListing[]> {
  switch (agency.crm) {
    case "whise-sitemap": {
      const xml = (await fetchText(`https://${agency.domain}/sitemap.xml`)) || "";
      return whiseSitemapListings(agency.domain, sitemapLocs(xml));
    }
    case "whise-wp":
      return whiseWpListings(agency.domain);
    case "skarabee":
      return skarabeeListings(agency.domain);
    default: {
      // Unknown CRM: best-effort try the sitemap, then the WP page.
      const xml = (await fetchText(`https://${agency.domain}/sitemap.xml`)) || "";
      const fromSitemap = whiseSitemapListings(agency.domain, sitemapLocs(xml));
      if (fromSitemap.length) return fromSitemap;
      return whiseWpListings(agency.domain);
    }
  }
}

/**
 * Get an agency's for-sale listings, served from a daily cache.
 * The cache means a just-sold sign still matches yesterday's snapshot.
 */
export async function getAgencyListings(
  agency: AgencyInfo,
  opts: { refresh?: boolean; maxAgeDays?: number } = {}
): Promise<{ listings: AgencyListing[]; fromCache: boolean; date: string }> {
  if (!opts.refresh) {
    const cached = await readCache<AgencyListing>(agency.domain, opts.maxAgeDays ?? 3);
    if (cached && cached.listings.length) {
      return { listings: cached.listings, fromCache: true, date: cached.date };
    }
  }
  const listings = await discoverListings(agency);
  if (listings.length) {
    try {
      await writeCache(agency.domain, listings);
    } catch {
      // cache is an optimization; ignore write failures
    }
  }
  return { listings, fromCache: false, date: new Date().toISOString().slice(0, 10) };
}

/* ----------------------------- listing detail ------------------------------ */

const IMG_EXCLUDE =
  /logo|sprite|icon|favicon|placeholder|avatar|brand|badge|flag|pixel|blank|loader|spinner|representative|person|\/epc\b|epc\/|maps\.googleapis|gstatic|facebook|fbcdn|instagram/i;

function harvestImages(html: string, domain: string): string[] {
  const urls = new Set<string>();
  // Whise self-hosted gallery (immotijl): /images/property/photo/detail/...jpg
  const reqs = [
    new RegExp(`https?://(?:www\\.)?${domain.replace(/\./g, "\\.")}/images/property/photo/[a-z]+/[^"'\\s)]+\\.(?:jpe?g|webp)`, "gi"),
    // Whise CDN storage (immolot, and Whise-hosted galleries elsewhere)
    /https?:\/\/[a-z0-9.-]*whise\.eu\/[^"'\s)]+\.(?:jpe?g|webp)/gi,
    // Skarabee / generic CDN photos
    /https?:\/\/[^"'\s)]*\/(?:media|photos?|pictures?|storage|cdn|images?)\/[^"'\s)]+\.(?:jpe?g|webp)/gi,
  ];
  for (const re of reqs) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      const u = m[0];
      if (IMG_EXCLUDE.test(u)) continue;
      // Collapse @2x / thumbnail variants to one per base so the gallery is deduped.
      urls.add(u);
    }
  }
  // Dedup @2x variants by their base name.
  const byBase = new Map<string, string>();
  for (const u of urls) {
    const base = u.replace(/@2x(?=\.[a-z]+$)/i, "").split("?")[0];
    // prefer a larger ("detail"/no-thumb) variant if both seen
    const prev = byBase.get(base);
    if (!prev || /detail|\/640\/|\/800\/|\/1024\//.test(u)) byBase.set(base, u);
  }
  return [...byBase.values()];
}

const STREET =
  /([A-ZÉ][a-zà-üA-Zéëèïêç'.\- ]*?(?:straat|laan|steenweg|stwg|weg|baan|dreef|kaai|markt|plein|plaats|wijk|hof|pad|kouter|veld|berg|dijk|lei|ring|park|gracht|vest|kade|rij|dam|brug)\s*\d+\s*[a-zA-Z]?)\s*,?\s*(\d{4})\s+([A-Z][a-zà-ü\-\s]+?)\b/;

function parseAddress(html: string): string | null {
  // JSON-LD PostalAddress (Skarabee exposes ld+json)
  const ld = html.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of ld) {
    const raw = block.replace(/^[\s\S]*?>/, "").replace(/<\/script>$/i, "");
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
  const m = STREET.exec(html);
  return m ? `${m[1].trim()}, ${m[2]} ${m[3].trim()}` : null;
}

function parsePrice(html: string): string | null {
  // Decode the common euro/space entities first (immotijl renders "&euro;&nbsp;317.000").
  const decoded = html
    .replace(/&euro;|&#8364;|&#x20ac;/gi, "€")
    .replace(/&nbsp;|&#160;/gi, " ");
  const m = /€\s?[\d][\d.\s]{3,}\d/.exec(decoded);
  return m ? m[0].replace(/\s+/g, " ").trim() : null;
}

/** Fetch a listing's detail page and fill in address, price, and the facade gallery. */
export async function fetchListingDetail(listing: AgencyListing): Promise<AgencyListing> {
  const html = await fetchText(listing.listingUrl);
  if (!html) return listing;
  const domain = bareDomain(listing.listingUrl) || "";
  const images = harvestImages(html, domain);
  const address = parseAddress(html);
  return {
    ...listing,
    address: address ?? listing.address,
    price: parsePrice(html) ?? listing.price,
    imageUrls: images.length ? images.slice(0, 12) : listing.imageUrls,
    // Backfill town from the detected address when the slug did not carry it (immolot).
    town: listing.town ?? normalizeTown(address?.match(/\d{4}\s+([A-Za-zà-ü\- ]+)/)?.[1] ?? null),
    townLabel: listing.townLabel ?? (address?.match(/\d{4}\s+([A-Za-zà-ü\- ]+)/)?.[1]?.trim() ?? null),
    postcode: listing.postcode ?? (address?.match(/\b(\d{4})\b/)?.[1] ?? null),
  };
}

/** Filter a listing set to the for-sale ones in the given town. */
export function filterListings(
  listings: AgencyListing[],
  opts: { town?: string | null; type?: string | null } = {}
): AgencyListing[] {
  const town = normalizeTown(opts.town);
  return listings.filter((l) => {
    if (!l.forSale) return false;
    if (town && l.town && l.town !== town) return false;
    if (opts.type && l.type && l.type !== opts.type) return false;
    return true;
  });
}
