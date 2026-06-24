import { renderPage } from "../lib/browser.js";
import { ListingDetail } from "./immoweb.js";

const STREET_SUFFIX = /(straat|laan|steenweg|weg|baan|dreef|kaai|markt|plein|wijk|hoek|kouter|veld|berg|dam|pad|lei|kerkhof|heide|akker|hof|park|dijk)/i;

export interface SpottoCard {
  url: string;
  address: string | null;
  type: string | null;
}

/** Parse address + type out of a spotto listing URL path. */
export function parseSpottoUrl(url: string): { address: string | null; type: string | null; town: string | null; postcode: string | null } {
  // /nl/p/te-koop/9200-dendermonde-baasrode/huis-sint-ursmarusstraat-12-14-met-4-kamers.../<id>
  const m = url.match(/\/nl\/p\/(?:te-koop|te-huur)\/(\d{4})-([a-z-]+?)\/([a-z]+)-(.+?)(?:\/[A-Za-z0-9_-]{18,})?$/i);
  if (!m) return { address: null, type: null, town: null, postcode: null };
  const postcode = m[1];
  const townSlug = m[2];
  const type = m[3];
  let rest = m[4];
  // drop trailing descriptors after "met"
  rest = rest.split(/-met-/)[0];
  const town = townSlug.split("-").map(cap).join(" ");
  // street = words until a number token; keep number
  const parts = rest.split("-");
  const streetWords: string[] = [];
  let number = "";
  for (const p of parts) {
    if (/^\d+[a-z]?$/i.test(p) && streetWords.length > 0) { number = p; break; }
    streetWords.push(p);
  }
  const street = streetWords.map(cap).join(" ");
  const address = [street + (number ? " " + number : ""), `${postcode} ${town}`].filter(Boolean).join(", ");
  return { address, type, town, postcode };
}

function cap(s: string): string { return s ? s[0].toUpperCase() + s.slice(1) : s; }

/** Render a spotto makelaar page → its listing cards (url + address parsed from path). */
export async function resolveSpottoMakelaar(makelaarUrl: string): Promise<SpottoCard[]> {
  const { html } = await renderPage(makelaarUrl, { settle: 3500, retries: 3, timeout: 50_000, scroll: 8 });
  const urls = new Set<string>();
  for (const m of html.matchAll(/\/nl\/p\/(?:te-koop|te-huur)\/[a-z0-9-]+\/[a-z0-9-]+\/[A-Za-z0-9_-]{18,}/gi)) {
    urls.add("https://www.spotto.be" + m[0]);
  }
  // some links lack the trailing id segment; also accept slug-only and let detail page redirect
  for (const m of html.matchAll(/\/nl\/p\/(?:te-koop|te-huur)\/\d{4}-[a-z-]+\/[a-z]+-[a-z0-9-]+/gi)) {
    urls.add("https://www.spotto.be" + m[0]);
  }
  const cards: SpottoCard[] = [];
  const seenAddr = new Set<string>();
  for (const u of urls) {
    const p = parseSpottoUrl(u);
    const key = p.address || u;
    if (seenAddr.has(key)) continue;
    seenAddr.add(key);
    cards.push({ url: u, address: p.address, type: p.type });
  }
  return cards;
}

/** Render a spotto listing page → detail (images via immo-connect CDN, address from path). */
export async function getSpottoListing(url: string): Promise<ListingDetail> {
  const { html } = await renderPage(url, { settle: 3500, retries: 3, timeout: 50_000, scroll: 5 });
  const parsed = parseSpottoUrl(url);
  const uuids = Array.from(
    new Set((html.match(/file\.immo-connect\.be\/image\/([a-f0-9-]{36})/gi) || []).map((s) => s.split("/image/")[1]))
  );
  const images = uuids.map((u) => `https://file.immo-connect.be/image/${u}?width=1024&fileformat=jpeg`);
  const sold = /verkocht|verhuurd|onder\s*bod|in\s*optie|sold/i.test(html);
  const price = html.match(/€\s?([\d.]{4,})/)?.[1] || null;
  return {
    url,
    address: parsed.address,
    town: parsed.town,
    postcode: parsed.postcode,
    price: price ? "€ " + price : null,
    images,
    primaryImage: images[0] || null,
    source: "spotto" as any,
    ...(sold ? { sold: true } : {}),
  } as ListingDetail & { sold?: boolean };
}

export { STREET_SUFFIX };
