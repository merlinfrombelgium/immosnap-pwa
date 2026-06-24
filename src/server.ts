import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { matchImage } from "./lib/matcher.js";

const app = new Hono();

app.use("/app.css", serveStatic({ path: "./public/app.css" }));
app.use("/app.js", serveStatic({ path: "./public/app.js" }));
app.use("/sw.js", serveStatic({ path: "./public/sw.js" }));
app.use("/manifest.webmanifest", serveStatic({ path: "./public/manifest.webmanifest" }));
app.use("/icon.svg", serveStatic({ path: "./public/icon.svg" }));
app.use("/samples/*", serveStatic({ root: "./proto" }));

app.get("/", serveStatic({ path: "./public/index.html" }));

app.get("/health", (c) => c.json({ ok: true }));

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

  const result = await matchImage({
    imageBuffer: Buffer.from(await image.arrayBuffer()),
    gps,
    maxCandidates: 4,
  });

  return c.json({
    agency: result.agency,
    phone: result.phone,
    town: result.town,
    candidates: result.candidates.map((candidate) => ({
      listingUrl: candidate.listingUrl,
      address: candidate.address,
      price: candidate.price,
      facadeImageUrl: candidate.facadeImageUrl,
      confidence: candidate.confidence,
    })),
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
