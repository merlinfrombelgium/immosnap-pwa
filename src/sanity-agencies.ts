/**
 * No-keys discovery sanity check for the agency-site matcher.
 *
 * This proves the DISCOVERY half of the acceptance gate without any API keys or
 * headless browser: given Immo Tijl (resolved by phone) + town Dendermonde, the
 * acceptance listing 7523945 must appear in the for-sale candidate set, and its
 * detail page must yield the Rosstraat address + a non-empty facade gallery.
 *
 * The FULL gate ("resolves to 7523945", i.e. ranked top) additionally needs the
 * Gemini facade vision-match, which requires GEMINI_API_KEY. That is covered by
 * the end-to-end `match`/`server` path, not here.
 *
 * Run: npm run sanity:agencies
 */
import {
  AGENCY_REGISTRY,
  fetchListingDetail,
  filterListings,
  getAgencyListings,
  resolveAgency,
} from "./lib/agencies.js";

const GATE_ID = "7523945";
const GATE_TOWN = "Dendermonde";
const GATE_PHONE = "052 690 691"; // Immo Tijl, as OCR'd off the sign

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  console.log("=== ImmoSnap agency-site discovery sanity (no keys) ===\n");

  // 1. Phone -> agency resolution (the stable key).
  const agency = await resolveAgency({ phone: GATE_PHONE, name: "IMMOTIJL" });
  check("resolve agency by phone", agency?.domain === "immotijl.be", agency ? `${agency.name} / ${agency.domain} / ${agency.crm}` : "no agency");
  if (!agency) return finish();

  // 2. Discovery: pull the agency's listings (cached daily).
  const { listings, fromCache, date } = await getAgencyListings(agency);
  check("discovered listings", listings.length > 0, `${listings.length} listings (cache=${fromCache}, ${date})`);

  // 3. Town filter -> small candidate set.
  const candidates = filterListings(listings, { town: GATE_TOWN });
  check("for-sale candidates in town", candidates.length > 0, `${candidates.length} for-sale in ${GATE_TOWN}`);

  // 4. ACCEPTANCE GATE (discovery half): the listing must be in the candidate set.
  const gate = candidates.find((c) => c.ref === GATE_ID);
  check(`acceptance listing ${GATE_ID} in candidate set`, !!gate, gate ? gate.listingUrl : "NOT FOUND");

  // 5. Detail fetch: address + facade gallery for the gate listing.
  if (gate) {
    const detail = await fetchListingDetail(gate);
    check("gate detail address = Rosstraat/Dendermonde", /rosstraat/i.test(detail.address || ""), detail.address || "no address");
    check("gate detail has facade gallery", detail.imageUrls.length > 0, `${detail.imageUrls.length} images, first: ${detail.imageUrls[0] || "none"}`);
  }

  // 6. Smoke the other two agencies (non-fatal — they widen the demo, not the gate).
  console.log("\n--- other agencies (informational) ---");
  const others: Record<string, Awaited<ReturnType<typeof getAgencyListings>>> = {};
  for (const a of AGENCY_REGISTRY.filter((x) => x.domain !== "immotijl.be")) {
    try {
      const res = await getAgencyListings(a, { refresh: true });
      others[a.domain] = res;
      const sale = res.listings.filter((l) => l.forSale);
      const withImgs = res.listings.filter((l) => l.imageUrls.length).length;
      console.log(`  ${a.name} (${a.crm}): ${res.listings.length} listings, ${sale.length} for-sale, ${withImgs} with images, sample: ${sale[0]?.listingUrl || "none"}`);
    } catch (e) {
      console.log(`  ${a.name}: error ${(e as Error).message}`);
    }
  }

  // 7. Regression guards for the Whise-on-WordPress case (Immo Lot):
  const lot = others["immolot.be"];
  if (lot) {
    check("immolot has facade galleries", lot.listings.some((l) => l.imageUrls.length > 0), `${lot.listings.filter((l) => l.imageUrls.length).length} of ${lot.listings.length} with images`);
    // Town is not in immolot static HTML; a town filter must NOT empty the set.
    const narrowed = filterListings(lot.listings, { town: "Dendermonde" });
    check("immolot town filter does not false-empty", narrowed.length > 0, `${narrowed.length} returned (town unknown -> all for-sale)`);
  }

  finish();
}

function finish() {
  console.log(`\n=== ${failures === 0 ? "ALL DISCOVERY CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("sanity-agencies crashed:", e);
  process.exit(1);
});
