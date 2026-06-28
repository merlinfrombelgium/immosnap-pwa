import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { matchImage } from "./lib/matcher.js";
import { geocodeAddress, reverseGeocode } from "./lib/geo.js";

const app = new Hono();

app.use("/app.css", serveStatic({ path: "./public/app.css" }));
app.use("/app.js", serveStatic({ path: "./public/app.js" }));
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

  const result = await matchImage({
    imageBuffer: Buffer.from(await image.arrayBuffer()),
    gps,
    town,
  });

  console.error(`[/match] gps=${gps?JSON.stringify(gps):"NONE"} town=${result.town} kind=${result.matchKind} top=${result.candidates[0]?.ref}`);

  return c.json({
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
  });
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
