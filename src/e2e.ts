import puppeteer from "puppeteer-core";
import { resolve } from "node:path";

const CHROME = "/home/claude/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome";
const ORIGIN = "http://localhost:3001";
const IMG = resolve("proto/PXL_20260224_171834897.jpg");
const WANT = "Rosstraat 6";

const scenarios = [
  { name: "at the sign",      geo: { latitude: 51.0373,    longitude: 4.1617    } },
  { name: "down the street",  geo: { latitude: 51.0342766, longitude: 4.1605117 } },
];

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});
let failed = 0;
try {
  const ctx = browser.defaultBrowserContext();
  await ctx.overridePermissions(ORIGIN, ["geolocation"]);
  for (const sc of scenarios) {
    const page = await browser.newPage();
    await page.setGeolocation(sc.geo);
    await page.goto(ORIGIN + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
    const input = await page.$("#file");
    if (!input) throw new Error("no #file input");
    await (input as any).uploadFile(IMG);
    await page.waitForSelector(".card-addr", { timeout: 150000 });
    const top = (await page.$$eval(".card-addr", (els) => els.map((e) => (e.textContent || "").trim())))[0] || "";
    const ok = top.includes(WANT);
    console.log(`[${sc.name}] #1 = ${top}  ${ok ? "PASS" : "FAIL"}`);
    if (!ok) failed++;
    await page.close();
  }
} finally {
  await browser.close();
}
if (failed) { console.error(`E2E FAIL: ${failed}/${scenarios.length} scenarios`); process.exit(1); }
console.log(`E2E PASS: ${scenarios.length}/${scenarios.length} scenarios → ${WANT} #1`);
