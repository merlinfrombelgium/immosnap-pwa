import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { readFile, mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { matchImage } from "./lib/matcher.js";
import { geocodeAddress, reverseGeocode } from "./lib/geo.js";

const app = new Hono();

// ── build info (computed once at boot; refreshes on every deploy/restart) ─────
const BUILT_AT = new Date().toISOString();
let GIT_SHA = "unknown";
try {
  GIT_SHA = execSync("git rev-parse --short HEAD", { cwd: process.cwd() }).toString().trim();
} catch {}
const BUILD_LABEL = `${BUILT_AT.replace("T", " ").replace(/\.\d+Z$/, " UTC")} · ${GIT_SHA}`;

// ── capture store: every snap + full result lands here as a dev dataset ───────
const CAPTURE_DIR = new URL("../store/captures/", import.meta.url);
const CAPTURE_PATH = CAPTURE_DIR.pathname;
async function ensureCaptureDir() {
  if (!existsSync(CAPTURE_PATH)) await mkdir(CAPTURE_PATH, { recursive: true });
}
let captureSeq = 0;
function captureId() {
  // sortable, unique per process: <iso-compact>-<seq>
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${ts}-${String(++captureSeq).padStart(3, "0")}`;
}

app.use("/app.css", serveStatic({ path: "./public/app.css" }));
app.use("/app.js", serveStatic({ path: "./public/app.js" }));
app.use("/sw.js", serveStatic({ path: "./public/sw.js" }));
app.use("/manifest.webmanifest", serveStatic({ path: "./public/manifest.webmanifest" }));
app.use("/manifest.json", serveStatic({ path: "./public/manifest.json" }));
app.use("/icon.svg", serveStatic({ path: "./public/icon.svg" }));
app.use("/samples/*", serveStatic({ root: "./proto" }));

app.get("/", serveStatic({ path: "./public/index.html" }));

app.get("/health", (c) => c.json({ ok: true }));

// Build/version — the UI shows this so the live build is never ambiguous.
app.get("/version", (c) => c.json({ builtAt: BUILT_AT, gitSha: GIT_SHA, label: BUILD_LABEL, version: 10 }));

app.get("/geocode", async (c) => {
  const q = c.req.query("q");
  if (!q || !q.trim()) return c.json({ error: "query 'q' is required" }, 400);
  const g = await geocodeAddress(q.trim());
  if (!g) return c.json({ error: "address not found", query: q.trim() }, 404);
  console.error(`[/geocode] q="${q.trim()}" -> ${g.lat},${g.lon}`);
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

  const imageBuffer = Buffer.from(await image.arrayBuffer());
  const t0 = Date.now();
  const result = await matchImage({ imageBuffer, gps, town });
  const ms = Date.now() - t0;

  console.error(`[/match] ${ms}ms gps=${gps ? JSON.stringify(gps) : "NONE"} town=${result.town} kind=${result.matchKind} cands=${result.candidates.length} top=${result.candidates[0]?.ref}`);

  const payload = {
    agency: result.agency,
    phone: result.phone,
    town: result.town,
    website: result.website,
    matchKind: result.matchKind,
    candidates: result.candidates.map((candidate) => ({
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
    debug: result.debug,
    ms,
  };

  // Capture EVERYTHING for dev improvement: the raw photo + full result + timing.
  // Fire-and-forget so it never slows the response or breaks the match on IO error.
  (async () => {
    try {
      await ensureCaptureDir();
      const id = captureId();
      const ext = (image.type && image.type.includes("png")) ? "png" : "jpg";
      await writeFile(`${CAPTURE_PATH}${id}.${ext}`, imageBuffer);
      const meta = {
        id, ts: new Date().toISOString(), ms,
        imageFile: `${id}.${ext}`,
        imageType: image.type || null,
        imageBytes: imageBuffer.length,
        gps, townInput: town,
        result: payload,
      };
      await writeFile(`${CAPTURE_PATH}${id}.json`, JSON.stringify(meta, null, 2));
    } catch (e) {
      console.error(`[capture] failed: ${(e as Error).message}`);
    }
  })();

  return c.json(payload);
});

// ── captures API: powers the in-app snap history + the dev dataset review ─────
app.get("/captures", async (c) => {
  try {
    await ensureCaptureDir();
    const files = (await readdir(CAPTURE_PATH)).filter((f) => f.endsWith(".json"));
    files.sort().reverse(); // newest first
    const limit = Math.min(Number(c.req.query("limit") || 40), 200);
    const items = [];
    for (const f of files.slice(0, limit)) {
      try {
        const m = JSON.parse(await readFile(`${CAPTURE_PATH}${f}`, "utf8"));
        const top = m.result?.candidates?.[0] || null;
        items.push({
          id: m.id, ts: m.ts, ms: m.ms,
          imageUrl: `/captures/${m.id}/image`,
          agency: m.result?.agency || null,
          town: m.result?.town || null,
          matchKind: m.result?.matchKind || null,
          candidateCount: (m.result?.candidates || []).length,
          top: top ? { address: top.address, price: top.price, confidence: top.confidence, listingUrl: top.listingUrl } : null,
          gps: m.gps || null,
        });
      } catch {}
    }
    return c.json({ count: items.length, items });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

app.get("/captures/:id/image", async (c) => {
  const id = c.req.param("id").replace(/[^A-Za-z0-9\-]/g, ""); // sanitize
  for (const ext of ["jpg", "png"]) {
    const p = `${CAPTURE_PATH}${id}.${ext}`;
    if (existsSync(p)) {
      const file = await readFile(p);
      return new Response(new Uint8Array(file), { headers: { "content-type": ext === "png" ? "image/png" : "image/jpeg" } });
    }
  }
  return c.notFound();
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
  return new Response(new Uint8Array(file), { headers: { "content-type": "image/jpeg" } });
});

const port = Number(process.env.PORT || 3001);

serve({ fetch: app.fetch, port });

console.log(`ImmoSnap demo listening on http://localhost:${port} — build ${BUILD_LABEL}`);
