import { renderPage, closeBrowser } from "./lib/browser.js";
import { prepImage } from "./lib/gemini.js";
import { scoreCandidate } from "./lib/imageMatch.js";

async function main(){
  // KNOWN TRUTH: photo2 (Immo Lot) == Schuurkouter 31 Dendermonde (sold, on spotto)
  const queryB64 = await prepImage("proto/PXL_20260215_104544364.jpg", 1100);
  const d = await renderPage("https://www.spotto.be/nl/p/te-koop/9200-dendermonde/huis-schuurkouter-31-met-3-kamers-tuin-terras/2eSh3EDUGEmJ4gjeWsbYcg",{settle:3500,retries:3,timeout:50000,scroll:5});
  const uuids=Array.from(new Set((d.html.match(/file\.immo-connect\.be\/image\/([a-f0-9-]{36})/gi)||[]).map(s=>s.split("/image/")[1])));
  const urls = uuids.map(u=>`https://file.immo-connect.be/image/${u}?width=900&fileformat=jpeg`);
  console.log("Schuurkouter images:", urls.length);
  const r = await scoreCandidate(queryB64, urls, 9);
  console.log("MATCH (true pair):", JSON.stringify(r,null,2));

  // NEGATIVE CONTROL: photo2 vs an unrelated Aalst listing
  const neg = await renderPage("https://www.immoweb.be/nl/zoekertje/huis/te-koop/aalst-hofstade/9308/21652970",{settle:3000,retries:2,timeout:50000});
  const negImgs = Array.from(new Set((neg.html.match(/https?:\/\/[^"'\s]*classifieds\/[a-f0-9-]+\/736x736\/[^"'\s]+?\.jpg/gi)||[]))).slice(0,9);
  const rn = await scoreCandidate(queryB64, negImgs, 9);
  console.log("MATCH (negative control):", JSON.stringify(rn,null,2));
  await closeBrowser();
}
main().catch(e=>{console.error("ERR",e.message,e.stack);process.exit(1);});
