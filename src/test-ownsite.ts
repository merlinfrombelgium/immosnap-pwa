/**
 * Resolve harness for the agency own-site adapter (sibling of test-resolve.ts).
 *
 *   npx tsx src/test-ownsite.ts woonvast   # acceptance gate
 *   npx tsx src/test-ownsite.ts era
 *   npx tsx src/test-ownsite.ts berno
 *   npx tsx src/test-ownsite.ts all
 *
 * Acceptance: resolveCandidates({agency:"Woonvast", town:"Opwijk"}) must include
 *   https://www.woonvast.be/detail/te-koop-woning-opwijk/7476661
 */
import { resolveCandidates, type Candidate } from "./lib/portals.js";
import { closeBrowser } from "./lib/browser.js";

const ACCEPT_URL = "https://www.woonvast.be/detail/te-koop-woning-opwijk/7476661";
const norm = (u: string) =>
  u.replace(/^http:/i, "https:").replace(/\/\/www\./i, "//").replace(/\/+$/, "").toLowerCase();

async function run(agency: string, town: string, website: string | null, max: number): Promise<Candidate[]> {
  console.log(`\n=== resolveCandidates(agency="${agency}", town="${town}", website=${website ?? "null"}, max=${max}) ===`);
  const t0 = Date.now();
  const cands = await resolveCandidates({ agency, town, website }, { maxCandidates: max });
  console.log(`candidates: ${cands.length}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  for (const c of cands) {
    console.log(`  [${c.source}] ${c.listingUrl}`);
    console.log(`       addr=${c.address ?? "—"} | price=${c.price ?? "—"} | imgs=${c.allImageUrls.length} | facade=${c.facadeImageUrl ? "yes" : "no"}`);
  }
  const own = cands.filter((c) => c.source === "agency");
  console.log(`  own-site candidates: ${own.length} / ${cands.length}`);
  return cands;
}

async function main() {
  const which = (process.argv[2] || "all").toLowerCase();
  let fail = 0;

  if (which === "woonvast" || which === "all") {
    const cands = await run("Woonvast", "Opwijk", "https://www.woonvast.be", 10);
    const hit = cands.find((c) => norm(c.listingUrl) === norm(ACCEPT_URL));
    console.log(`\nACCEPTANCE (Woonvast 7476661 in candidate set): ${hit ? "PASS ✅" : "FAIL ❌"}`);
    if (hit) console.log("  " + JSON.stringify({ url: hit.listingUrl, source: hit.source, address: hit.address, price: hit.price, imgs: hit.allImageUrls.length, facade: hit.facadeImageUrl }, null, 2));
    else fail++;
  }

  if (which === "era" || which === "all") {
    const cands = await run("Era", "Aalst", "https://www.era.be", 8);
    console.log(`SPOT-CHECK Era own-site candidates: ${cands.filter((c) => c.source === "agency").length} (informational)`);
  }

  if (which === "berno" || which === "all") {
    const cands = await run("Berno", "Sint-Niklaas", "https://www.berno.be", 8);
    console.log(`SPOT-CHECK Berno own-site candidates: ${cands.filter((c) => c.source === "agency").length} (informational)`);
  }

  await closeBrowser();
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error("ERR", e); process.exit(1); });
