import { test } from "node:test";
import assert from "node:assert/strict";
import { proximityVerdict } from "./matcher.js";

test("proximityVerdict: empty -> none", () => {
  assert.equal(proximityVerdict([]), "none");
});
test("proximityVerdict: very close -> confident", () => {
  assert.equal(proximityVerdict([30, 800]), "confident");
});
test("proximityVerdict: down-the-street but clearly nearest -> confident", () => {
  // his real case: ~340m to Rosstraat 6, next candidate far away
  assert.equal(proximityVerdict([340, 1200]), "confident");
});
test("proximityVerdict: two plausible neighbours -> candidates", () => {
  assert.equal(proximityVerdict([340, 500]), "candidates");
});
test("proximityVerdict: far with no clear winner -> candidates", () => {
  assert.equal(proximityVerdict([900, 1100]), "candidates");
});
