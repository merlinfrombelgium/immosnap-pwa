#!/usr/bin/env python3
"""
immoSnap prototype: deterministic listing matcher.
Approach (the proposed fix):
  1. Inputs come from the app: agency name (OCR of sign) + address (GPS reverse-geocode).
  2. Build a plain web-search query, hit DuckDuckGo HTML (scrapable, no API key).
  3. Rank candidate URLs: agency's OWN site first, then immoweb/realo/zimmo portals.
  4. Fetch the top agency candidate (open + readable), extract structured data.
  5. Verify: does the listing's address contain the sign/GPS street? -> confidence.
Vision/facade is a downstream TIEBREAKER, not the finder.
"""
import subprocess, re, sys, os, html, urllib.parse, json

BROWSER = os.path.expanduser("~/.config/browser/browser.py")
PORTALS = ["immoweb", "realo", "zimmo", "immovlan"]

def fetch(url, js=False, raw=True, timeout=120):
    cmd = ["python3", BROWSER, "fetch", url]
    if raw: cmd.append("--raw")
    if js:  cmd.append("--js")
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.stdout or ""
    except Exception as e:
        return ""

def ddg(query):
    url = "https://html.duckduckgo.com/html/?q=" + urllib.parse.quote(query)
    h = fetch(url, raw=True)
    out = []
    for href, title in re.findall(r'result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>', h, re.S):
        href = html.unescape(href)
        m = re.search(r'uddg=([^&]+)', href)
        if m: href = urllib.parse.unquote(m.group(1))
        if href.startswith("//"): href = "https:" + href
        title = html.unescape(re.sub(r'<[^>]+>', '', title)).strip()
        if href.startswith("http"): out.append((href, title))
    return out

def agency_token(agency):
    return re.sub(r'[^a-z0-9]', '', agency.lower())

def rank(results, agency):
    tok = agency_token(agency)
    def score(item):
        href = item[0]
        d = urllib.parse.urlparse(href).netloc.lower().replace('.', '')
        if tok and tok in d: return (0, href)            # agency's own domain
        for i, p in enumerate(PORTALS):
            if p in d: return (1 + i, href)              # known portal
        if 'facebook' in d or 'instagram' in d: return (40, href)
        return (20, href)
    return sorted(results, key=score)

def grab_og(h, prop):
    for pat in (r'property="og:%s"\s+content="([^"]*)"' % prop,
                r'content="([^"]*)"\s+property="og:%s"' % prop):
        m = re.search(pat, h)
        if m: return html.unescape(m.group(1))
    return None

def extract(url):
    h = fetch(url, raw=True)
    addr = re.search(r'([A-ZÉ][a-zéëèïA-Z]+(?:straat|laan|steenweg|plein|weg|baan|dreef|kaai|markt)\s*\d+[a-zA-Z]?\s*,?\s*\d{4}\s+[A-Za-z]+)', h)
    price = re.search(r'€\s?[\d.]{4,}', h)
    return dict(url=url, title=grab_og(h, 'title'), image=grab_og(h, 'image'),
                description=grab_og(h, 'description'),
                address=addr.group(1).strip() if addr else None,
                price=price.group(0) if price else None)

def is_listing(href):
    p = urllib.parse.urlparse(href).path
    return bool(re.search(r'te-koop.*?/\d{5,}$', p) or re.search(r'/zoekertje/.*?/\d{5,}', p))

def expand_index(href, js=True):
    """Pull child listing URLs from an agency index/town page (JS-rendered grid)."""
    h = fetch(href, raw=True, js=js)
    base = '{0.scheme}://{0.netloc}'.format(urllib.parse.urlparse(href))
    links = set()
    for m in re.findall(r'href="([^"]*te-koop[^"]*?/\d{5,})"', h):
        links.add(m if m.startswith('http') else base + m)
    return list(links)

def agency_domain(ranked, agency):
    tok = agency_token(agency)
    for href, _ in ranked:
        d = urllib.parse.urlparse(href).netloc.lower()
        if tok and tok in d.replace('.', ''):
            return d
    return None

def match(agency, street, town, postcode=None, expect_url=None):
    q = '%s %s %s te koop' % (agency, street, town)
    print("="*70); print("QUERY:", q)
    ranked = rank(ddg(q), agency)
    dom = agency_domain(ranked, agency)
    print("step1 agency domain:", dom)

    # step 2: targeted site: search on the agency's own domain -> exact listing URLs
    site_hits = []
    if dom:
        site_hits = [h for h, _ in ddg('site:%s %s %s' % (dom, street, town))]
        print("step2 site:%s hits: %d" % (dom, len(site_hits)))

    tok = agency_token(agency)
    candidates, seen = [], set()
    for href in site_hits + [h for h, _ in ranked]:
        if is_listing(href) and href not in seen:
            seen.add(href); candidates.append(href)
    candidates.sort(key=lambda u: 0 if (tok and tok in urllib.parse.urlparse(u).netloc.replace('.', '')) else 1)
    print("candidate listing URLs:", len(candidates))

    # Verify-driven selection: first candidate whose address contains the street
    best = None
    for url in candidates[:12]:
        data = extract(url)
        addr = (data.get('address') or '')
        hit = street.lower() in addr.lower()
        print("  %-4s %-55s %s" % ("HIT" if hit else "  -", url[-55:], addr or "(no addr)"))
        if hit and not best:
            best = data
    print()
    if best:
        print("MATCHED:"); print(json.dumps(best, indent=2, ensure_ascii=False))
        if expect_url:
            print("\nEXPECTED-URL MATCH:",
                  "PASS" if expect_url.rstrip('/') in best['url'].rstrip('/') else
                  "DIFFERENT URL but address-verified")
        return best
    print("NO ADDRESS-VERIFIED MATCH")
    return None

if __name__ == "__main__":
    # Fixture A: live listing. Inputs = what OCR(sign)+GPS would produce. We do NOT feed it the answer URL.
    match("Immo Tijl", "Rosstraat", "Baasrode", "9200",
          expect_url="https://www.immotijl.be/huis-te-koop-in-baasrode/7581079")
