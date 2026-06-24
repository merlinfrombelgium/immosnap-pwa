# ImmoSnap — Engineer Brief (real matcher implementation)

You're picking up **ImmoSnap**, a ZiMi product. Read this fully before touching code. It captures hard-won validation so you don't repeat dead ends.

## 1. What it is / the goal
A PWA: **photograph a real-estate "TE KOOP" (for-sale) sign → identify the exact property listing.** Works on phone (field) and laptop (demo). Tonight there's a show-and-tell in a builder community, so the deployed demo must keep working.

## 2. What's built (this repo)
- **Stack:** Node + Hono backend (`src/server.ts`, `POST /match` taking multipart `image` + optional `lat`/`lon`), vanilla installable PWA frontend (`public/`), TypeScript.
- **Pipeline today:** upload/capture → OCR via **Gemini `gemini-3.5-flash`** reads agency name + phone off the sign (`src/lib/gemini.ts`) → client reads **EXIF GPS** with exifr → reverse-geocode (Google Maps) → town → find that agency's listings → facade vision-match (Gemini) → ranked candidates.
- **Libs:** `src/lib/{gemini,browser,env}.ts`, `src/portals/immoweb.ts`. `src/lib/browser.ts` drives a homelab **Browserless** for JS rendering.
- **Deployed:** `https://immosnap.merlinfrombelgium.com` (runs on code-machine, behind a Cloudflare tunnel). Run locally: put keys in `proto/.env`, `npm install`, `npm run start` → `http://localhost:3001`.
- **Keys (in `proto/.env`, gitignored — Merlo provides):** `GEMINI_API_KEY`, `MAPS_API_KEY` (Vision API enabled on it), `SERPAPI_KEY`, `BROWSERLESS_URL`, `BROWSERLESS_TOKEN`.

## 3. Dead ends — DO NOT redo these (validated, conclusive)
- **Reverse-image search is dead as the matcher.** SerpApi Google Lens AND Google Vision web-detection both return ZERO matching pages for the user's own camera photos. Fundamental: the user's fresh photo isn't on the web, and listings use the agency's own different photos. Don't build on it.
- **Portal scraping (immoweb/zimmo) is wrong** — bot-walled, JS-rendered, AND legally risky in the EU (sui generis database right + photo copyright + ToS). Do not scrape portals.
- **The current discovery code (SerpApi/portal-based) produces confident FALSE POSITIVES** (e.g. matched an Aalst listing to a Dendermonde property at 75%). That's the thing you are replacing. The UI currently hides the confidence number to avoid showing a confident wrong answer.

## 4. What WORKS — validated on 4 real photos with ground truth
- **GPS → exact town: bulletproof** (all 4 pinned the right street).
- **OCR agency + phone: reliable** — but the agency *name* OCR varies on stylized signs (one sign read as "De Simpel" / "Simons" / "Sinnaeve"). **The phone number is the stable key.** Resolve agency by PHONE (phone → agency → website), not the OCR'd name.
- **The winning discovery: agency's OWN site → listings filtered by GPS town → small candidate set → facade vision-match.** Proven: GPS+agency found `immotijl.be/huis-te-koop-in-dendermonde/7523945` (Rosstraat 6) — the exact ground-truth listing — straight from the agency sitemap. Candidate sets are tiny (single/low-double digits per town), so vision-match is easy.

## 5. The implementation task
Replace the SerpApi/portal discovery with the validated path:
**OCR (phone+agency) → resolve agency site by phone → fetch that agency's listings → filter by GPS town → facade vision-match → ranked candidates (no confident false positives).**

Key requirements:
- **Per-CRM adapters** (discovery shape differs):
  - Immo Tijl (**Whise**): `sitemap.xml` lists individual listing URLs.
  - Immo Lot (**Whise**): sitemap is near-empty; listings live on the `/te-koop/` page.
  - Vastgoed Sinnaeve (**Skarabee**): `sitemap.xml` lists town/type *index* pages → one more hop to listings; has `application/ld+json`.
  Detect the CRM from the site HTML signature; write a small adapter per CRM.
- **Daily cache** of listings per agency (speed + the sold-listing case): snapshot listings daily so a *just-sold* sign (gone from the live site) still matches yesterday's cache. Some agencies keep a `/verkocht/` section (Sinnaeve does); don't rely on it universally.
- **Confidence honesty:** never surface a confident match unless the facade genuinely matches. Prefer "no confident match, here are candidates to confirm" over a wrong high-confidence answer.
- **Acceptance gate:** for `proto/PXL_20260224_171834897 (1).jpg` it MUST resolve to `immotijl.be/.../7523945` (Rosstraat 6, Dendermonde); for the others, produce the correct small candidate set. Test photos are in `proto/` — the `(1)` copies have EXIF GPS.

## 6. Strategic context (where this is going)
- The **licensed production data source is the Whise API** (Whise is the dominant Flemish CRM; partner program free until 15 agencies). It returns listings with address/price/images/**status** (solves sold detection natively). The sitemap/JSON-LD scraping above is the **interim, CRM-agnostic** method; migrate Whise agencies to the API once partner access lands. ZiMi has requested partner access.
- Business model: agencies pay (% / placement). So agency consent is the norm, which is also the legal-clean path.
- Don't scrape portals; agency-site / Whise-API only.

## 7. Guardrails
- Don't commit secrets (`.env`, `proto/.env` are gitignored).
- Don't break the live demo at `immosnap.merlinfrombelgium.com` before tonight's show-and-tell — work on a branch.
- No em dashes in user-facing copy (house style).
