import exifr from "exifr";
import { ENV } from "./env.js";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface GpsResult { lat: number; lon: number }

/** Read EXIF GPS from an image. Returns null when absent or invalid (e.g. NaN fields). */
export async function readExifGps(imagePath: string): Promise<GpsResult | null> {
  try {
    const gps = await exifr.gps(imagePath);
    if (gps && Number.isFinite(gps.latitude) && Number.isFinite(gps.longitude) && (gps.latitude !== 0 || gps.longitude !== 0)) {
      return { lat: gps.latitude, lon: gps.longitude };
    }
  } catch { /* ignore */ }
  return null;
}

export interface GeoResult { town: string | null; postcode: string | null; formatted: string | null }

/** Parse a Google reverse-geocode JSON payload into town/postcode/formatted.
 * Pure (no network) so the resolved-address path is unit-testable. The most
 * specific result (results[0], typically street_address) carries the full
 * address_components breakdown, so town + postcode still resolve from it. */
export function parseReverseGeocode(data: any): GeoResult {
  const out: GeoResult = { town: null, postcode: null, formatted: null };
  const r = data?.results?.[0];
  if (r) {
    out.formatted = r.formatted_address || null;
    for (const c of r.address_components || []) {
      const types: string[] = c.types || [];
      if (!out.town && types.includes("locality")) out.town = c.long_name;
      if (!out.town && types.includes("postal_town")) out.town = c.long_name;
      if (types.includes("postal_code")) out.postcode = c.long_name;
    }
  }
  return out;
}

/** Reverse-geocode lat/lon via Google Maps Geocoding API → street-level address
 * (formatted) plus town + postcode. No result_type restriction so the resolved
 * `formatted` is the precise property address shown after dropping a pin. */
export async function reverseGeocode(lat: number, lon: number): Promise<GeoResult> {
  const key = ENV.MAPS_API_KEY;
  if (!key) throw new Error("MAPS_API_KEY missing");
  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lon}&language=nl&key=${key}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const data: any = await res.json();
  return parseReverseGeocode(data);
}


/** Great-circle distance in metres. */
export function haversineMeters(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371000;
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLa = rad(bLat - aLat);
  const dLo = rad(bLon - aLon);
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLo / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/** Build the Google forward-geocode request URL for a free-text address.
 * Pure + biased to Belgium (region=be, and a ", Belgium" suffix when the typed
 * address doesn't already name the country) so manual entry resolves locally. */
export function buildForwardGeocodeUrl(address: string, key: string): string {
  const q = encodeURIComponent(/belg/i.test(address) ? address : address + ", Belgium");
  return `https://maps.googleapis.com/maps/api/geocode/json?address=${q}&region=be&key=${key}`;
}

/** Parse a Google forward-geocode JSON payload into lat/lon (or null). Pure. */
export function parseForwardGeocode(data: any): GpsResult | null {
  const hit = data?.results?.[0];
  return hit ? { lat: hit.geometry.location.lat, lon: hit.geometry.location.lng } : null;
}

/* Forward-geocode a street address -> lat/lon via the GOOGLE Geocoding API.
 * Disk-cached (addresses are stable) so repeat lookups are free. Used by both
 * the listing-ranking path and the manual-address-entry endpoint (GET /geocode). */
const GEO_CACHE = resolve(process.cwd(), ".geocode-cache.json");
let _geoCache: Record<string, GpsResult | null> | null = null;
function loadGeoCache(): Record<string, GpsResult | null> {
  if (_geoCache) return _geoCache;
  try { _geoCache = JSON.parse(readFileSync(GEO_CACHE, "utf8")); } catch { _geoCache = {}; }
  return _geoCache!;
}
function saveGeoCache(): void { try { writeFileSync(GEO_CACHE, JSON.stringify(_geoCache)); } catch { /* ignore */ } }
export async function geocodeAddress(address: string | null): Promise<GpsResult | null> {
  if (!address) return null;
  const key = address.trim().toLowerCase();
  const cache = loadGeoCache();
  if (key in cache) return cache[key];
  try {
    const apiKey = ENV.MAPS_API_KEY;
    if (!apiKey) throw new Error("MAPS_API_KEY missing");
    const url = buildForwardGeocodeUrl(address, apiKey);
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const data: any = await res.json();
    const out = parseForwardGeocode(data);
    if (out) { cache[key] = out; saveGeoCache(); }
    return out;
  } catch {
    return null;
  }
}


/* Reverse-geocode lat/lon -> locality via free Nominatim (OSM, no key).
 * Prefers village/suburb/hamlet (Belgian deelgemeente, e.g. "Baasrode") over the
 * parent municipality ("Dendermonde") so it matches per-deelgemeente listing slugs. */
export async function reverseGeocodeOSM(lat: number, lon: number): Promise<{ town: string | null; postcode: string | null }> {
  try {
    const apiKey = ENV.MAPS_API_KEY;
    if (!apiKey) return { town: null, postcode: null };
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lon}&language=nl&key=${apiKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const d: any = await res.json();
    const comps = d?.results?.[0]?.address_components || [];
    let town: string | null = null; let postcode: string | null = null;
    for (const c of comps) {
      if (!town && (c.types.includes("sublocality") || c.types.includes("locality"))) town = c.long_name;
      if (c.types.includes("postal_code")) postcode = c.long_name;
    }
    return { town, postcode };
  } catch {
    return { town: null, postcode: null };
  }
}
