import { renderPage, closeBrowser } from "./lib/browser.js";
async function main(){
  // get the immo-connect image uuids from the Schuurkouter spotto page
  const d = await renderPage("https://www.spotto.be/nl/p/te-koop/9200-dendermonde/huis-schuurkouter-31-met-3-kamers-tuin-terras/2eSh3EDUGEmJ4gjeWsbYcg",{settle:4000,retries:3,timeout:50000,scroll:5});
  const uuids=Array.from(new Set((d.html.match(/file\.immo-connect\.be\/image\/([a-f0-9-]{36})/gi)||[]).map(s=>s.split("/image/")[1])));
  console.log("immo-connect uuids:",uuids.length, uuids.slice(0,8));
  const imgUrl = uuids[0] ? `https://file.immo-connect.be/image/${uuids[0]}?width=800&fileformat=jpeg` : null;
  console.log("test img:", imgUrl);
  if(imgUrl){
    const r = await fetch(imgUrl);
    const buf = Buffer.from(await r.arrayBuffer());
    console.log("direct fetch status", r.status, "bytes", buf.length, "ctype", r.headers.get("content-type"));
  }
  // also test immowebstatic fetch
  const iw = await fetch("https://media-resize.immowebstatic.be/classifieds/9b821908-de2e-418a-9662-21a63fa088b4/736x736/ae138d75b8a3705e83a75e96ddf83180.jpg");
  console.log("immowebstatic fetch status", iw.status, "bytes",(await iw.arrayBuffer()).byteLength);
  await closeBrowser();
}
main().catch(e=>{console.error("ERR",e.message);process.exit(1);});
