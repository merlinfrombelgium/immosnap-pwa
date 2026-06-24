import { renderPage, closeBrowser } from "./lib/browser.js";
async function main(){
  // makelaar page
  const mk = await renderPage("https://www.spotto.be/nl/makelaar/immo-lot/TCSJASQrO02pifhI28J-4Q",{settle:3500,retries:3,timeout:50000,scroll:6});
  const links=Array.from(new Set((mk.html.match(/\/nl\/p\/[a-z-]+\/[^"'\s]+?\/[A-Za-z0-9_-]{18,}/g)||[]))).slice(0,20);
  console.log("MAKELAAR status",mk.status,"len",mk.html.length,"listing links:",links.length);
  links.forEach(l=>console.log("   https://www.spotto.be"+l));

  // detail page (known sold Schuurkouter)
  const d = await renderPage("https://www.spotto.be/nl/p/te-koop/9200-dendermonde/huis-schuurkouter-31-met-3-kamers-tuin-terras/2eSh3EDUGEmJ4gjeWsbYcg",{settle:3500,retries:3,timeout:50000});
  const og=(p:string)=>d.html.match(new RegExp(`property=["']og:${p}["'][^>]+content=["']([^"']+)`,"i"))?.[1];
  const imgs=Array.from(new Set((d.html.match(/https?:\/\/[^"'\s]*?(?:spotto|cloudfront|realo|amazonaws|googleusercontent)[^"'\s]*?\.(?:jpg|jpeg|webp)/gi)||[]))).slice(0,12);
  console.log("\nDETAIL status",d.status,"len",d.html.length);
  console.log("  og:title",og("title"));
  console.log("  og:image",og("image"));
  console.log("  sold?", /verkocht|verhuurd|sold/i.test(d.html));
  console.log("  price match", d.html.match(/€\s?[\d.]{4,}/)?.[0]);
  console.log("  imgs:",imgs.length); imgs.forEach(i=>console.log("    "+i));
  // also look for json-ld
  const ld=d.html.match(/"streetAddress"\s*:\s*"([^"]+)"[\s\S]{0,120}?"postalCode"\s*:\s*"([^"]+)"[\s\S]{0,120}?"addressLocality"\s*:\s*"([^"]+)"/i);
  console.log("  jsonld addr:", ld? `${ld[1]}, ${ld[2]} ${ld[3]}`:"(none)");
  await closeBrowser();
}
main().catch(e=>{console.error("ERR",e.message);process.exit(1);});
