// Connectivity smoke test: Browserless + Gemini OCR on one photo.
import { renderPage, closeBrowser } from "./lib/browser.js";
import { ocrSign } from "./lib/gemini.js";

async function main() {
  const photo = process.argv[2] || "proto/PXL_20251129_131736955.jpg";

  console.log("== Gemini OCR test ==");
  try {
    const ocr = await ocrSign(photo);
    console.log(JSON.stringify(ocr, null, 2));
  } catch (e) {
    console.error("OCR FAILED:", (e as Error).message);
  }

  console.log("\n== Browserless render test (example.com) ==");
  try {
    const r = await renderPage("https://example.com", { settle: 800, retries: 2, timeout: 20000 });
    console.log("status", r.status, "len", r.html.length, "title-ish", /<title>(.*?)<\/title>/i.exec(r.html)?.[1]);
  } catch (e) {
    console.error("RENDER FAILED:", (e as Error).message);
  }
  await closeBrowser();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
