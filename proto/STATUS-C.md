# STATUS-C

## What works

- `npm run dev` starts a local Hono server on `http://localhost:3001`.
- `GET /health` returns `{"ok":true}`.
- `POST /match` accepts multipart form data with:
  - `image`: required file
  - `lat`: optional latitude
  - `lon`: optional longitude
- The backend reuses the existing matcher pieces in `src/lib`:
  - `browser.ts` for Browserless-backed rendering
  - `gemini.ts` for OCR and facade comparison
  - `env.ts` for loading `proto/.env`
  - `src/portals/immoweb.ts` for Immoweb agency/listing extraction
- The frontend is a small single-page installable PWA:
  - file upload / mobile camera capture
  - optional device GPS
  - `/match` call
  - candidate listing cards with thumbnail, address, price, and tap-to-confirm CTA
  - manifest + service worker included

## How to run

1. Ensure `proto/.env` contains valid `GEMINI_API_KEY`, `MAPS_API_KEY`, `BROWSERLESS_URL`, and `BROWSERLESS_TOKEN`.
2. Install deps:

```bash
npm install
```

3. Start the demo:

```bash
npm run dev
```

4. Open `http://localhost:3001`.
5. Upload or capture a house/sign photo and tap `Find candidates`.

Useful extra commands:

```bash
npm run match -- proto/PXL_20260224_171834897.jpg
npm run sanity
```

## Sanity-check results

Run date: 2026-06-24  
Command: `npm run sanity`

### `PXL_20251129_131736955.jpg`

- OCR: `IMMOTIJL`, phone `052 690 691`
- Resolver found 4 candidates, but all returned with missing gallery extraction from Zimmo.
- Top candidate was `https://www.zimmo.be/nl/aalst-9300/te-koop/huis/LM059/` with confidence `0`.
- Result: unresolved in current demo.

### `PXL_20260215_104544364.jpg`

- OCR: `Immo LOT`, phone `093 98 00 00`
- Resolver found 4 candidates across Spotto and Immoweb.
- Best returned candidate:
  - `https://www.spotto.be/nl/p/te-koop/9270-kalken/huis-bieststraat-9-met-4-kamers-tuin-terras/xDuaunQCGEWLyQjeojWZRg`
  - address `Bieststraat 9, 9270 Kalken`
  - confidence `30`
- Result: weak/likely incorrect candidate set, but the human-in-the-loop UI can still review the options.

### `PXL_20260224_171834897.jpg`

- OCR: `IMMOTIJL`, phone `052 690 691`
- Resolver found 4 candidates.
- Best returned candidate:
  - `https://www.zimmo.be/nl/aalst-9300/te-koop/huis/LM059/`
  - address `Parklaan 163, 9300 Aalst`
  - price `€ 315.000`
  - confidence `75`
- Result: this is the strongest end-to-end demo case right now.

### `PXL_20260329_151244517.jpg`

- OCR: `Vastgoed Simons`, phone `0492 97 53 52`
- Resolver found 4 candidates, but all were weak Zimmo hits with no usable gallery extraction.
- Top candidate had confidence `0`.
- Result: unresolved in current demo.

## Blockers / limitations

- Portal discovery is still brittle. SerpApi returns noisy results for some agencies, especially smaller ones.
- Zimmo pages are inconsistent: some listings expose enough DOM/image data for matching, others do not.
- Spotto sold/archive pages often provide useful addresses, but image galleries are frequently stripped or indirect.
- OCR is not perfect: one sample that should be a `Vastgoed De Simpel`-style case was read as `Vastgoed Simons`.
- Matching quality is intentionally best-effort. The demo is built around human confirmation, not autonomous final selection.

## Notes

- I also verified the HTTP layer directly with:

```bash
curl -s http://localhost:3001/health
curl -s -X POST -F image=@proto/PXL_20260224_171834897.jpg http://localhost:3001/match
```

- The backend returns the expected JSON envelope:

```json
{
  "agency": "...",
  "phone": "...",
  "town": null,
  "candidates": [
    {
      "listingUrl": "...",
      "address": "...",
      "price": "...",
      "facadeImageUrl": "...",
      "confidence": 75
    }
  ]
}
```
