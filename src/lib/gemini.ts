import sharp from "sharp";
import { ENV } from "./env.js";

const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const FALLBACK_MODELS = [MODEL, "gemini-2.5-flash", "gemini-2.0-flash"];
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export interface Part {
  text?: string;
  inline_data?: { mime_type: string; data: string };
}

async function callGemini(parts: Part[], jsonOut = true, maxOutputTokens = 1024): Promise<string> {
  const key = ENV.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY missing");
  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens,
      // Gemini 2.5/3.x enable "thinking" by default, which silently eats the output
      // token budget (finishReason=MAX_TOKENS with empty text). Disable it for these
      // short structured calls.
      thinkingConfig: { thinkingBudget: 0 },
      ...(jsonOut ? { responseMimeType: "application/json" } : {}),
    },
  };

  let lastErr = "";
  for (const model of FALLBACK_MODELS) {
    const url = `${BASE}/${model}:generateContent?key=${key}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        lastErr = `${model}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`;
        // 404 = model unavailable -> try next; otherwise also fall through
        continue;
      }
      const data: any = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") ?? "";
      if (process.env.DEBUG_GEMINI) {
        console.error(`[gemini ${model}] finishReason=${data?.candidates?.[0]?.finishReason} text=${JSON.stringify(text).slice(0, 300)}`);
      }
      if (!text) {
        lastErr = `${model}: empty response (finish=${data?.candidates?.[0]?.finishReason}) ${JSON.stringify(data).slice(0, 300)}`;
        continue;
      }
      return text;
    } catch (e) {
      lastErr = `${model}: ${(e as Error).message}`;
    }
  }
  throw new Error(`Gemini call failed: ${lastErr}`);
}

/** Downscale + recompress an image (path or buffer) to keep vision calls fast/cheap. */
export async function prepImage(input: string | Buffer, maxDim = 1280): Promise<string> {
  const buf = await sharp(input)
    .rotate() // honour EXIF orientation
    .resize({ width: maxDim, height: maxDim, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
  return buf.toString("base64");
}

export interface OcrResult {
  agency: string | null;
  phone: string | null;
  website: string | null;
  town: string | null;
  ref: string | null;
  text: string;
}

const OCR_PROMPT = `You are reading a Belgian (Flemish) real-estate "TE KOOP" / "TE HUUR" yard sign in this photo.
Extract ONLY what is printed on the sign/board. Return strict JSON:
{
  "agency": "the real-estate agency / immo office name exactly as printed, or null",
  "phone": "phone number digits as printed, or null",
  "website": "website/domain printed on the sign, or null",
  "town": "town/municipality if printed, or null",
  "ref": "listing reference code if printed, or null",
  "text": "all other legible text on the sign, joined with spaces"
}
Do not guess values that are not visibly printed. Agency names are like "Immo Tijl", "Immo Lot", "Vastgoed De Simpel".`;

async function ocrSignBase(input: string | Buffer): Promise<OcrResult> {
  const data = await prepImage(input, 1400);
  const text = await callGemini(
    [{ text: OCR_PROMPT }, { inline_data: { mime_type: "image/jpeg", data } }],
    true,
    800
  );
  return parseJsonLoose<OcrResult>(text, {
    agency: null, phone: null, website: null, town: null, ref: null, text: "",
  });
}

export async function ocrSign(imagePath: string): Promise<OcrResult> {
  return ocrSignBase(imagePath);
}

export async function ocrSignBuffer(image: Buffer): Promise<OcrResult> {
  return ocrSignBase(image);
}

export interface FacadeScore {
  score: number; // 0..1 same-building likelihood
  reason: string;
}

/**
 * Compare the query facade (first image) against ONE candidate listing image (second image).
 * Returns 0..1 likelihood they are the same physical building.
 */
export async function compareFacades(
  queryB64: string,
  candidateB64: string
): Promise<FacadeScore> {
  const prompt = `Two photos of houses in Belgium. IMAGE 1 is a street photo taken by a person.
IMAGE 2 is a photo from a real-estate listing. Decide if they show the SAME physical building.
Compare: number of floors/windows, roof shape & dormers, facade material/colour (brick, render), door & window placement, garage, distinctive features. Ignore weather, season, camera angle, parked cars, and people.
Return strict JSON: {"score": 0.0-1.0 likelihood SAME building, "reason": "short evidence-based explanation"}.
Use score >0.7 only when several concrete features clearly match. Use <0.3 when shape/material clearly differs.`;
  const text = await callGemini(
    [
      { text: prompt },
      { text: "IMAGE 1 (query, street photo):" },
      { inline_data: { mime_type: "image/jpeg", data: queryB64 } },
      { text: "IMAGE 2 (candidate listing photo):" },
      { inline_data: { mime_type: "image/jpeg", data: candidateB64 } },
    ],
    true,
    400
  );
  const r = parseJsonLoose<FacadeScore>(text, { score: 0, reason: "parse-failed" });
  r.score = Math.max(0, Math.min(1, Number(r.score) || 0));
  return r;
}

/**
 * Given the query facade + a montage/grid of several candidate thumbnails labelled,
 * pick which listing best matches. Used to triage candidates cheaply.
 */
export async function pickBestListing(
  queryB64: string,
  candidates: { label: string; b64: string }[]
): Promise<{ label: string | null; score: number; reason: string }> {
  const parts: Part[] = [
    {
      text:
        `IMAGE Q is a street photo of a house. The following images are candidate real-estate listing photos, each preceded by its LABEL. ` +
        `Pick the LABEL whose building is most likely the SAME physical house as IMAGE Q. ` +
        `Return strict JSON {"label": "<label or null>", "score": 0.0-1.0, "reason": "..."}.`,
    },
    { text: "IMAGE Q:" },
    { inline_data: { mime_type: "image/jpeg", data: queryB64 } },
  ];
  for (const c of candidates) {
    parts.push({ text: `LABEL ${c.label}:` });
    parts.push({ inline_data: { mime_type: "image/jpeg", data: c.b64 } });
  }
  const text = await callGemini(parts, true, 400);
  return parseJsonLoose(text, { label: null, score: 0, reason: "parse-failed" });
}

export interface SheetScore {
  score: number; // 0..1 best same-building likelihood across the sheet
  tile: number | null; // 1-based tile index of the best-matching photo
  reason: string;
}

/**
 * Compare the query facade against a CONTACT SHEET montage of one listing's gallery
 * (numbered tiles, reading order). One call covers the whole gallery — efficient,
 * and robust to the street facade not being the first photo.
 */
export async function compareFacadeToSheet(queryB64: string, sheetB64: string, tileCount: number): Promise<SheetScore> {
  const prompt =
    `IMAGE Q is a street photo of a house (taken by a person standing on the street).\n` +
    `IMAGE S is a numbered contact sheet of photos from ONE real-estate listing (tiles 1..${tileCount}, left-to-right, top-to-bottom).\n` +
    `Some tiles are interiors, gardens, or floor plans — ignore those. Find the tile that shows the building's STREET FACADE / exterior and decide if it is the SAME physical building as IMAGE Q.\n` +
    `Compare: number of floors, roofline & dormers, facade material & colour, window/door layout, garage, attached vs detached.\n` +
    `Return strict JSON {"score": 0.0-1.0 likelihood SAME building, "tile": <best exterior tile number or null>, "reason": "concrete evidence"}.\n` +
    `score >0.7 only when several concrete exterior features clearly match; <0.3 when the building clearly differs or no exterior is shown.`;
  const text = await callGemini(
    [
      { text: prompt },
      { text: "IMAGE Q:" },
      { inline_data: { mime_type: "image/jpeg", data: queryB64 } },
      { text: "IMAGE S (contact sheet):" },
      { inline_data: { mime_type: "image/jpeg", data: sheetB64 } },
    ],
    true,
    400
  );
  const r = parseJsonLoose<SheetScore>(text, { score: 0, tile: null, reason: "parse-failed" });
  r.score = Math.max(0, Math.min(1, Number(r.score) || 0));
  r.tile = r.tile != null ? Number(r.tile) : null;
  return r;
}

function parseJsonLoose<T>(text: string, fallback: T): T {
  const cleaned = text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]) as T; } catch { /* fall through */ }
    }
    return fallback;
  }
}
