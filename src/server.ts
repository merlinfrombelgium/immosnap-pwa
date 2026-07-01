import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { matchPhaseA, runPhaseB } from "./lib/matchPhases.js";
import type { MatchCandidate, MatchKind } from "./lib/matcher.js";
import { geocodeAddress, reverseGeocode } from "./lib/geo.js";
import { makeSnapId, saveSnapImage, writeSnapRecord, confirmSnap, exportSnaps } from "./lib/telemetry.js";

const app = new Hono();

// Prominent version + timestamp (FR4): computed once at process start so the
// topbar always reflects the actual running build, not a hand-edited string.
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
let gitSha: string | null = null;
try {
  gitSha = execSync("git rev-parse --short HEAD", { cwd: process.cwd() }).toString().trim();
} catch {
  gitSha = null;
}
const startedAt = new Date().toISOString();

app.use("/app.css", serveStatic({ path: "./public/app.css" }));
app.use("/app.js", serveStatic({ path: "./public/app.js" }));
app.use("/vendor/*", serveStatic({ root: "./public" }));
app.use("/sw.js", serveStatic({ path: "./public/sw.js" }));
app.use("/manifest.webmanifest", serveStatic({ path: "./public/manifest.webmanifest" }));
app.use("/manifest.json", serveStatic({ path: "./public/manifest.json" }));
app.use("/icon.svg", serveStatic({ path: "./public/icon.svg" }));
app.use("/samples/*", serveStatic({ root: "./proto" }));

app.get("/", serveStatic({ path: "./public/index.html" }));
app.get("/health", (c) => c.json({ ok: true }));
app.get("/version", (c) => c.json({ version: pkg.version, sha: gitSha, startedAt, branch: "v2-rebuild" }));

// Manual address entry: forward-geocode a typed address via the Google Geocoding
// API (src/lib/geo.ts). Sets up the "working location" the same as GPS/EXIF.
app.get("/geocode", async (c) => {
  const q = c.req.query("q");
  if (!q || !q.trim()) return c.json({ error: "query 'q' is required" }, 400);
  const g = await geocodeAddress(q.trim());
  if (!g) return c.json({ error: "address not found", query: q.trim() }, 404);
  return c.json({ lat: g.lat, lon: g.lon, query: q.trim() });
});

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

/** In-memory Phase B session store, keyed by snapId, so a polling client sees
 * candidates fill in as vision/distance scores land. Ephemeral by design; the
 * durable record is the telemetry JSONL row written once Phase B settles. */
type Session = { status: "scoring" | "done" | "error"; candidates: MatchCandidate[]; matchKind: MatchKind; startedAt: number; error?: string };
const sessions = new Map<string, Session>();
const SESSION_TTL_MS = 30 * 60_000;

function reapSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, s] of sessions) if (s.startedAt < cutoff) sessions.delete(id);
}

function candidateForClient(c: MatchCandidate) {
  return {
    listingUrl: c.listingUrl,
    ref: c.ref,
    type: c.type,
    town: c.town,
    address: c.address,
    price: c.price,
    facadeImageUrl: c.facadeImageUrl,
    confidence: c.confidence,
    reason: c.reason,
  };
}

app.post("/match", async (c) => {
  reapSessions();
  const body = await c.req.parseBody();
  const image = body.image;
  if (!image || typeof image === "string") {
    return c.json({ error: "image file is required" }, 400);
  }

  const lat = typeof body.lat === "string" ? Number(body.lat) : null;
  const lon = typeof body.lon === "string" ? Number(body.lon) : null;
  const gps = Number.isFinite(lat) && Number.isFinite(lon) ? { lat: Number(lat), lon: Number(lon) } : null;
  const town = typeof body.town === "string" && body.town.trim() ? body.town.trim() : null;

  const ts = Date.now();
  const imageBuffer = Buffer.from(await image.arrayBuffer());
  const snapId = makeSnapId(ts);

  const phaseA = await matchPhaseA({ imageBuffer, gps, town });

  console.error(`[/match] snap=${snapId} gps=${gps ? JSON.stringify(gps) : "NONE"} town=${phaseA.town} agency=${phaseA.agency?.name ?? "none"} pool=${phaseA.pool.length}`);

  sessions.set(snapId, {
    status: phaseA.pool.length ? "scoring" : "done",
    candidates: phaseA.candidates,
    matchKind: phaseA.pool.length ? "candidates" : "none",
    startedAt: ts,
  });

  // Fire-and-forget Phase B: score candidates in the background, updating the
  // session in place so GET /match/:snapId/scores reflects live progress. The
  // one telemetry row for this snap is written once this settles (success or
  // error); the image is saved up front so nothing is lost on a mid-scoring crash.
  saveSnapImage(snapId, imageBuffer)
    .then((imageRef) =>
      runPhaseB(phaseA, (index, candidate) => {
        const s = sessions.get(snapId);
        if (s) s.candidates[index] = candidate;
      })
        .then(async (phaseB) => {
          const session = sessions.get(snapId);
          if (session) {
            session.status = "done";
            session.candidates = phaseB.candidates;
            session.matchKind = phaseB.matchKind;
          }
          const totalMs = Date.now() - ts;
          await writeSnapRecord({
            snapId,
            ts,
            imageRef,
            gps,
            town: phaseA.town,
            townSource: phaseA.townSource,
            ocr: { agency: phaseA.ocr.agency, phone: phaseA.ocr.phone, website: phaseA.ocr.website, ref: phaseA.ocr.ref },
            agencyResolved: phaseA.agency,
            candidates: phaseB.candidates.map((cand) => ({
              ref: cand.ref,
              listingUrl: cand.listingUrl,
              address: cand.address,
              price: cand.price,
              confidence: cand.confidence,
              facadeImageUrl: cand.facadeImageUrl,
            })),
            matchKind: phaseB.matchKind,
            chosenListingUrl: null,
            timings: { ...phaseA.timings, visionMs: phaseB.visionMs, totalMs },
            fromCache: phaseA.fromCache,
            cacheDate: phaseA.cacheDate,
            outcome: phaseB.matchKind === "none" ? "no_match" : "success",
          });
        })
        .catch(async (e) => {
          const session = sessions.get(snapId);
          if (session) { session.status = "error"; session.error = (e as Error).message; }
          await writeSnapRecord({
            snapId,
            ts,
            imageRef,
            gps,
            town: phaseA.town,
            townSource: phaseA.townSource,
            ocr: { agency: phaseA.ocr.agency, phone: phaseA.ocr.phone, website: phaseA.ocr.website, ref: phaseA.ocr.ref },
            agencyResolved: phaseA.agency,
            candidates: [],
            matchKind: "none",
            chosenListingUrl: null,
            timings: { ...phaseA.timings, visionMs: Date.now() - ts, totalMs: Date.now() - ts },
            fromCache: phaseA.fromCache,
            cacheDate: phaseA.cacheDate,
            outcome: "error",
            error: (e as Error).message,
          });
        })
    )
    .catch((e) => console.error(`[/match] snap=${snapId} background phase B failed to start:`, e));

  return c.json({
    snapId,
    agency: phaseA.agency?.name ?? null,
    phone: phaseA.ocr.phone,
    town: phaseA.town,
    website: phaseA.ocr.website ?? (phaseA.agency ? `https://${phaseA.agency.domain}` : null),
    scoring: phaseA.pool.length > 0,
    matchKind: phaseA.pool.length ? "candidates" : "none",
    candidates: phaseA.candidates.map(candidateForClient),
    debug: {
      crm: phaseA.agency?.crm ?? null,
      domain: phaseA.agency?.domain ?? null,
      townSource: phaseA.townSource,
      listingsTotal: phaseA.listingsTotal,
      candidatesEvaluated: phaseA.pool.length,
      fromCache: phaseA.fromCache,
      cacheDate: phaseA.cacheDate,
    },
  });
});

app.get("/match/:snapId/scores", (c) => {
  const snapId = c.req.param("snapId");
  const session = sessions.get(snapId);
  if (!session) return c.json({ error: "unknown or expired snapId" }, 404);
  return c.json({
    status: session.status,
    matchKind: session.matchKind,
    candidates: session.candidates.map(candidateForClient),
    error: session.error,
  });
});

app.post("/confirm", async (c) => {
  const body = await c.req.json().catch(() => null);
  const snapId = body?.snapId;
  const listingUrl = body?.listingUrl;
  if (typeof snapId !== "string" || typeof listingUrl !== "string") {
    return c.json({ error: "snapId and listingUrl are required" }, 400);
  }
  const ok = await confirmSnap(snapId, listingUrl);
  if (!ok) return c.json({ error: "snapId not found in telemetry log" }, 404);
  return c.json({ ok: true });
});

// Dev-only: export the telemetry dataset for offline analysis. Never bound
// beyond localhost, and never called from the client UI.
app.get("/telemetry/export", async (c) => {
  const since = c.req.query("since") ?? null;
  const jsonl = await exportSnaps(since);
  c.header("content-type", "application/x-ndjson");
  return c.body(jsonl);
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

serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });

console.log(`ImmoSnap v2 listening on http://localhost:${port}`);
