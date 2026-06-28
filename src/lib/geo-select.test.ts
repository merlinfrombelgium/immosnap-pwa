import { test } from "node:test";
import assert from "node:assert/strict";
import { nearestLabel } from "./matcher.js";

const BAASRODE = { label: "baasrode", lat: 51.0373, lon: 4.1617 };
const DENDERMONDE = { label: "dendermonde", lat: 51.0259, lon: 4.1015 }; // ~5km
const AALST = { label: "aalst", lat: 50.9378, lon: 4.0397 };            // ~15km

test("nearestLabel: empty -> null", () => {
  assert.equal(nearestLabel({ lat: 51, lon: 4 }, []), null);
});

test("nearestLabel: GPS in Baasrode picks 'baasrode', NOT the Dendermonde municipality (the bug)", () => {
  // photographer down the street from Rosstraat 6
  assert.equal(nearestLabel({ lat: 51.0343, lon: 4.1605 }, [BAASRODE, DENDERMONDE, AALST]), "baasrode");
});

test("nearestLabel: GPS near Aalst picks 'aalst'", () => {
  assert.equal(nearestLabel({ lat: 50.94, lon: 4.04 }, [BAASRODE, DENDERMONDE, AALST]), "aalst");
});
