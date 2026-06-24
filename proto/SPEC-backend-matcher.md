# ImmoSnap — Backend Matcher (M1 spec)

## Problem
Given a street photo of a house with a "TE KOOP" (for-sale) sign, identify the matching real-estate listing. The output feeds a PWA (notebook demo + field use).

## Validated findings (do NOT re-litigate)
- **Reverse-image-search is DEAD as the matcher.** SerpApi Google Lens and Google Vision web-detection both return ZERO matching pages for the user's own camera photos (their photos aren't on the web; listings use the agency's own different photos). Do not build on it.
- **OCR → agency is rock solid.** Gemini vision reads the agency name + phone off the sign reliably (4/4 in testing: Immo Tijl, Immo Lot, Vastgoed De Simpel).
- **Small Flemish agencies = single-digit listings per town** → vision-matching a facade against a handful of candidates is trivial and reliable.
- **One full match already confirmed:** Immo Lot → Schuurkouter 31, 9200 Dendermonde (now sold; archived stub on Spotto).
- **Sold/removed listings disappear from live indexes fast** → need a portal/archive fallback (Spotto retains "verkocht" stubs).
- **Per-agency sites are hostile SPAs** (immotijl.be times out even via Browserless networkidle). **Resolve via PORTALS, not bespoke agency sites.**

## Pipeline (the matcher)
1. **OCR** — Gemini 3.5 Flash vision on the photo → `{agency, phone, website, town?, ref?, text}`. (Key: GEMINI key; gemini-3.5-flash.)
2. **Geo** — if the image has EXIF GPS (or the PWA passes device GPS), reverse-geocode (Google Maps key) → town + postcode. Many gallery exports strip EXIF GPS; treat GPS as optional.
3. **Resolve agency → candidate listings via PORTALS** (portal-first; agency site is fallback):
   - immoweb agency page (`/nl/agentschap/<slug>/<id>`), immoscoop (`/zoeken/te-koop/<postcode>-<town>`), realo, zimmo.
   - Filter by agency name + town (when known). Small agency → few candidates.
   - Use a **persistent headless browser with retries** (Cloudflare Browser Rendering API in prod; Browserless on CT120 `192.168.1.72:3000` for dev). Use `domcontentloaded` + fixed settle, NOT networkidle.
4. **Facade vision-match** — for each candidate, pull its listing photos; Gemini vision compares the query facade to each candidate. Note: the street-facing facade is often NOT the first gallery image (per-agency priors; immotijl puts it last). Score each candidate; rank.
5. **Fallback for sold/removed** — if no live match, check portal archives (Spotto stubs, cached pages).
6. **Return** ranked candidates: `[{listingUrl, address, price, facadeImageUrl, confidence, reason}]` + extracted `{agency, phone, town}` + debug trail.

## Architecture / hosting
- **Hosting: Cloudflare.** Frontend = PWA on Cloudflare Pages. Backend = the matcher API.
- **Rendering:** prefer Cloudflare **Browser Rendering API** (Puppeteer on Workers) so it stays Cloudflare-native; dev/fallback = homelab Browserless (CT120). Decision point for the build — pick whichever lands M1 fastest; dev can use Browserless directly.
- **Keys server-side only** (Gemini, Maps, SerpApi). Never in client.
- Language: Node/TypeScript (matches Cloudflare Workers; code-machine has node).

## M1 deliverable (what to build now)
A runnable matcher **CLI** on code-machine: `match.js <image-path> [--gps lat,lon]` →
1. OCR (Gemini) → agency.
2. Portal resolve → candidate listings (with facade image URLs).
3. Vision-match → ranked candidates.
4. Print JSON result.

**Validate it on the 4 test photos** (provided): they are Immo Tijl ×2, Immo Lot ×1 (Schuurkouter 31, sold), Vastgoed De Simpel ×1. These have NO EXIF GPS and the signs carry no address — hardest case (agency + facade only). Report which photos resolved to which listings, with confidence. That IS the "multiple photos matched" validation.

There is a prior prototype `match.py` in this dir — reference it, but the portal-first + Browserless-with-retries approach is the new design.

## M2 (later, after M1 proves out)
Wrap matcher as a Cloudflare Worker API (`POST /match`) + build the PWA frontend (camera/upload + EXIF/GPS, installable) + deploy to Cloudflare Pages. Add per-agency facade-position priors + telemetry.

## Risks
- Per-agency / per-portal markup variance → keep the resolver modular per portal.
- Portal bot-blocks (immoweb is aggressive) → real browser + sane pacing; immoscoop/realo often lighter.
- Gemini/SerpApi quota (SerpApi free = 250/mo) → SerpApi only as a supporting signal, not core.
- Sold listings → archive fallback is required, not optional.

## Handoff
Pushed git branch + a logs/results file (per the build rule). Report the per-photo match results.
