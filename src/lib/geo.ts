import exifr from "exifr";
import { ENV } from "./env.js";

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

/** Reverse-geocode lat/lon via Google Maps Geocoding API → town + postcode. */
export async function reverseGeocode(lat: number, lon: number): Promise<GeoResult> {
  const key = ENV.MAPS_API_KEY;
  if (!key) throw new Error("MAPS_API_KEY missing");
  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lon}&language=nl&result_type=locality|postal_code&key=${key}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const data: any = await res.json();
  const out: GeoResult = { town: null, postcode: null, formatted: null };
  const r = data.results?.[0];
  if (r) {
    out.formatted = r.formatted_address || null;
    for (const c of r.address_components || []) {
      if (c.types.includes("locality")) out.town = c.long_name;
      if (c.types.includes("postal_code")) out.postcode = c.long_name;
    }
  }
  return out;
}
