import sharp from "sharp";
import { compareFacadeToSheet, prepImage, SheetScore } from "./gemini.js";

/** Fetch an image URL and return a JPEG buffer (downscaled). null on failure. */
export async function fetchImage(url: string, maxDim = 900): Promise<Buffer | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
        Referer: new URL(url).origin + "/",
      },
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 800) return null; // skip 1px/placeholder
    return await sharp(buf).resize({ width: maxDim, height: maxDim, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
  } catch {
    return null;
  }
}

const TILE_W = 440;
const TILE_H = 330;
const COLS = 3;

/**
 * Build a numbered contact-sheet montage (3 columns) from a set of image buffers.
 * Returns the sheet as base64 JPEG plus the ordered URLs that made it in.
 */
export async function buildContactSheet(
  images: { url: string; buf: Buffer }[]
): Promise<{ b64: string; tiles: string[] } | null> {
  if (images.length === 0) return null;
  const n = images.length;
  const rows = Math.ceil(n / COLS);
  const composites: sharp.OverlayOptions[] = [];
  const tiles: string[] = [];

  for (let i = 0; i < n; i++) {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const left = col * TILE_W;
    const top = row * TILE_H;
    try {
      const tile = await sharp(images[i].buf)
        .resize({ width: TILE_W, height: TILE_H, fit: "contain", background: { r: 245, g: 245, b: 245 } })
        .toBuffer();
      composites.push({ input: tile, left, top });
      // numbered label (SVG) in the corner
      const label = Buffer.from(
        `<svg width="44" height="30"><rect width="44" height="30" fill="#000" opacity="0.65"/><text x="6" y="22" font-size="22" font-family="Arial" fill="#fff" font-weight="bold">${i + 1}</text></svg>`
      );
      composites.push({ input: label, left: left + 2, top: top + 2 });
      tiles.push(images[i].url);
    } catch {
      tiles.push(images[i].url); // keep index alignment even if a tile failed
    }
  }

  const sheet = await sharp({
    create: { width: COLS * TILE_W, height: rows * TILE_H, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite(composites)
    .jpeg({ quality: 80 })
    .toBuffer();

  return { b64: sheet.toString("base64"), tiles };
}

/**
 * Score one candidate listing: fetch up to `maxImages` of its photos, build a
 * contact sheet, and ask Gemini whether the query facade matches.
 */
export async function scoreCandidate(
  queryB64: string,
  imageUrls: string[],
  maxImages = 9
): Promise<SheetScore & { facadeUrl: string | null }> {
  const urls = imageUrls.slice(0, maxImages);
  const bufs: { url: string; buf: Buffer }[] = [];
  const fetched = await Promise.all(urls.map((u) => fetchImage(u)));
  for (let i = 0; i < urls.length; i++) {
    if (fetched[i]) bufs.push({ url: urls[i], buf: fetched[i]! });
  }
  if (bufs.length === 0) return { score: 0, tile: null, reason: "no images fetched", facadeUrl: null };

  const sheet = await buildContactSheet(bufs);
  if (!sheet) return { score: 0, tile: null, reason: "sheet build failed", facadeUrl: null };

  const res = await compareFacadeToSheet(queryB64, sheet.b64, bufs.length);
  const facadeUrl = res.tile && res.tile >= 1 && res.tile <= sheet.tiles.length ? sheet.tiles[res.tile - 1] : bufs[0].url;
  return { ...res, facadeUrl };
}

export { prepImage };
