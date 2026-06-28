import { test } from "node:test";
import assert from "node:assert/strict";
import { haversineMeters } from "./geo.js";
import { confidenceFromDistance } from "./matcher.js";

test("haversineMeters: identical points = 0", () => {
  assert.equal(haversineMeters(51.0373, 4.1617, 51.0373, 4.1617), 0);
});

test("haversineMeters: ~12m photo->Rosstraat 6", () => {
  const d = haversineMeters(51.03725, 4.16185, 51.0373247, 4.1617184);
  assert.ok(d >= 5 && d <= 25, `expected ~12m, got ${d}`);
});

test("haversineMeters: ~1.1km Rosstraat->Broekstraat 68", () => {
  const d = haversineMeters(51.0373247, 4.1617184, 51.0397085, 4.1457079);
  assert.ok(d >= 1000 && d <= 1300, `expected ~1.1km, got ${d}`);
});

test("confidenceFromDistance: distance buckets", () => {
  assert.equal(confidenceFromDistance(0), 97);
  assert.equal(confidenceFromDistance(40), 97);
  assert.equal(confidenceFromDistance(80), 92);
  assert.equal(confidenceFromDistance(150), 85);
  assert.equal(confidenceFromDistance(300), 72);
  assert.equal(confidenceFromDistance(600), 55);
  assert.equal(confidenceFromDistance(1200), 30);
  assert.equal(confidenceFromDistance(1201), 10);
});

test("confidenceFromDistance: nearer always beats farther (the fix)", () => {
  assert.ok(confidenceFromDistance(12) > confidenceFromDistance(900));
});
