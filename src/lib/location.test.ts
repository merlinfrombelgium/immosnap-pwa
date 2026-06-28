import { test } from "node:test";
import assert from "node:assert/strict";
import { selectWorkingLocation, needsManualFallback, isValidLatLon } from "./location.js";

const A = { lat: 51.0373, lon: 4.1617 }; // Baasrode
const B = { lat: 50.9378, lon: 4.0397 }; // Aalst
const C = { lat: 51.05, lon: 4.2 };
const D = { lat: 51.2, lon: 4.4 };

test("isValidLatLon: finite non-zero is valid", () => {
  assert.equal(isValidLatLon(A), true);
});
test("isValidLatLon: null/undefined/0,0/NaN are invalid", () => {
  assert.equal(isValidLatLon(null), false);
  assert.equal(isValidLatLon(undefined), false);
  assert.equal(isValidLatLon({ lat: 0, lon: 0 }), false);
  assert.equal(isValidLatLon({ lat: NaN, lon: 4 }), false);
});

test("selectWorkingLocation: none available -> null (triggers manual entry)", () => {
  assert.equal(selectWorkingLocation({}), null);
  assert.equal(selectWorkingLocation({ exif: null, device: { lat: 0, lon: 0 } }), null);
});

test("selectWorkingLocation: device GPS used when it's the only source", () => {
  assert.deepEqual(selectWorkingLocation({ device: A }), { coords: A, source: "device" });
});

test("selectWorkingLocation: photo EXIF beats device GPS", () => {
  assert.deepEqual(selectWorkingLocation({ exif: A, device: B }), { coords: A, source: "photo" });
});

test("selectWorkingLocation: manual address beats EXIF and device", () => {
  assert.deepEqual(
    selectWorkingLocation({ manual: C, exif: A, device: B }),
    { coords: C, source: "manual" }
  );
});

test("selectWorkingLocation: a placed pin wins over everything (the modal override)", () => {
  assert.deepEqual(
    selectWorkingLocation({ pin: D, manual: C, exif: A, device: B }),
    { coords: D, source: "pin" }
  );
});

test("selectWorkingLocation: invalid higher-priority source is skipped", () => {
  assert.deepEqual(
    selectWorkingLocation({ pin: { lat: 0, lon: 0 }, manual: null, exif: A }),
    { coords: A, source: "photo" }
  );
});

test("needsManualFallback: true only when neither photo nor device gave a location", () => {
  assert.equal(needsManualFallback(null, null), true);
  assert.equal(needsManualFallback({ lat: 0, lon: 0 }, undefined), true);
  assert.equal(needsManualFallback(A, null), false);
  assert.equal(needsManualFallback(null, B), false);
});
