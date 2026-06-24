import puppeteer, { Browser, Page } from "puppeteer-core";
import { ENV } from "./env.js";

let _browser: Browser | null = null;

function wsEndpoint(): string {
  const base = (ENV.BROWSERLESS_URL || "ws://192.168.1.72:3000").replace(/\/$/, "");
  const token = ENV.BROWSERLESS_TOKEN;
  return token ? `${base}?token=${token}` : base;
}

export async function getBrowser(): Promise<Browser> {
  if (_browser && _browser.connected) return _browser;
  const endpoint = wsEndpoint();
  _browser = await puppeteer.connect({
    browserWSEndpoint: endpoint,
    protocolTimeout: 120_000,
  });
  return _browser;
}

export async function closeBrowser(): Promise<void> {
  if (_browser) {
    try { await _browser.disconnect(); } catch { /* ignore */ }
    _browser = null;
  }
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// tsx/esbuild injects a __name() helper into named functions passed to page.evaluate;
// that identifier doesn't exist in the browser. Shim it (string form is NOT transpiled).
const NAME_SHIM = "window.__name = window.__name || function(n){return n};";

/** Create a page pre-configured with UA, viewport, headers and the __name shim. */
export async function newPreparedPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1366, height: 1900 });
  await page.setExtraHTTPHeaders({ "Accept-Language": "nl-BE,nl;q=0.9,en;q=0.8" });
  await page.evaluateOnNewDocument(NAME_SHIM);
  return page;
}

/** Scroll the page in steps to trigger lazy-loaded content. */
export async function autoScroll(page: Page, steps = 6, dy = 1500, pause = 400): Promise<void> {
  for (let i = 0; i < steps; i++) {
    await page.evaluate("window.scrollBy(0," + dy + ")");
    await sleep(pause);
  }
  await page.evaluate("window.scrollTo(0,0)");
}

export interface FetchOpts {
  /** ms to wait after domcontentloaded for JS to settle */
  settle?: number;
  /** number of attempts */
  retries?: number;
  /** per-attempt navigation timeout */
  timeout?: number;
  /** optional CSS selector to wait for (best-effort) */
  waitFor?: string;
  /** block images/media/fonts for speed */
  blockAssets?: boolean;
  /** number of scroll steps to trigger lazy loading (0 = none) */
  scroll?: number;
}

/**
 * Render a page with a real headless browser via Browserless.
 * Uses `domcontentloaded` + fixed settle + retries (NOT networkidle — agency SPAs hang it).
 */
export async function renderPage(
  url: string,
  opts: FetchOpts = {}
): Promise<{ html: string; finalUrl: string; status: number | null }> {
  const { settle = 2500, retries = 3, timeout = 45_000, waitFor, blockAssets = false, scroll = 0 } = opts;
  let lastErr: unknown = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const browser = await getBrowser();
    let page: Page | null = null;
    try {
      page = await newPreparedPage(browser);

      if (blockAssets) {
        await page.setRequestInterception(true);
        page.on("request", (req) => {
          const rt = req.resourceType();
          if (rt === "image" || rt === "media" || rt === "font") req.abort().catch(() => {});
          else req.continue().catch(() => {});
        });
      }

      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout });
      const status = resp ? resp.status() : null;

      if (waitFor) {
        await page.waitForSelector(waitFor, { timeout: Math.min(settle + 4000, 12_000) }).catch(() => {});
      }
      await sleep(settle);
      if (scroll > 0) await autoScroll(page, scroll);

      const html = await page.content();
      const finalUrl = page.url();
      await page.close().catch(() => {});
      return { html, finalUrl, status };
    } catch (e) {
      lastErr = e;
      if (page) await page.close().catch(() => {});
      const backoff = 1200 * attempt;
      if (attempt < retries) await sleep(backoff);
    }
  }
  throw new Error(`renderPage failed for ${url} after ${retries} attempts: ${(lastErr as Error)?.message}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
