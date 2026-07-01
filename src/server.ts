import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { discoverCandidates, scoreAndRank, type MatchCandidate, type MatchKind } from "./lib/matcher.js";
import { geocodeAddress, reverseGeocode } from "./lib/geo.js";
import {
  appendSnapRecord,
  confirmSnap,
  exportSnaps,
  makeSnapId,
  saveSnapImage,
  toCsv,
  type SnapCandidate,
  type SnapOutcome,
} from "./lib/telemetry.js";

const app = new Hono();

// Phase B (scoring) state for snaps currently in flight or recently finished,
// keyed by snapId. GET /match/:snapId/scores polls this. Dev-server-scale only
// (single process, in-memory); the durable record is the telemetry JSONL row.
interface PendingScore {
  done: boolean;
  matchKind: MatchKind;
  candidates: MatchCandidate[];
  createdAt: number;
}
const pendingScores = new Map<string, PendingScore>();
const PENDING_TTL_MS = 10 * 60 * 1000;

function sweepPendingScores() {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [id, entry] of pendingScores) {
    if (entry.createdAt < cutoff) pendingScores.delete(id);
  }
}

function toSnapCandidates(candidates: MatchCandidate[]): SnapCandidate[] {
  return candidates.map((c) => ({
    ref: c.ref,
    listingUrl: c.listingUrl,
    address: c.address,
    price: c.price,
    confidence: c.confidence,
    facadeImageUrl: c.facadeImageUrl,
  }));
}

/** localhost-only guard for endpoints that expose Merlo's local dev dataset. */
function isLocalhost(c: { req: { header: (name: string) => string | undefined } }): boolean {
  const host = (c.req.header("host") || "").split(":")[0];
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

app.use("/app.css", serveStatic({ path: "./public/app.css" }));
app.use("/app.js", serveStatic({ path: "./public/app.js" }));
app.use("/exifr-full.js", serveStatic({ path: "./public/exifr-full.js" }));
app.use("/sw.js", serveStatic({ path: "./public/sw.js" }));
app.use("/manifest.webmanifest", serveStatic({ path: "./public/manifest.webmanifest" }));
app.use("/manifest.json", serveStatic({ path: "./public/manifest.json" }));
app.use("/icon.svg", serveStatic({ path: "./public/icon.svg" }));
app.use("/samples/*", serveStatic({ root: "./proto" }));

app.get("/", serveStatic({ path: "./public/index.html" }));

app.get("/health", (c) => c.json({ ok: true }));

// Manual address entry: forward-geocode a typed address via the GOOGLE Geocoding
// API (src/lib/geo.ts). Sets up the "working location" the same as GPS/EXIF.
app.get("/geocode", async (c) => {
  const q = c.req.query("q");
  if (!q || !q.trim()) return c.json({ error: "query 'q' is required" }, 400);
  const g = await geocodeAddress(q.trim());
  if (!g) return c.json({ error: "address not found", query: q.trim() }, 404);
  console.error(`[/geocode] q="${q.trim()}" -> ${g.lat},${g.lon}`);
  return c.json({ lat: g.lat, lon: g.lon, query: q.trim() });
});

// Drop-pin reverse-geocode: resolve a map-placed lat/lon to a street address via
// the GOOGLE Geocoding API, so the UI can show where the confirmed pin landed.
app.get("/reverse", async (c) => {
  const lat = Number(c.req.query("lat"));
  const lon = Number(c.req.query("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return c.json({ error: "numeric 'lat' and 'lon' are required" }, 400);
  }
  try {
    const r = await reverseGeocode(lat, lon);
    return c.json({ lat, lon, formatted: r.formatted, town: r.town, postcode: r.postcode });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
});

// Phase A: OCR + agency resolve + town + cached listings -> return fast with an
// unscored candidate list and a snapId. Phase B (facade vision / GPS-proximity
// scoring) runs in the background; the client polls GET /match/:snapId/scores.
// This is the perf fix (ZIM-287 plan 3.3): the client sees agency/town/candidates
// in seconds instead of waiting for the whole town to be vision-scored.
app.post("/match", async (c) => {
  const body = await c.req.parseBody();
  const image = body.image;

  if (!image || typeof image === "string") {
    return c.json({ error: "image file is required" }, 400);
  }

  const lat = typeof body.lat === "string" ? Number(body.lat) : null;
  const lon = typeof body.lon === "string" ? Number(body.lon) : null;
  const gps =
    Number.isFinite(lat) && Number.isFinite(lon)
      ? { lat: Number(lat), lon: Number(lon) }
      : null;
  const town = typeof body.town === "string" && body.town.trim() ? body.town.trim() : null;

  const t0 = Date.now();
  const imageBuffer = Buffer.from(await image.arrayBuffer());
  const snapId = makeSnapId();
  const ts = new Date().toISOString();
  const imageRef = await saveSnapImage(snapId, imageBuffer).catch(() => null);

  let disc;
  try {
    disc = await discoverCandidates({ imageBuffer, gps, town });
  } catch (e) {
    await appendSnapRecord({
      snapId, ts, imageRef, gps, town, townSource: "none",
      ocr: { agency: null, phone: null, website: null, ref: null },
      agencyResolved: null, candidates: [], matchKind: "none", chosenListingUrl: null,
      timings: { ocrMs: 0, geoMs: 0, discoverMs: 0, visionMs: 0, totalMs: Date.now() - t0 },
      fromCache: false, cacheDate: null, outcome: "error", error: (e as Error).message,
    });
    return c.json({ error: (e as Error).message }, 502);
  }

  console.error(`[/match] snap=${snapId} gps=${gps ? JSON.stringify(gps) : "NONE"} agency=${disc.agency?.name ?? "NONE"} town=${disc.town} pool=${disc.pool.length}`);

  if (!disc.agency) {
    await appendSnapRecord({
      snapId, ts, imageRef, gps, town: disc.town, townSource: disc.townSource,
      ocr: { agency: null, phone: disc.phone, website: disc.website, ref: disc.ref },
      agencyResolved: null, candidates: [], matchKind: "none", chosenListingUrl: null,
      timings: { ...disc.timings, visionMs: 0, totalMs: Date.now() - t0 },
      fromCache: disc.fromCache, cacheDate: disc.cacheDate, outcome: "no_match",
    });
    return c.json({
      snapId,
      agency: null,
      phone: disc.phone,
      town: disc.town,
      website: disc.website,
      matchKind: "none",
      candidates: [],
      debug: { crm: null, domain: null, townSource: disc.townSource, listingsTotal: 0, candidatesEvaluated: 0, fromCache: false, cacheDate: null, note: disc.note },
    });
  }

  pendingScores.set(snapId, { done: false, matchKind: "none", candidates: [], createdAt: Date.now() });
  sweepPendingScores();

  // Phase B runs in the background; do not block the response on it.
  scoreAndRank(disc.pool, { gps }, disc.queryB64)
    .then(async ({ candidates, matchKind, visionMs }) => {
      pendingScores.set(snapId, { done: true, matchKind, candidates, createdAt: Date.now() });
      const outcome: SnapOutcome = candidates.length ? "success" : "no_match";
      await appendSnapRecord({
        snapId, ts, imageRef, gps, town: disc.town, townSource: disc.townSource,
        ocr: { agency: disc.agency!.name, phone: disc.phone, website: disc.website, ref: disc.ref },
        agencyResolved: disc.agency,
        candidates: toSnapCandidates(candidates),
        matchKind, chosenListingUrl: null,
        timings: { ...disc.timings, visionMs, totalMs: Date.now() - t0 },
        fromCache: disc.fromCache, cacheDate: disc.cacheDate, outcome,
      });
    })
    .catch(async (e) => {
      pendingScores.set(snapId, { done: true, matchKind: "none", candidates: [], createdAt: Date.now() });
      await appendSnapRecord({
        snapId, ts, imageRef, gps, town: disc.town, townSource: disc.townSource,
        ocr: { agency: disc.agency!.name, phone: disc.phone, website: disc.website, ref: disc.ref },
        agencyResolved: disc.agency, candidates: [], matchKind: "none", chosenListingUrl: null,
        timings: { ...disc.timings, visionMs: 0, totalMs: Date.now() - t0 },
        fromCache: disc.fromCache, cacheDate: disc.cacheDate, outcome: "error", error: (e as Error).message,
      });
    });

  // Unscored candidate list so the client can paint agency/town/candidates now.
  const unscored = disc.pool.map((listing) => ({
    listingUrl: listing.listingUrl,
    ref: listing.ref,
    type: listing.type,
    town: listing.townLabel,
    address: listing.address,
    price: listing.price,
    facadeImageUrl: listing.imageUrls[0] ?? null,
    confidence: null as number | null,
    reason: "",
  }));

  return c.json({
    snapId,
    agency: disc.agency.name,
    phone: disc.phone,
    town: disc.town,
    website: disc.website,
    matchKind: "pending",
    candidates: unscored,
    debug: {
      crm: disc.agency.crm,
      domain: disc.agency.domain,
      townSource: disc.townSource,
      listingsTotal: disc.listingsTotal,
      candidatesEvaluated: disc.pool.length,
      fromCache: disc.fromCache,
      cacheDate: disc.cacheDate,
      note: "scoring in progress; poll /match/:snapId/scores",
    },
  });
});

// Phase B poll: fills in confidence/ranking/matchKind once scoring finishes.
app.get("/match/:snapId/scores", (c) => {
  const snapId = c.req.param("snapId");
  const entry = pendingScores.get(snapId);
  if (!entry) return c.json({ error: "unknown snapId" }, 404);
  if (!entry.done) return c.json({ done: false });
  return c.json({
    done: true,
    matchKind: entry.matchKind,
    candidates: entry.candidates.map((candidate) => ({
      listingUrl: candidate.listingUrl,
      ref: candidate.ref,
      type: candidate.type,
      town: candidate.town,
      address: candidate.address,
      price: candidate.price,
      facadeImageUrl: candidate.facadeImageUrl,
      confidence: candidate.confidence,
      reason: candidate.reason,
    })),
  });
});

// Records which candidate the user actually picked: the accuracy label for the
// telemetry dataset. Also lets on-device history and the server dataset agree.
app.post("/confirm", async (c) => {
  const body = await c.req.json().catch(() => null);
  const snapId = body?.snapId;
  const listingUrl = body?.listingUrl;
  if (typeof snapId !== "string" || typeof listingUrl !== "string") {
    return c.json({ error: "snapId and listingUrl are required" }, 400);
  }
  const ok = await confirmSnap(snapId, listingUrl);
  if (!ok) return c.json({ error: "snapId not found in telemetry store" }, 404);
  return c.json({ ok: true });
});

// Dev-only dataset export. Bound to localhost so Merlo's snap data never
// leaves code-machine, even though the app is otherwise served through the
// public tunnel.
app.get("/telemetry/export", async (c) => {
  if (!isLocalhost(c)) return c.json({ error: "telemetry export is localhost-only" }, 403);
  const since = c.req.query("since");
  const format = c.req.query("format") === "csv" ? "csv" : "jsonl";
  const records = await exportSnaps(since || undefined);
  if (format === "csv") {
    return c.text(toCsv(records), 200, { "content-type": "text/csv" });
  }
  const body = records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
  return c.text(body, 200, { "content-type": "application/x-ndjson" });
});

app.get("/sample/:name", async (c) => {
  const name = c.req.param("name");
  const allowed = new Set([
    "PXL_20251129_131736955.jpg",
    "PXL_20260215_104544364.jpg",
    "PXL_20260224_171834897.jpg",
    "PXL_20260329_151244517.jpg",
  ]);
  if (!allowed.has(name)) return c.notFound();
  const file = await readFile(new URL(`../proto/${name}`, import.meta.url));
  return new Response(file, { headers: { "content-type": "image/jpeg" } });
});

const port = Number(process.env.PORT || 3001);

serve({ fetch: app.fetch, port });

console.log(`ImmoSnap demo listening on http://localhost:${port}`);
