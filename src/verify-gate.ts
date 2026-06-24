/**
 * Hard acceptance-gate verifier.
 *
 * Runs the full matcher on the gate photo and asserts it RESOLVES to the
 * ground-truth listing 7523945 (Rosstraat 6, Dendermonde) ranked #1 with a
 * confident facade match. This is the end-to-end gate, not the discovery-only
 * check in sanity-agencies.
 *
 * Note: the gate is reachable WITHOUT the `(1)` GPS photo copy. The sign in the
 * repo's PXL_20260224_171834897.jpg is identical; we supply the town directly
 * (--town Dendermonde) instead of relying on EXIF GPS reverse-geocode, so the
 * ONLY external dependency is GEMINI_API_KEY (sign OCR + facade vision-match).
 *
 * Run: npm run verify:gate
 * Exit: 0 = gate PASS, 1 = gate FAIL (ran but wrong result), 2 = could not run
 *       (missing key / network) so the blocker is unambiguous.
 */
import { readFile } from "node:fs/promises";
import { matchImage } from "./lib/matcher.js";
import { ENV } from "./lib/env.js";

const GATE_IMAGE = "proto/PXL_20260224_171834897.jpg";
const GATE_TOWN = "Dendermonde";
const GATE_REF = "7523945";
const GATE_URL = "immotijl.be/.../7523945";

async function main() {
  if (!ENV.GEMINI_API_KEY) {
    console.error("BLOCKER: GEMINI_API_KEY missing (needed for sign OCR + facade vision-match).");
    console.error("Drop proto/.env with GEMINI_API_KEY, then re-run `npm run verify:gate`.");
    process.exit(2);
  }

  console.log(`=== Gate verify: ${GATE_IMAGE} must resolve to ${GATE_URL} ===\n`);
  const imageBuffer = await readFile(GATE_IMAGE);

  let result;
  try {
    // maxCandidates high so the full ranked set is visible; town supplied directly.
    result = await matchImage({ imageBuffer, town: GATE_TOWN, maxCandidates: 60 });
  } catch (e) {
    console.error(`BLOCKER: matcher could not run: ${(e as Error).message}`);
    process.exit(2);
  }

  console.log(`OCR agency: ${result.agency} | phone: ${result.phone}`);
  console.log(`town: ${result.town} (source: ${result.debug.townSource}) | crm: ${result.debug.crm}`);
  console.log(`candidates evaluated: ${result.debug.candidatesEvaluated} | matchKind: ${result.matchKind}\n`);

  const top = result.candidates[0];
  const rank = result.candidates.findIndex((c) => c.ref === GATE_REF);

  result.candidates.slice(0, 5).forEach((c, i) => {
    const mark = c.ref === GATE_REF ? "  <== GATE" : "";
    console.log(`  #${i + 1}  ${c.confidence}%  ${c.ref}  ${c.address || c.listingUrl}${mark}`);
  });

  const topIsGate = top?.ref === GATE_REF;
  const confident = result.matchKind === "confident";
  console.log("");
  console.log(`gate listing in set:       ${rank >= 0 ? `yes (rank #${rank + 1})` : "NO"}`);
  console.log(`top candidate is gate:     ${topIsGate ? "yes" : "no"}`);
  console.log(`confident match:           ${confident ? "yes" : "no"}`);

  if (topIsGate && confident) {
    console.log("\n=== GATE PASS: resolves to 7523945, ranked #1, confident. ===");
    process.exit(0);
  }
  console.log("\n=== GATE FAIL: did not resolve to 7523945 as a confident #1. ===");
  process.exit(1);
}

main().catch((e) => {
  console.error("verify-gate crashed:", e);
  process.exit(2);
});
