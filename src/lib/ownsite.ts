import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderPage } from "./browser.js";

/**
 * GENERIC, DYNAMIC own-site discovery.
 *
 * Given an agency's own domain + (optional) GPS town, find that agency's
 * for-sale listings WITHOUT any per-agency hardcoding. The same code path serves
 * Woonvast, Era, Berno and any other Flemish agency CRM:
 *
 *   1. Fetch <domain>/sitemap.xml (STATIC). Follow a sitemap index into its child
 *      sitemaps (bounded). Collect every <loc>.
 *   2. From those locs, recognise generically (by URL shape):
 *        - detail/listing URLs (id in path, or a rich for-sale slug), and
 *        - for-sale INDEX pages (e.g. /te-koop/<town>) that must be expanded one
 *          more hop to reach detail URLs (idless Drupal sites like Era).
 *   3. Filter to the GPS town (town in the URL slug, or via the town index). If
 *      the town is not covered, fall back to the full for-sale set rather than
 *      returning nothing (so a sign still surfaces candidates to confirm).
 *   4. Extract address / price / images GENERICALLY:
 *        JSON-LD (schema.org RealEstateListing/Residence/Offer/Place)
 *          -> og: meta (og:title / og:image)
 *          -> heuristic DOM/text fallback.
 *
 * STATIC fetch is preferred for everything (sitemaps, index pages, detail pages):
 * it is fast and needs no Browserless. A real browser is used ONLY as a per-page
 * fallback when the static HTML genuinely lacks the listing photos (JS galleries).
 *
 * TIME-BOXING: there is NO single global wall that aborts the run. Every fetch
 * has its own short timeout and the candidate fetches run with bounded
 * concurrency, so total time scales with the candidate count and a slow/broken
 * page is skipped, never fatal.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export interface OwnSiteCandidate {
  listingUrl: string;
  source: "agency";
  address: string | null;
  price: string | null;
  facadeImageUrl: string | null;
  allImageUrls: string[];
  town: string | null;
}

export interface OwnSiteOpts {
  /** hard cap on returned candidates */
  maxCandidates?: number;
  /** per static fetch timeout (ms) */
  fetchTimeoutMs?: number;
  /** parallel detail fetches */
  concurrency?: number;
  /** allow a Browserless fallback for JS-only detail pages */
  allowBrowserFallback?: boolean;
  /** per Browserless render timeout (ms) */
  browserTimeoutMs?: number;
  /** soft scheduling budget (ms): stop STARTING new detail fetches past this.
   *  Never aborts in-flight work — purely bounds total wall time. 0 = unbounded. */
  budgetMs?: number;
}

type FieldName = "address" | "price" | "images";

interface StrategyRecord {
  strategy: string;
  confidence: number;
  sampleCount: number;
  lastVerifiedAt: string | null;
}

interface PatternFieldState {
  preferred: string[];
  learned: StrategyRecord[];
}

interface PatternEntry {
  fingerprint: string;
  domains: string[];
  detection: {
    label: string;
    signals: string[];
    lastSeenAt: string;
  };
  discovery: {
    mode: "sitemap-static";
    lastVerifiedAt: string | null;
  };
  fields: Record<FieldName, PatternFieldState>;
  confidence: number;
  sampleCount: number;
  lastVerifiedAt: string | null;
  exceptions: Array<{
    at: string;
    field: FieldName | "all";
    reason: string;
    domain: string;
    url?: string;
  }>;
}

interface DomainOverride {
  fingerprint: string;
  preferred?: Partial<Record<FieldName, string[]>>;
  lastVerifiedAt: string | null;
}

interface PatternRegistry {
  version: number;
  updatedAt: string;
  patterns: Record<string, PatternEntry>;
  domains: Record<string, DomainOverride>;
}

interface Fingerprint {
  key: string;
  label: string;
  signals: string[];
}

interface StrategyResult<T> {
  value: T | null;
  strategy: string | null;
}

interface ExtractionState {
  registry: PatternRegistry;
  fingerprint: Fingerprint;
  domain: string;
}

function intEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function resolved(opts: OwnSiteOpts): Required<OwnSiteOpts> {
  return {
    maxCandidates: opts.maxCandidates ?? 20,
    fetchTimeoutMs: opts.fetchTimeoutMs ?? intEnv("OWNSITE_FETCH_TIMEOUT_MS", 9_000),
    concurrency: opts.concurrency ?? intEnv("OWNSITE_CONCURRENCY", 6),
    allowBrowserFallback: opts.allowBrowserFallback ?? true,
    browserTimeoutMs: opts.browserTimeoutMs ?? intEnv("OWNSITE_BROWSER_TIMEOUT_MS", 16_000),
    budgetMs: opts.budgetMs ?? intEnv("OWNSITE_BUDGET_MS", 0),
  };
}

const REGISTRY_PATH = path.resolve(process.cwd(), "store/site-patterns.json");

function emptyRegistry(): PatternRegistry {
  return {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    patterns: {},
    domains: {},
  };
}

async function loadRegistry(): Promise<PatternRegistry> {
  try {
    const raw = await readFile(REGISTRY_PATH, "utf8");
    const parsed = JSON.parse(raw) as PatternRegistry;
    return {
      version: parsed.version || 1,
      updatedAt: parsed.updatedAt || new Date(0).toISOString(),
      patterns: parsed.patterns || {},
      domains: parsed.domains || {},
    };
  } catch {
    return emptyRegistry();
  }
}

async function saveRegistry(registry: PatternRegistry): Promise<void> {
  let base = emptyRegistry();
  try {
    const raw = await readFile(REGISTRY_PATH, "utf8");
    const parsed = JSON.parse(raw) as PatternRegistry;
    base = {
      version: parsed.version || 1,
      updatedAt: parsed.updatedAt || new Date(0).toISOString(),
      patterns: parsed.patterns || {},
      domains: parsed.domains || {},
    };
  } catch {
    /* first write */
  }
  for (const [fp, incoming] of Object.entries(registry.patterns)) {
    const existing = base.patterns[fp];
    if (!existing) {
      base.patterns[fp] = incoming;
      continue;
    }
    existing.domains = [...new Set([...existing.domains, ...incoming.domains])];
    existing.detection = incoming.detection.lastSeenAt >= existing.detection.lastSeenAt ? incoming.detection : existing.detection;
    existing.discovery = incoming.discovery.lastVerifiedAt && (!existing.discovery.lastVerifiedAt || incoming.discovery.lastVerifiedAt >= existing.discovery.lastVerifiedAt)
      ? incoming.discovery
      : existing.discovery;
    existing.confidence = Math.max(existing.confidence, incoming.confidence);
    existing.sampleCount = Math.max(existing.sampleCount, incoming.sampleCount);
    existing.lastVerifiedAt =
      [existing.lastVerifiedAt, incoming.lastVerifiedAt].filter(Boolean).sort().slice(-1)[0] || null;
    existing.exceptions = [...existing.exceptions, ...incoming.exceptions].slice(-25);
    for (const field of ["address", "price", "images"] as FieldName[]) {
      const pref = [...new Set([...(incoming.fields[field]?.preferred || []), ...(existing.fields[field]?.preferred || [])])];
      existing.fields[field] = existing.fields[field] || emptyFieldState();
      existing.fields[field].preferred = pref.slice(0, 4);
      const learned = new Map<string, StrategyRecord>();
      for (const rec of [...(existing.fields[field]?.learned || []), ...(incoming.fields[field]?.learned || [])]) {
        const prev = learned.get(rec.strategy);
        if (!prev) learned.set(rec.strategy, { ...rec });
        else {
          prev.confidence = Math.max(prev.confidence, rec.confidence);
          prev.sampleCount = Math.max(prev.sampleCount, rec.sampleCount);
          prev.lastVerifiedAt = [prev.lastVerifiedAt, rec.lastVerifiedAt].filter(Boolean).sort().slice(-1)[0] || null;
        }
      }
      existing.fields[field].learned = [...learned.values()];
    }
  }
  for (const [domain, override] of Object.entries(registry.domains)) {
    const prev = base.domains[domain];
    if (!prev) {
      base.domains[domain] = override;
      continue;
    }
    base.domains[domain] = {
      fingerprint: override.fingerprint || prev.fingerprint,
      preferred: {
        address: [...new Set([...(override.preferred?.address || []), ...(prev.preferred?.address || [])])].slice(0, 4),
        price: [...new Set([...(override.preferred?.price || []), ...(prev.preferred?.price || [])])].slice(0, 4),
        images: [...new Set([...(override.preferred?.images || []), ...(prev.preferred?.images || [])])].slice(0, 4),
      },
      lastVerifiedAt:
        [prev.lastVerifiedAt, override.lastVerifiedAt].filter(Boolean).sort().slice(-1)[0] || null,
    };
  }
  base.updatedAt = new Date().toISOString();
  await mkdir(path.dirname(REGISTRY_PATH), { recursive: true });
  await writeFile(REGISTRY_PATH, JSON.stringify(base, null, 2) + "\n", "utf8");
}

function emptyFieldState(): PatternFieldState {
  return { preferred: [], learned: [] };
}

function ensurePattern(registry: PatternRegistry, fingerprint: Fingerprint, domain: string): PatternEntry {
  const now = new Date().toISOString();
  let entry = registry.patterns[fingerprint.key];
  if (!entry) {
    entry = registry.patterns[fingerprint.key] = {
      fingerprint: fingerprint.key,
      domains: [],
      detection: { label: fingerprint.label, signals: [...fingerprint.signals], lastSeenAt: now },
      discovery: { mode: "sitemap-static", lastVerifiedAt: null },
      fields: {
        address: emptyFieldState(),
        price: emptyFieldState(),
        images: emptyFieldState(),
      },
      confidence: 0.5,
      sampleCount: 0,
      lastVerifiedAt: null,
      exceptions: [],
    };
  }
  entry.detection.label = fingerprint.label;
  entry.detection.signals = [...new Set([...entry.detection.signals, ...fingerprint.signals])].slice(0, 12);
  entry.detection.lastSeenAt = now;
  if (!entry.domains.includes(domain)) entry.domains.push(domain);
  registry.domains[domain] = registry.domains[domain] || {
    fingerprint: fingerprint.key,
    preferred: {},
    lastVerifiedAt: null,
  };
  registry.domains[domain].fingerprint = fingerprint.key;
  return entry;
}

function strategyScore(list: StrategyRecord[], strategy: string): StrategyRecord {
  let rec = list.find((x) => x.strategy === strategy);
  if (!rec) {
    rec = { strategy, confidence: 0.5, sampleCount: 0, lastVerifiedAt: null };
    list.push(rec);
  }
  return rec;
}

function preferredStrategies(
  state: ExtractionState,
  field: FieldName,
  fallback: string[]
): string[] {
  const pattern = ensurePattern(state.registry, state.fingerprint, state.domain);
  const domainPreferred = state.registry.domains[state.domain]?.preferred?.[field] || [];
  const patternPreferred = pattern.fields[field].preferred || [];
  return [...new Set([...domainPreferred, ...patternPreferred, ...fallback])];
}

function markFieldSuccess(state: ExtractionState, field: FieldName, strategy: string): void {
  const now = new Date().toISOString();
  const pattern = ensurePattern(state.registry, state.fingerprint, state.domain);
  const rec = strategyScore(pattern.fields[field].learned, strategy);
  rec.sampleCount += 1;
  rec.confidence = Math.min(1, rec.confidence + 0.08);
  rec.lastVerifiedAt = now;
  pattern.fields[field].preferred = [strategy, ...pattern.fields[field].preferred.filter((s) => s !== strategy)].slice(0, 4);
  pattern.discovery.lastVerifiedAt = now;
  pattern.lastVerifiedAt = now;
  pattern.sampleCount += 1;
  pattern.confidence = Math.min(1, pattern.confidence + 0.03);
  const dom = state.registry.domains[state.domain];
  dom.lastVerifiedAt = now;
  dom.preferred = dom.preferred || {};
  dom.preferred[field] = [strategy, ...(dom.preferred[field] || []).filter((s) => s !== strategy)].slice(0, 4);
}

function markFieldFailure(
  state: ExtractionState,
  field: FieldName | "all",
  reason: string,
  url?: string
): void {
  const now = new Date().toISOString();
  const pattern = ensurePattern(state.registry, state.fingerprint, state.domain);
  pattern.exceptions.push({ at: now, field, reason, domain: state.domain, url });
  pattern.exceptions = pattern.exceptions.slice(-25);
  pattern.confidence = Math.max(0.1, pattern.confidence - (field === "all" ? 0.08 : 0.05));
  if (field !== "all") {
    for (const rec of pattern.fields[field].learned) rec.confidence = Math.max(0.1, rec.confidence - 0.08);
  }
}

/* ------------------------------ small helpers ------------------------------ */

const DEBUG = !!process.env.DEBUG_OWNSITE;
function log(...a: unknown[]) {
  if (DEBUG) console.error("[ownsite]", ...a);
}

/** A static GET with its own timeout. Returns body + final URL (never throws). */
async function staticFetchFull(
  url: string,
  timeoutMs: number
): Promise<{ html: string; finalUrl: string } | null> {
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, "Accept-Language": "nl-BE,nl;q=0.9,en;q=0.8" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    return { html: await r.text(), finalUrl: r.url || url };
  } catch {
    return null;
  }
}

/** Body-only convenience wrapper. */
async function staticFetch(url: string, timeoutMs: number): Promise<string | null> {
  return (await staticFetchFull(url, timeoutMs))?.html ?? null;
}

/** Map over items with bounded concurrency, preserving order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

function bareDomain(website: string | null | undefined): string | null {
  if (!website) return null;
  const d = website
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .split(/[/?#]/)[0]
    .trim()
    .toLowerCase();
  return /\.[a-z]{2,}$/.test(d) ? d : null;
}

export function normTownSlug(t?: string | null): string | null {
  if (!t) return null;
  const s = t
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return s || null;
}

/**
 * True when a URL's path carries the town as a whole SEGMENT or hyphen-bounded
 * TOKEN (not a loose substring). Token-aware so "aalst" matches /te-koop/aalst/
 * and a "...-nabij-aalst" slug, but NOT the accidental run inside "ideaal-starters".
 * Handles multi-word towns (sint-niklaas) via per-token containment.
 */
function townInUrl(url: string, town: string | null | undefined): boolean {
  const townNorm = normTownSlug(town);
  if (!townNorm) return false;
  const townTokens = (town as string)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    /* keep raw */
  }
  const segs = path.toLowerCase().split("/").filter(Boolean);
  for (const seg of segs) {
    if (seg.replace(/[^a-z0-9]/g, "") === townNorm) return true; // exact segment
    const segTokens = seg.split(/[^a-z0-9]+/).filter(Boolean);
    if (townTokens.length && townTokens.every((t) => segTokens.includes(t))) return true;
  }
  return false;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&euro;|&#8364;|&#x20ac;/gi, "€")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"');
}

function detectFingerprint(args: {
  domain: string;
  rootHtml: string | null;
  sitemapXml: string | null;
  sampleUrls: string[];
}): Fingerprint {
  const { domain, rootHtml, sitemapXml, sampleUrls } = args;
  const hay = [domain, rootHtml || "", sitemapXml || "", sampleUrls.slice(0, 30).join("\n")].join("\n").toLowerCase();
  const signals: string[] = [];
  const push = (s: string, ok: boolean) => {
    if (ok) signals.push(s);
  };

  push("zabun host", /zabun\.be|skarabee/i.test(hay));
  if (signals.length) return { key: "zabun-skarabee", label: "Zabun/Skarabee", signals };

  push("whise host", /storagewhise\.eu|whise\.eu/i.test(hay));
  push("whise aanbod path", /\/aanbod\/\d{4,}/i.test(hay));
  if (signals.length) return { key: "whise", label: "Whise", signals };

  push("era domain", /(?:^|\.)era\.be/i.test(domain));
  push("drupal generator", /generator[^>]+drupal/i.test(rootHtml || ""));
  push("era idless sale path", /\/te-koop\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]{12,}/i.test(hay));
  if (signals.length) return { key: "era-drupal", label: "Era/Drupal", signals };

  push("numeric detail path", sampleUrls.some((u) => /\/\d{4,}(?:[/?#]|$)/.test(u)));
  push("rich seo slug", sampleUrls.some((u) => /\/[a-z0-9-]{20,}(?:\/|$)/i.test(u)));
  if (signals.length) return { key: "generic-listing-cms", label: "Generic Listing CMS", signals };

  return { key: "unknown", label: "Unknown", signals: ["no stable signals matched"] };
}

/* ------------------------------ sitemap crawl ------------------------------ */

function locTags(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(decodeEntities(m[1]));
  return out;
}

/**
 * Collect every page URL referenced by a domain's sitemap(s). Handles a sitemap
 * INDEX (its <loc>s are child sitemaps) by recursing one level into the children.
 * Bounded: at most `maxChildren` child sitemaps are fetched.
 */
async function collectSitemapUrls(
  domain: string,
  timeoutMs: number,
  maxChildren = 25
): Promise<string[]> {
  const roots = [`https://www.${domain}/sitemap.xml`, `https://${domain}/sitemap.xml`];
  let rootXml: string | null = null;
  for (const r of roots) {
    rootXml = await staticFetch(r, timeoutMs);
    if (rootXml) break;
  }
  if (!rootXml) {
    log(`no sitemap.xml for ${domain}`);
    return [];
  }

  const isIndex = /<sitemapindex[\s>]/i.test(rootXml);
  if (!isIndex) return locTags(rootXml);

  // Sitemap index -> fetch child sitemaps (bounded, in parallel) and merge.
  const children = locTags(rootXml).slice(0, maxChildren);
  log(`${domain}: sitemap index with ${children.length} child sitemap(s)`);
  const urls = new Set<string>();
  await mapLimit(children, 6, async (child) => {
    const xml = await staticFetch(child, timeoutMs);
    if (!xml) return;
    // A child may itself be an index (rare); only one extra level, no deep recursion.
    if (/<sitemapindex[\s>]/i.test(xml)) {
      for (const grand of locTags(xml).slice(0, maxChildren)) {
        const gx = await staticFetch(grand, timeoutMs);
        if (gx) for (const u of locTags(gx)) urls.add(u);
      }
    } else {
      for (const u of locTags(xml)) urls.add(u);
    }
  });
  return [...urls];
}

/* --------------------------- URL shape classifier -------------------------- */

const SALE_KW = /(?:te-koop|te_koop|tekoop|for-sale|a-vendre)/i;
const RENT_KW = /(?:te-huur|te_huur|tehuur|verhuurd|a-louer|for-rent)/i;
const SOLD_KW = /(?:verkocht|verkochte|sold|geannuleerd)/i;
// A path segment that is a for-sale ROUTING token used by Belgian agency CRMs.
const KW_SEG =
  /^(?:te-koop|te_koop|tekoop|aanbod|woning|woningen|panden|eigendommen|properties|property|detail|pand|huis|appartement|villa|object|zoekertje|realisatie|projecten?)$/i;

/** A path segment that reads like a property description (multi-word slug). */
function isRichSlug(seg: string): boolean {
  return (seg.match(/-/g) || []).length >= 3 || seg.length >= 25;
}

function pathSegs(url: string): string[] {
  try {
    return new URL(url).pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  } catch {
    return [];
  }
}

/** A URL that looks like a single LISTING/detail page on the agency's own CRM. */
function looksLikeListing(url: string): boolean {
  const hasKeyword =
    /\/(?:detail|te-koop|te_koop|tekoop|woning|woningen|aanbod|eigendom|eigendommen|pand|panden|property|properties|zoekertje|object|immo|huis|appartement|villa|listing|estate|realisatie|projecten?)\b/i.test(
      url
    );
  if (!hasKeyword) return false;
  // (a) explicit numeric id in the path or query (Zabun/Skarabee, Whise, ...).
  if (/\/(\d{4,})(?:[/?#.]|$)/.test(url) || /[?&](?:id|ref|reference|propertyid)=\d{3,}/i.test(url)) return true;
  // (b) idless CRM (Era/Drupal): /te-koop/<town>/<type>/<rich-description-slug>.
  const segs = pathSegs(url);
  if (segs.length < 4) return false;
  const kwIdx = segs.findIndex((s) => KW_SEG.test(s));
  const last = segs[segs.length - 1] || "";
  return kwIdx >= 0 && kwIdx < segs.length - 2 && isRichSlug(last);
}

/** A URL that looks like a for-sale INDEX/overview page (one hop above details). */
function looksLikeIndex(url: string): boolean {
  const segs = pathSegs(url);
  if (!segs.length) return false;
  if (/\d{4,}/.test(segs.join("/"))) return false; // detail pages carry ids
  const kwIdx = segs.findIndex((s) =>
    /^(?:te-koop|te_koop|tekoop|aanbod(?:-te-koop)?|koopwoningen|te-koop-aanbod|ons-aanbod|properties|eigendommen|panden|for-sale)$/i.test(
      s
    )
  );
  if (kwIdx < 0) return false;
  // Index = for-sale root + only short town/type filters (no rich detail slug).
  return segs.slice(kwIdx + 1).every((s) => !isRichSlug(s));
}

function isRental(url: string): boolean {
  return RENT_KW.test(url) && !SALE_KW.test(url);
}
function isSold(url: string): boolean {
  return SOLD_KW.test(url);
}

function cleanUrl(u: string): string {
  const normed = u.replace(/^http:\/\//i, "https://");
  const hashless = normed.split("#")[0];
  // id-in-path URLs: drop tracking query + trailing slash.
  if (/\/\d{4,}(?:[/?]|$)/.test(hashless)) return hashless.replace(/\?.*$/, "").replace(/\/+$/, "");
  return hashless.replace(/\/+$/, "");
}

/** Harvest on-site detail URLs from an INDEX page's HTML (anchors + embedded JSON). */
function harvestDetailUrls(html: string, domain: string): string[] {
  const decoded = decodeEntities(html);
  const esc = domain.replace(/\./g, "\\.");
  const found = new Set<string>();
  // absolute on-host URLs anywhere in the markup
  for (const m of decoded.matchAll(new RegExp(`https?://(?:www\\.)?${esc}/[^"'\\s)<>\\\\]+`, "gi"))) found.add(m[0]);
  // root-relative hrefs/links
  for (const m of decoded.matchAll(/(?:href|url|content)["']?\s*[:=]\s*["'](\/[^"'\s)<>\\]+)["']/gi))
    found.add(`https://www.${domain}${m[1]}`);
  const out = new Set<string>();
  for (const raw of found) if (looksLikeListing(raw) && !isRental(raw)) out.add(cleanUrl(raw));
  return [...out];
}

/* ----------------------------- field extraction ---------------------------- */

const IMG_EXCLUDE =
  /logo|sprite|icon|favicon|placeholder|avatar|brand|badge|flag|pixel|blank|loader|spinner|\bepc\b|epc\/|theme|assets\/|\/static\/|gstatic|googleusercontent|maps\.google|facebook|fbcdn|instagram|youtube|youtu\.be/i;

// Agency CRM photo hosts (Zabun/Skarabee FileStore is extension-less) + generic.
const ZABUN_FILESTORE = /https?:\/\/[a-z0-9.-]*zabun\.be\/[^"'\s)<>]*FileStore\.ashx\?[^"'\s)<>]+/gi;
const PHOTO_HOST =
  /https?:\/\/[^"'\s)<>]*(?:zabun\.be|storagewhise\.eu|whise\.eu|immo-connect\.be|cloudfront\.net|cloudinary|akamai)\/[^"'\s)<>]+/gi;
const PHOTO_EXT = /https?:\/\/[^"'\s)<>]+?\.(?:jpe?g|webp)(?:\?[^"'\s)<>]*)?/gi;

/** Harvest + dedupe listing photos from decoded HTML (regex over source). */
function harvestImages(decoded: string): string[] {
  const out: string[] = [];
  // Zabun/Skarabee: dedupe by reference= (filename is always FileStore.ashx).
  const refSeen = new Set<string>();
  for (const m of decoded.matchAll(ZABUN_FILESTORE)) {
    const url = m[0];
    const ref = /[?&]reference=([0-9a-f]+)/i.exec(url)?.[1];
    if (!ref || refSeen.has(ref)) continue;
    refSeen.add(ref);
    const host = url.match(/^https?:\/\/[^/]+/)![0];
    out.push(`${host}/Public/FileStore.ashx?noError=true&reference=${ref}&width=1600`);
  }
  // Known CDNs + generic jpg/webp; dedupe by filename.
  const fileSeen = new Set<string>();
  for (const re of [PHOTO_HOST, PHOTO_EXT]) {
    for (const m of decoded.matchAll(re)) {
      const url = m[0];
      if (IMG_EXCLUDE.test(url)) continue;
      if (/FileStore\.ashx/i.test(url)) continue; // handled above
      const file = (url.split("/").pop() || "").split("?")[0].toLowerCase();
      if (!file || fileSeen.has(file)) continue;
      fileSeen.add(file);
      out.push(url);
    }
  }
  return out;
}

function parseJsonLd(html: string): any[] {
  const out: any[] = [];
  const blocks = html.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const b of blocks) {
    const raw = b.replace(/^[\s\S]*?>/, "").replace(/<\/script>\s*$/i, "");
    try {
      out.push(JSON.parse(raw));
    } catch {
      /* ignore malformed */
    }
  }
  return out;
}

const META_RE = (p: string) =>
  new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]+content=["']([^"']*)["']`, "i");
function meta(html: string, p: string): string | null {
  return html.match(META_RE(p))?.[1] ?? null;
}

const AGENT_TYPES = /RealEstateAgent|Organization|LocalBusiness|Corporation|Person/i;
const LISTING_TYPES = /RealEstateListing|Residence|SingleFamilyResidence|House|Apartment|Place|Offer|Product|Accommodation/i;

/** Walk JSON-LD; collect {address,price} preferring the LISTING node, never the agency office. */
function ldFields(ld: any[]): { address: string | null; price: number | null } {
  let listingAddr: string | null = null;
  let anyAddr: string | null = null;
  let price: number | null = null;

  const fmtAddr = (a: any): string | null => {
    if (!a) return null;
    if (typeof a === "string") return a.trim() || null;
    // Some CRMs emit a malformed addressLocality ("48 Heiveld" = reversed street);
    // drop a locality that starts with a digit so we don't echo the street twice.
    const locality = /^\s*\d/.test(String(a.addressLocality || "")) ? null : a.addressLocality;
    const parts = [a.streetAddress, a.postalCode, locality].filter(Boolean);
    return parts.length ? parts.join(", ") : null;
  };
  const visit = (node: any, parentType: string) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((n) => visit(n, parentType));
      return;
    }
    const t = String(node["@type"] || parentType || "");
    if (node.address) {
      const a = fmtAddr(node.address);
      if (a) {
        anyAddr = anyAddr || a;
        if (LISTING_TYPES.test(t) && !AGENT_TYPES.test(t)) listingAddr = listingAddr || a;
      }
    }
    // price: offers.price or direct price (ignore tiny values = m²/KI).
    const rawPrice = node.price ?? node.offers?.price ?? node.offers?.lowPrice;
    if (rawPrice != null && price == null) {
      const n = Number(String(rawPrice).replace(/[^\d.]/g, ""));
      if (Number.isFinite(n) && n >= 10_000 && n <= 25_000_000) price = Math.round(n);
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === "address") continue;
      if (v && typeof v === "object") visit(v, t);
    }
  };
  for (const root of ld) visit(root, "");
  return { address: listingAddr || anyAddr, price };
}

function formatEuro(n: number): string {
  return "€ " + n.toLocaleString("de-DE"); // dot thousands: 449000 -> 449.000
}

const STREET =
  /([A-ZÉÈ][a-zà-ÿA-Zéëèïêç'.\- ]*?(?:straat|laan|steenweg|stwg|weg|baan|dreef|kaai|markt|plein|plaats|wijk|hof|pad|kouter|veld|berg|dijk|lei|ring|park|gracht|vest|kade|rij|dam|brug|wegel|heide|akker)\s*\d+\s*[a-zA-Z]?)\s*,?\s*(\d{4})\s+([A-Z][a-zà-ÿ\-\s]+?)\b/;

/**
 * Generic price. JSON-LD first; else the largest PLAUSIBLE euro amount in the
 * page (a real property price is 5-8 digits). The magnitude guard kills the
 * bogus tiny matches (price-per-m², cadastral income) that produced junk like
 * "€1008" with the old naive `/€\s?[\d.]{4,}/` regex.
 */
function parsePrice(html: string, ldPrice: number | null): string | null {
  if (ldPrice != null) return formatEuro(ldPrice);
  const decoded = decodeEntities(html);
  let best: number | null = null;
  for (const m of decoded.matchAll(/€\s?([0-9][0-9.\s]{3,}[0-9])/g)) {
    const n = Number(m[1].replace(/[^\d]/g, ""));
    if (n >= 10_000 && n <= 25_000_000 && (best == null || n > best)) best = n;
  }
  return best != null ? formatEuro(best) : null;
}

/** Generic address: JSON-LD listing address -> og/title/text STREET match -> URL slug town. */
function parseAddress(html: string, ldAddr: string | null, url: string): string | null {
  // A JSON-LD listing address that already carries a street+number wins.
  if (ldAddr && /\d/.test(ldAddr) && /[a-z]{3,}/i.test(ldAddr)) return ldAddr.replace(/\s+/g, " ").trim();

  const hay = decodeEntities(
    [meta(html, "og:title"), meta(html, "twitter:title"), meta(html, "og:image:alt"),
     html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "",
     html.match(/<title>([^<]*)<\/title>/i)?.[1] || "",
     html.replace(/<[^>]+>/g, " ")].filter(Boolean).join("  ||  ")
  );
  const m = STREET.exec(hay);
  if (m) return `${m[1].replace(/\s+/g, " ").trim()}, ${m[2]} ${m[3].trim()}`;

  // Fall back to JSON-LD address even without a number, then to the URL slug.
  if (ldAddr) return ldAddr.replace(/\s+/g, " ").trim();
  // URL slug "...in-<zip>-<town>" or "...-<town>/<id>".
  const slug = (() => {
    try { return new URL(url).pathname; } catch { return url; }
  })();
  const zipTown = /in-(\d{4})-([a-z][a-z-]+)/i.exec(slug);
  if (zipTown) return `${zipTown[1]} ${zipTown[2].replace(/-/g, " ").trim()}`;
  const t = /\bin\s+([A-ZÉÈ][a-zà-ÿ\-]+(?:\s[A-ZÉÈ][a-zà-ÿ\-]+)?)\b/.exec(hay);
  return t ? t[1].trim() : null;
}

function townFromUrl(url: string): string | null {
  const slug = (() => {
    try { return new URL(url).pathname; } catch { return url; }
  })();
  const zipTown = /in-\d{4}-([a-z][a-z-]+)/i.exec(slug);
  if (zipTown) return zipTown[1].replace(/-/g, " ");
  const koopTown = /te-koop[a-z-]*-([a-z-]+?)\/\d/i.exec(slug) || /\/te-koop\/([a-z-]+?)(?:\/|$)/i.exec(slug);
  return koopTown ? koopTown[1].replace(/-/g, " ") : null;
}

function extractAddressByStrategy(html: string, url: string, strategy: string): string | null {
  const ld = parseJsonLd(html);
  const { address: ldAddr } = ldFields(ld);
  switch (strategy) {
    case "jsonld-address":
      return ldAddr && /\d/.test(ldAddr) ? ldAddr.replace(/\s+/g, " ").trim() : null;
    case "title-street":
      return parseAddress(html, null, url);
    case "any-address":
      return parseAddress(html, ldAddr, url);
    default:
      return null;
  }
}

function extractPriceByStrategy(html: string, strategy: string): string | null {
  const ld = parseJsonLd(html);
  const { price: ldPrice } = ldFields(ld);
  switch (strategy) {
    case "jsonld-offer-price":
      return ldPrice != null ? formatEuro(ldPrice) : null;
    case "largest-euro-text":
      return parsePrice(html, null);
    case "best-price":
      return parsePrice(html, ldPrice);
    default:
      return null;
  }
}

function extractImagesByStrategy(html: string, strategy: string): { facade: string | null; gallery: string[] } | null {
  const decoded = decodeEntities(html);
  const og = meta(html, "og:image");
  const ogClean = og ? decodeEntities(og) : null;
  const gallery = harvestImages(decoded);
  switch (strategy) {
    case "gallery-regex":
      if (!gallery.length) return null;
      return {
        facade: ogClean && !IMG_EXCLUDE.test(ogClean) ? ogClean : gallery[0] ?? null,
        gallery: ogClean && !gallery.includes(ogClean) ? [ogClean, ...gallery] : gallery,
      };
    case "og-image":
      if (!ogClean || IMG_EXCLUDE.test(ogClean)) return null;
      return { facade: ogClean, gallery: [ogClean] };
    case "best-images":
      if (!gallery.length && !ogClean) return null;
      return {
        facade: ogClean && !IMG_EXCLUDE.test(ogClean) ? ogClean : gallery[0] ?? null,
        gallery: ogClean && !gallery.includes(ogClean) ? [ogClean, ...gallery] : gallery,
      };
    default:
      return null;
  }
}

function selectAddress(html: string, url: string, state: ExtractionState): StrategyResult<string> {
  for (const strategy of preferredStrategies(state, "address", ["jsonld-address", "title-street", "any-address"])) {
    const value = extractAddressByStrategy(html, url, strategy);
    if (value) return { value, strategy };
  }
  return { value: null, strategy: null };
}

function selectPrice(html: string, state: ExtractionState): StrategyResult<string> {
  for (const strategy of preferredStrategies(state, "price", ["jsonld-offer-price", "largest-euro-text", "best-price"])) {
    const value = extractPriceByStrategy(html, strategy);
    if (value) return { value, strategy };
  }
  return { value: null, strategy: null };
}

function selectImages(html: string, state: ExtractionState): StrategyResult<{ facade: string | null; gallery: string[] }> {
  for (const strategy of preferredStrategies(state, "images", ["gallery-regex", "og-image", "best-images"])) {
    const value = extractImagesByStrategy(html, strategy);
    if (!value || (!value.gallery.length && !value.facade)) continue;
    if (strategy === "og-image" && value.gallery.length < 2) continue;
    return { value, strategy };
  }
  return { value: null, strategy: null };
}

/* ------------------------------ page fetching ------------------------------ */

const DETACHED = /detached\s*frame|frame.*detached|execution context|target closed|session closed/i;

/**
 * Fetch a detail page's HTML, STATIC-first. If the static HTML lacks listing
 * photos and a browser fallback is allowed, render once via Browserless. The
 * "detached Frame" puppeteer error (seen on era.be) is caught: we retry the
 * render once, and if it still fails we keep the static HTML rather than aborting.
 */
async function fetchDetailHtml(
  url: string,
  cfg: Required<OwnSiteOpts>,
  state: { browserDead: boolean }
): Promise<{ html: string; usedBrowser: boolean; finalUrl: string } | null> {
  const got = await staticFetchFull(url, cfg.fetchTimeoutMs);
  const staticHtml = got?.html ?? null;
  const finalUrl = got?.finalUrl ?? url;
  const enough = (h: string | null) =>
    !!h && (harvestImages(decodeEntities(h)).length > 0 || !!meta(h, "og:image"));
  if (enough(staticHtml)) return { html: staticHtml!, usedBrowser: false, finalUrl };
  // Browser fallback is only for genuine JS-only pages, and only while Browserless
  // is responsive. Once a render fails (e.g. Browserless unreachable) we latch it
  // off for the rest of the run so one dead backend can't multiply across pages.
  if (!cfg.allowBrowserFallback || state.browserDead)
    return staticHtml ? { html: staticHtml, usedBrowser: false, finalUrl } : null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { html } = await renderPage(url, {
        settle: 2500,
        retries: 1,
        timeout: cfg.browserTimeoutMs,
        scroll: 5,
      });
      return { html, usedBrowser: true, finalUrl };
    } catch (e) {
      const msg = (e as Error)?.message || "";
      log(`render fail (${attempt}) ${url}: ${msg}`);
      if (attempt === 1 && DETACHED.test(msg)) continue; // detached frame -> retry once
      // A connection/launch failure means Browserless is down: stop trying it.
      if (/connect|ECONN|ENOTFOUND|ws|websocket|socket hang|timeout/i.test(msg)) state.browserDead = true;
      break;
    }
  }
  // Browser failed -> the static HTML is the floor (never fatal).
  return staticHtml ? { html: staticHtml, usedBrowser: false, finalUrl } : null;
}

/** Extract one detail page into a Candidate. */
async function scrapeDetail(
  url: string,
  cfg: Required<OwnSiteOpts>,
  state: { browserDead: boolean },
  extraction: ExtractionState
): Promise<OwnSiteCandidate | null> {
  const got = await fetchDetailHtml(url, cfg, state);
  if (!got) return null;
  const { html, finalUrl } = got;
  // Dead/sold listings often 301-redirect to a category INDEX (Era:
  // /nl/te-koop/aalst/huis/<slug> -> /nl/te-koop/aalst/huis). Scraping that index
  // would mint a Frankenstein candidate from the first recommended card. If the
  // post-redirect URL no longer looks like a detail page, drop it.
  if (finalUrl !== url && !looksLikeListing(finalUrl)) {
    log(`drop dead-redirect ${url} -> ${finalUrl}`);
    return null;
  }
  const address = selectAddress(html, url, extraction);
  const price = selectPrice(html, extraction);
  const images = selectImages(html, extraction);

  if (address.strategy && address.value) markFieldSuccess(extraction, "address", address.strategy);
  else markFieldFailure(extraction, "address", "address shortfall", url);
  if (price.strategy && price.value) markFieldSuccess(extraction, "price", price.strategy);
  else markFieldFailure(extraction, "price", "price shortfall", url);
  if (images.strategy && images.value) markFieldSuccess(extraction, "images", images.strategy);
  else markFieldFailure(extraction, "images", "images shortfall", url);

  const facade = images.value?.facade ?? null;
  const gallery = images.value?.gallery ?? [];

  return {
    listingUrl: url,
    source: "agency",
    address: address.value,
    price: price.value,
    facadeImageUrl: facade,
    allImageUrls: gallery.slice(0, 14),
    town: townFromUrl(url),
  };
}

async function verifyCachedPattern(
  url: string,
  cfg: Required<OwnSiteOpts>,
  browserState: { browserDead: boolean },
  extraction: ExtractionState
): Promise<void> {
  const got = await fetchDetailHtml(url, cfg, browserState);
  if (!got) {
    markFieldFailure(extraction, "all", "verification fetch failed", url);
    return;
  }
  const addrFirst = preferredStrategies(extraction, "address", ["jsonld-address", "title-street", "any-address"])[0];
  const priceFirst = preferredStrategies(extraction, "price", ["jsonld-offer-price", "largest-euro-text", "best-price"])[0];
  const imgFirst = preferredStrategies(extraction, "images", ["gallery-regex", "og-image", "best-images"])[0];
  const addrProbe = addrFirst ? extractAddressByStrategy(got.html, url, addrFirst) : null;
  const priceProbe = priceFirst ? extractPriceByStrategy(got.html, priceFirst) : null;
  const imgProbe = imgFirst ? extractImagesByStrategy(got.html, imgFirst) : null;
  if (addrFirst && !addrProbe) markFieldFailure(extraction, "address", `cached strategy drift: ${addrFirst}`, url);
  if (priceFirst && !priceProbe) markFieldFailure(extraction, "price", `cached strategy drift: ${priceFirst}`, url);
  if (imgFirst && (!imgProbe || imgProbe.gallery.length < 2)) {
    markFieldFailure(extraction, "images", `cached strategy drift: ${imgFirst}`, url);
  }

  const address = selectAddress(got.html, url, extraction);
  const price = selectPrice(got.html, extraction);
  const images = selectImages(got.html, extraction);
  const missing: string[] = [];
  if (!(address.value && address.strategy)) missing.push("address");
  if (!(price.value && price.strategy)) missing.push("price");
  if (!(images.value && images.strategy && images.value.gallery.length)) missing.push("images");
  if (missing.length) {
    markFieldFailure(extraction, "all", `verification drift: ${missing.join(",")}`, url);
    return;
  }
  markFieldSuccess(extraction, "address", address.strategy!);
  markFieldSuccess(extraction, "price", price.strategy!);
  markFieldSuccess(extraction, "images", images.strategy!);
}

/* --------------------------------- driver ---------------------------------- */

export interface OwnSiteQuery {
  website?: string | null;
  domain?: string | null;
  town?: string | null;
}

/**
 * Discover an agency's own-site for-sale candidates. Static-first, generic,
 * time-boxed. Returns [] when no domain is known or no sitemap is reachable.
 */
export async function discoverOwnSite(q: OwnSiteQuery, opts: OwnSiteOpts = {}): Promise<OwnSiteCandidate[]> {
  const cfg = resolved(opts);
  const domain = q.domain || bareDomain(q.website);
  if (!domain) {
    log("no domain to discover");
    return [];
  }
  const townNorm = normTownSlug(q.town);
  const started = Date.now();
  const overBudget = () => cfg.budgetMs > 0 && Date.now() - started > cfg.budgetMs;
  const registry = await loadRegistry();

  const rootHtml =
    (await staticFetch(`https://www.${domain}`, cfg.fetchTimeoutMs)) ||
    (await staticFetch(`https://${domain}`, cfg.fetchTimeoutMs));
  const sitemapXml =
    (await staticFetch(`https://www.${domain}/sitemap.xml`, cfg.fetchTimeoutMs)) ||
    (await staticFetch(`https://${domain}/sitemap.xml`, cfg.fetchTimeoutMs));

  // 1. Sitemap(s) -> every page URL.
  const allUrls = sitemapXml ? await collectSitemapUrls(domain, cfg.fetchTimeoutMs) : [];
  log(`${domain}: ${allUrls.length} sitemap urls`);
  const fingerprint = detectFingerprint({ domain, rootHtml, sitemapXml, sampleUrls: allUrls });
  const extraction: ExtractionState = { registry, fingerprint, domain };
  ensurePattern(registry, fingerprint, domain);

  // 2. Split into for-sale detail vs for-sale index pages (skip rentals).
  const detail = allUrls.filter((u) => looksLikeListing(u) && !isRental(u)).map(cleanUrl);
  const index = allUrls.filter((u) => looksLikeIndex(u) && !isRental(u));
  const dedupe = (xs: string[]) => [...new Set(xs)];
  const allDetail = dedupe(detail);
  log(`${domain}: ${allDetail.length} detail urls, ${index.length} index urls in sitemap`);

  // 3. Town narrowing.
  let detailUrls: string[] = [];
  if (townNorm) {
    detailUrls = allDetail.filter((u) => townInUrl(u, q.town));
    // Idless CRMs (Era): no detail URLs in the sitemap; expand the town INDEX page.
    const townIndexes = index.filter((u) => townInUrl(u, q.town)).slice(0, 4);
    for (const ix of townIndexes) {
      if (overBudget()) break;
      const html = await staticFetch(ix, cfg.fetchTimeoutMs);
      if (!html) continue;
      // A town index lists its in-town properties plus a few cross-town
      // "recommended" cards. Keep the in-town ones (town as a path token, which
      // also covers deelgemeenten whose slug says "...-<town>"), so a Berchem
      // recommendation does not leak into an Aalst result.
      const harvested = harvestDetailUrls(html, domain);
      const inTown = harvested.filter((u) => townInUrl(u, q.town));
      detailUrls.push(...(inTown.length ? inTown : harvested));
    }
    detailUrls = dedupe(detailUrls);
    log(`${domain}: ${detailUrls.length} in-town candidate urls`);
  }

  // 4. Town not covered (or no town) -> full for-sale set, so we still surface
  //    candidates to confirm rather than returning nothing.
  if (!detailUrls.length) {
    detailUrls = [...allDetail];
    if (!detailUrls.length) {
      // Last resort: expand a few generic for-sale index pages.
      for (const ix of index.slice(0, 3)) {
        if (overBudget()) break;
        const html = await staticFetch(ix, cfg.fetchTimeoutMs);
        if (html) detailUrls.push(...harvestDetailUrls(html, domain));
      }
      detailUrls = dedupe(detailUrls);
    }
    log(`${domain}: town '${q.town}' not covered -> ${detailUrls.length} fallback urls`);
  }

  // Prefer non-sold, then cap. (Sold stubs kept only to top up a thin set.)
  const live = detailUrls.filter((u) => !isSold(u));
  const ordered = (live.length ? live : detailUrls).slice(0, cfg.maxCandidates);

  // 5. Scrape each detail (bounded concurrency, per-fetch timeout, no global wall).
  const state = { browserDead: false };
  if (ordered.length) await verifyCachedPattern(ordered[0], cfg, state, extraction);
  const scraped = await mapLimit(ordered, cfg.concurrency, async (u) => {
    if (overBudget()) return null;
    try {
      return await scrapeDetail(u, cfg, state, extraction);
    } catch (e) {
      log(`scrape error ${u}: ${(e as Error)?.message}`);
      markFieldFailure(extraction, "all", `scrape error: ${(e as Error)?.message || "unknown"}`, u);
      return null;
    }
  });

  // Dedupe: some CRMs (Era) expose ONE property under several category URLs
  // (/handelspand/, /opbrengsteigendom/, /kantoor/ ...). Collapse by address.
  const seenAddr = new Set<string>();
  const out: OwnSiteCandidate[] = [];
  for (const c of scraped) {
    if (!c) continue;
    const key = c.address ? c.address.toLowerCase().replace(/[^a-z0-9]/g, "") : "";
    if (key && seenAddr.has(key)) continue;
    if (key) seenAddr.add(key);
    out.push(c);
  }
  await saveRegistry(registry);
  return out;
}
