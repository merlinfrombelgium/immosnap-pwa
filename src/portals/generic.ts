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
