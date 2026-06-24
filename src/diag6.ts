import { renderPage, closeBrowser } from "./lib/browser.js";
async function main(){
  // (a) Immo Tijl offices from group page
  const g = await renderPage("https://www.immoweb.be/nl/groep/immotijl/tijl",{settle:4000,retries:2,timeout:50000,scroll:4});
  const offices=Array.from(new Set((g.html.match(/\/nl\/agentschap\/[a-z0-9-]+\/\d+/gi)||[]))).slice(0,20);
  console.log("Immo Tijl offices:",offices.length); offices.forEach(o=>console.log("   https://www.immoweb.be"+o));

  // (b) immolot.be cached sold page facade
  const l = await renderPage("https://immolot.be/te-koop/5944575/huis-in-Dendermonde/",{settle:4000,retries:2,timeout:55000,scroll:5});
  console.log("\nimmolot.be sold page status",l.status,"len",l.html.length);
  const hosts:Record<string,number>={};
  for(const u of (l.html.match(/https?:\/\/[^"'\s)]+?\.(?:jpg|jpeg|webp|png)/gi)||[])){ try{const h=new URL(u).host; if(!/logo|icon|favicon|placeholder/i.test(u)) hosts[h]=(hosts[h]||0)+1;}catch{} }
  console.log("img hosts:",JSON.stringify(hosts));
  const imgs=Array.from(new Set((l.html.match(/https?:\/\/[^"'\s)]+?\.(?:jpg|jpeg|webp)/gi)||[]).filter(u=>!/logo|icon|favicon|sprite/i.test(u)))).slice(0,10);
  imgs.forEach(i=>console.log("   "+i));
  const addr=l.html.match(/Schuurkouter[^<,"]*/i)?.[0];
  console.log("addr mention:",addr, " sold?", /verkocht|sold/i.test(l.html), "price", l.html.match(/€\s?[\d.]{4,}/)?.[0]);
  await closeBrowser();
}
main().catch(e=>{console.error("ERR",e.message);process.exit(1);});
