import { test } from "node:test";
import assert from "node:assert/strict";
import { buildForwardGeocodeUrl, parseForwardGeocode, parseReverseGeocode } from "./geo.js";

// ── Manual-address geocode path (GET /geocode?q= -> geocodeAddress) ──────────

test("buildForwardGeocodeUrl: hits the GOOGLE geocoding host, never Nominatim", () => {
  const url = buildForwardGeocodeUrl("Rosstraat 6, Baasrode", "KEY123");
  assert.ok(url.startsWith("https://maps.googleapis.com/maps/api/geocode/json"));
  assert.ok(!/nominatim|openstreetmap/i.test(url));
  assert.ok(url.includes("region=be"));
  assert.ok(url.includes("key=KEY123"));
});

test("buildForwardGeocodeUrl: appends ', Belgium' when the address omits the country", () => {
  const url = buildForwardGeocodeUrl("Grote Markt 1, Dendermonde", "K");
  assert.ok(decodeURIComponent(url).includes("Grote Markt 1, Dendermonde, Belgium"));
});

test("buildForwardGeocodeUrl: does NOT double-append when 'Belgium' is already present", () => {
  const url = buildForwardGeocodeUrl("Some Street, Belgium", "K");
  const decoded = decodeURIComponent(url);
  assert.equal((decoded.match(/Belgium/gi) || []).length, 1);
});

test("parseForwardGeocode: extracts lat/lon from a Google forward-geocode payload", () => {
  const sample = {
    status: "OK",
    results: [{ geometry: { location: { lat: 51.0373247, lng: 4.1617184 } } }],
  };
  assert.deepEqual(parseForwardGeocode(sample), { lat: 51.0373247, lon: 4.1617184 });
});

test("parseForwardGeocode: empty / ZERO_RESULTS -> null (so /geocode returns 404)", () => {
  assert.equal(parseForwardGeocode({ status: "ZERO_RESULTS", results: [] }), null);
  assert.equal(parseForwardGeocode({}), null);
  assert.equal(parseForwardGeocode(null), null);
});

// ── Drop-pin reverse-geocode path (GET /reverse -> reverseGeocode) ───────────

test("parseReverseGeocode: street-level result yields formatted + town + postcode", () => {
  const sample = {
    status: "OK",
    results: [
      {
        formatted_address: "Rosstraat 6, 9200 Baasrode, Belgium",
        address_components: [
          { long_name: "6", types: ["street_number"] },
          { long_name: "Rosstraat", types: ["route"] },
          { long_name: "Baasrode", types: ["locality", "political"] },
          { long_name: "9200", types: ["postal_code"] },
        ],
      },
    ],
  };
  const out = parseReverseGeocode(sample);
  assert.equal(out.formatted, "Rosstraat 6, 9200 Baasrode, Belgium");
  assert.equal(out.town, "Baasrode");
  assert.equal(out.postcode, "9200");
});

test("parseReverseGeocode: no results -> all null", () => {
  assert.deepEqual(parseReverseGeocode({ results: [] }), {
    town: null,
    postcode: null,
    formatted: null,
  });
});
