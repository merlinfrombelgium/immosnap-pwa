/**
 * Working-location selection (pure, shared rules).
 *
 * Both new features — manual address entry and the drop-pin map modal — converge
 * on ONE "working location" that feeds the existing /match call. This module is
 * the single source of truth for HOW that one location is chosen from the several
 * possible inputs, and WHEN we must fall back to asking the user to type an
 * address. The browser (public/app.js) mirrors these same precedence rules.
 */

export type LocationSource = "photo" | "device" | "manual" | "pin";

export interface LatLon { lat: number; lon: number }

export interface LocationSources {
  /** A point the user explicitly placed/confirmed in the map modal. */
  pin?: LatLon | null;
  /** A point resolved from a manually typed address (Google forward-geocode). */
  manual?: LatLon | null;
  /** GPS read from the photo's EXIF metadata. */
  exif?: LatLon | null;
  /** GPS read from the device (navigator.geolocation). */
  device?: LatLon | null;
}

/** A lat/lon is usable when both fields are finite and it isn't the 0,0 null-island. */
export function isValidLatLon(c?: LatLon | null): c is LatLon {
  return (
    !!c &&
    Number.isFinite(c.lat) &&
    Number.isFinite(c.lon) &&
    (c.lat !== 0 || c.lon !== 0)
  );
}

/**
 * Choose the single working location, in priority order:
 *   1. pin    — the most deliberate signal: the user dragged/placed it themselves
 *   2. manual — an address the user typed on purpose
 *   3. photo  — EXIF GPS baked into the image
 *   4. device — live device GPS
 * Returns null when none is usable (→ the UI offers manual entry).
 */
export function selectWorkingLocation(
  sources: LocationSources
): { coords: LatLon; source: LocationSource } | null {
  if (isValidLatLon(sources.pin)) return { coords: sources.pin, source: "pin" };
  if (isValidLatLon(sources.manual)) return { coords: sources.manual, source: "manual" };
  if (isValidLatLon(sources.exif)) return { coords: sources.exif, source: "photo" };
  if (isValidLatLon(sources.device)) return { coords: sources.device, source: "device" };
  return null;
}

/**
 * Whether to surface the manual-address fallback prominently: true when NEITHER
 * the photo EXIF NOR the device produced a usable location. (Pin/manual are only
 * ever set as a result of the user acting, so they don't suppress the prompt.)
 */
export function needsManualFallback(exif?: LatLon | null, device?: LatLon | null): boolean {
  return !isValidLatLon(exif) && !isValidLatLon(device);
}
