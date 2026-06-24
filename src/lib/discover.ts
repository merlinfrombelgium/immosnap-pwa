import { ENV } from "./env.js";

export interface SerpResult { link: string; title: string }

/** Run a Google search via SerpApi. Returns organic results (link+title). */
export async function serp(query: string, num = 10): Promise<SerpResult[]> {
  const key = ENV.SERPAPI_KEY;
  if (!key) throw new Error("SERPAPI_KEY missing");
  const url =
    `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}` +
    `&num=${num}&gl=be&hl=nl&google_domain=google.be&api_key=${key}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`SerpApi HTTP ${res.status}`);
  const data: any = await res.json();
  if (data.error) throw new Error(`SerpApi: ${data.error}`);
  return (data.organic_results || []).map((r: any) => ({ link: r.link, title: r.title || "" }));
}

export interface Discovery {
  immowebAgencyUrls: string[]; // /agentschap/<slug>/<id> and /groep/<...>
  spottoMakelaarUrls: string[];
  spottoListingUrls: string[];
  agencyListingUrls: string[]; // direct listing pages on portals or agency sites
  agencySite: string | null;
  raw: SerpResult[];
}

const cls = (u: string) => { try { return new URL(u).host.replace(/^www\./, ""); } catch { return ""; } };

/** Discover candidate sources for an agency using a few targeted SerpApi queries. */
export async function discover(agency: string, phone: string | null, town: string | null): Promise<Discovery> {
  const queries = [
    `${agency} immoweb`,
    `${agency} spotto`,
    `${agency} te koop${town ? " " + town : ""}`,
  ];
  if (phone) queries.push(`${phone.replace(/\s+/g, " ")} immo te koop`);

  const all: SerpResult[] = [];
  for (const q of queries) {
    try { all.push(...(await serp(q, 10))); } catch (e) { /* continue */ }
  }

  const d: Discovery = {
    immowebAgencyUrls: [], spottoMakelaarUrls: [], spottoListingUrls: [],
    agencyListingUrls: [], agencySite: null, raw: all,
  };
  const seen = new Set<string>();
  for (const { link } of all) {
    if (!link || seen.has(link)) continue;
    seen.add(link);
    const host = cls(link);
    if (host === "immoweb.be") {
      if (/\/agentschap\/[a-z0-9-]+\/\d+/.test(link) || /\/groep\//.test(link)) push(d.immowebAgencyUrls, clean(link));
      else if (/\/zoekertje\/[^/]+\/[^/]+\/[^/]+\/\d{4}\/\d{6,}/.test(link)) push(d.agencyListingUrls, clean(link));
    } else if (host === "spotto.be") {
      if (/\/makelaar\//.test(link)) push(d.spottoMakelaarUrls, clean(link));
      else if (/\/nl\/p\//.test(link)) push(d.spottoListingUrls, clean(link));
    } else if (/facebook|instagram|tiktok|youtube|linkedin|google\./.test(host)) {
      // skip socials
    } else if (/\/te-koop\/|\/detail\/|\/zoekertje\/|\/woning\/|\/p\//.test(link) && /\d{4,}/.test(link)) {
      push(d.agencyListingUrls, clean(link));
      if (!d.agencySite) d.agencySite = `https://${host}`;
    } else if (!d.agencySite && agencyTokenMatch(host, agency)) {
      d.agencySite = `https://${host}`;
    }
  }
  return d;
}

function push(arr: string[], v: string) { if (!arr.includes(v)) arr.push(v); }
function clean(u: string) { return u.split("#")[0].replace(/\?.*$/, "").replace(/\/$/, ""); }
function agencyTokenMatch(host: string, agency: string): boolean {
  const tok = agency.toLowerCase().replace(/[^a-z0-9]/g, "");
  return tok.length > 3 && host.replace(/[^a-z0-9]/g, "").includes(tok.slice(0, Math.min(tok.length, 8)));
}

/** Given one immoweb office URL, enumerate sibling offices from the group page (best-effort). */
export function immowebOfficeSiblings(html: string): string[] {
  return Array.from(new Set((html.match(/\/nl\/agentschap\/[a-z0-9-]+\/\d+/gi) || []))).map(
    (p) => "https://www.immoweb.be" + p
  );
}
